"""Persistent authorization and accounting. Import before db.init_db().

Money is expressed as integer micro-units of the account's configured currency.
Unknown usage retains its reservation until an explicit reconciliation.
"""
import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import time
from dataclasses import asdict, dataclass
from datetime import datetime
from urllib.parse import urlsplit

from fastapi import HTTPException, Request
from sqlalchemy import JSON, BigInteger, String, UniqueConstraint, or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Mapped, mapped_column

from superagent.core import db

SESSION_COOKIE = "superagent_session"
SESSION_TTL_SECONDS = 3600
_PROCESS_SESSION_KEY = secrets.token_bytes(32)


class Setting(db.Base):
    __tablename__ = "governance_settings"
    key: Mapped[str] = mapped_column(String(100), primary_key=True)
    value: Mapped[object] = mapped_column(JSON, nullable=True)
    updated_at: Mapped[str] = mapped_column(String(40), default=db.now)


class Identity(db.Base):
    __tablename__ = "governance_identities"
    __table_args__ = (UniqueConstraint("source", "actor_id"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    source: Mapped[str] = mapped_column(String(40))
    actor_id: Mapped[str] = mapped_column(String(255))
    user_id: Mapped[str] = mapped_column(String(200))
    enabled: Mapped[bool] = mapped_column(default=True)


class IdentityGrant(db.Base):
    """Separate grants keep pre-existing identity rows default-denied on upgrade."""
    __tablename__ = "governance_identity_grants"
    identity_id: Mapped[int] = mapped_column(primary_key=True)
    project_ids: Mapped[list] = mapped_column(JSON, default=list)
    permissions: Mapped[list] = mapped_column(JSON, default=list)


class TaskOwner(db.Base):
    __tablename__ = "governance_task_owners"
    task_id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[str] = mapped_column(String(200))


class Audit(db.Base):
    __tablename__ = "governance_audit"
    id: Mapped[int] = mapped_column(primary_key=True)
    actor: Mapped[str] = mapped_column(String(200))
    action: Mapped[str] = mapped_column(String(100))
    resource: Mapped[str] = mapped_column(String(255))
    details: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[str] = mapped_column(String(40), default=db.now)


class BudgetAccount(db.Base):
    __tablename__ = "governance_budget_accounts"
    id: Mapped[str] = mapped_column(String(200), primary_key=True)
    hard_limit_micros: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    spent_micros: Mapped[int] = mapped_column(BigInteger, default=0)
    reserved_micros: Mapped[int] = mapped_column(BigInteger, default=0)
    currency: Mapped[str] = mapped_column(String(20), default="USD")


class BudgetReservation(db.Base):
    __tablename__ = "governance_budget_reservations"
    __table_args__ = (UniqueConstraint("account_id", "request_key"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    account_id: Mapped[str] = mapped_column(String(200), index=True)
    request_key: Mapped[str] = mapped_column(String(255))
    task_id: Mapped[int | None] = mapped_column(nullable=True)
    estimate_micros: Mapped[int] = mapped_column(BigInteger)
    estimate_basis: Mapped[str] = mapped_column(String(500))
    actual_micros: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    usage: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    status: Mapped[str] = mapped_column(String(32), default="reserved")
    created_at: Mapped[str] = mapped_column(String(40), default=db.now)


@dataclass(frozen=True)
class Principal:
    user_id: str
    role: str
    authentication: str = "bearer"

    def to_dict(self):
        return asdict(self)


def _users():
    """An invalid multi-user configuration fails closed, even in local mode."""
    raw = os.getenv("SUPERAGENT_USERS_JSON")
    if raw is None:
        return []
    try:
        users = json.loads(raw)
        if not isinstance(users, list) or not users:
            raise ValueError
        ids, tokens = set(), set()
        for user in users:
            if not isinstance(user, dict):
                raise ValueError
            if user.get("role") not in {"admin", "member", "viewer"}:
                raise ValueError
            if any(not isinstance(user.get(k), str) or not user[k].strip() for k in ("user_id", "token")):
                raise ValueError
            if user["user_id"] in ids or user["token"] in tokens:
                raise ValueError
            ids.add(user["user_id"])
            tokens.add(user["token"])
        return users
    except (ValueError, TypeError):
        raise HTTPException(503, "用户身份配置无效") from None


def _configured_principals():
    users = _users()
    legacy = os.getenv("SUPERAGENT_API_TOKEN", "")
    if legacy:
        if any(user["token"] == legacy and (user["user_id"], user["role"]) != ("admin", "admin") for user in users):
            raise HTTPException(503, "单用户令牌与多用户身份配置冲突")
        users = users + [{"user_id": "admin", "role": "admin", "token": legacy}]
    return users


def authenticate_token(token: str) -> Principal:
    users = _configured_principals()
    for user in users:
        if hmac.compare_digest(token.encode(), user["token"].encode()):
            return Principal(user["user_id"], user["role"])
    raise HTTPException(401, "需要有效的访问凭据")


def check_origin(request: Request):
    """Same-origin browser writes, plus explicitly configured development origins."""
    value = request.headers.get("origin")
    if value is None:
        return  # Native clients do not emit Origin.
    try:
        parsed = urlsplit(value)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password or parsed.path not in {"", "/"} or parsed.query or parsed.fragment:
            raise ValueError
        canonical = (parsed.scheme, parsed.hostname, parsed.port or (443 if parsed.scheme == "https" else 80))
        current = urlsplit(str(request.base_url))
        expected = (current.scheme, current.hostname, current.port or (443 if current.scheme == "https" else 80))
        allowed = {expected}
        for entry in os.getenv("SUPERAGENT_ALLOWED_ORIGINS", "").split(","):
            if entry.strip():
                item = urlsplit(entry.strip())
                if item.scheme not in {"http", "https"} or not item.hostname or item.username or item.password or item.path not in {"", "/"} or item.query or item.fragment:
                    raise ValueError
                allowed.add((item.scheme, item.hostname, item.port or (443 if item.scheme == "https" else 80)))
        if canonical not in allowed:
            raise ValueError
    except ValueError:
        raise HTTPException(403, "请求来源无效") from None


def session_requires_secure(request: Request):
    secure = request.url.scheme == "https"
    if not secure and (request.url.hostname not in {"localhost", "127.0.0.1", "::1", "testserver"} or not request.client or request.client.host not in {"localhost", "127.0.0.1", "::1", "testclient"}):
        raise HTTPException(400, "远程网页登录需要 HTTPS")
    return secure


def _session_key():
    configured = os.getenv("SUPERAGENT_SESSION_SECRET")
    if configured is None:
        return _PROCESS_SESSION_KEY
    if len(configured.encode()) < 32:
        raise HTTPException(503, "会话签名密钥至少需要 32 字节")
    return configured.encode()


def _fingerprint(token):
    return hmac.new(_session_key(), token.encode(), hashlib.sha256).hexdigest()


def issue_session(token):
    principal = authenticate_token(token)
    claims = {"sub": principal.user_id, "exp": int(time.time()) + SESSION_TTL_SECONDS, "credential": _fingerprint(token), "nonce": secrets.token_hex(16)}
    encoded = base64.urlsafe_b64encode(json.dumps(claims, separators=(",", ":")).encode()).rstrip(b"=")
    signature = hmac.new(_session_key(), encoded, hashlib.sha256).hexdigest()
    return encoded.decode() + "." + signature, principal


def _authenticate_session(value):
    try:
        if len(value) > 4096:
            raise ValueError
        encoded, signature = value.rsplit(".", 1)
        expected = hmac.new(_session_key(), encoded.encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(signature, expected):
            raise ValueError
        claims = json.loads(base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4)))
        if type(claims.get("exp")) is not int or claims["exp"] <= time.time():
            raise ValueError
        for user in _configured_principals():
            if user["user_id"] == claims.get("sub") and hmac.compare_digest(_fingerprint(user["token"]), claims.get("credential", "")):
                return Principal(user["user_id"], user["role"], "session")
    except (ValueError, TypeError, UnicodeError, KeyError, AttributeError):
        pass
    raise HTTPException(401, "登录会话无效或已过期")


def authenticate_request(request: Request) -> Principal:
    users = _configured_principals()
    authorization = request.headers.get("authorization", "")
    if users:
        if authorization:
            if not authorization.startswith("Bearer "):
                raise HTTPException(401, "需要有效的访问凭据")
            return authenticate_token(authorization[7:])
        if request.cookies.get(SESSION_COOKIE):
            if request.method not in {"GET", "HEAD", "OPTIONS"}:
                check_origin(request)
            return _authenticate_session(request.cookies[SESSION_COOKIE])
        raise HTTPException(401, "需要有效的访问凭据")
    local = {"localhost", "127.0.0.1", "::1"}
    client_host = request.client.host if request.client else ""
    # testclient represents an in-process client and cannot arrive over the network.
    if client_host not in local | {"testclient"}:
        raise HTTPException(401, "远程访问需要配置访问凭据")
    try:
        host = urlsplit("//" + request.headers.get("host", ""))
        if host.hostname not in local or host.username or host.password or host.path or host.query or host.fragment:
            raise ValueError
        _ = host.port
        origin_header = request.headers.get("origin")
        if origin_header:
            origin = urlsplit(origin_header)
            if origin.scheme not in {"http", "https"} or origin.hostname not in local:
                raise ValueError
            if origin.username or origin.password or origin.path not in {"", "/"} or origin.query or origin.fragment:
                raise ValueError
            _ = origin.port
    except ValueError:
        raise HTTPException(403, "本地访问地址或来源无效") from None
    return Principal("admin", "admin", "local")


READ_ACTIONS = {"read", "task.read", "project.read", "settings.read", "artifact.read", "approval.read", "connector.read"}
MEMBER_ACTIONS = {"task.create"}
OWNER_ACTIONS = {"task.write", "task.message", "task.control", "task.accept", "task.approve", "approval.decide"}
ADMIN_ACTIONS = {"settings.write", "project.write", "identity.read", "identity.write", "event.inject", "budget.write", "audit.read", "task.assign"}


def require_permission(principal: Principal, action: str, owner_id=None):
    if action not in READ_ACTIONS | MEMBER_ACTIONS | OWNER_ACTIONS | ADMIN_ACTIONS:
        raise HTTPException(403, "不支持的权限操作")
    if principal.role == "admin":
        return
    if principal.role in {"member", "viewer"} and action in READ_ACTIONS:
        return
    if principal.role == "member":
        if action in MEMBER_ACTIONS or (action in OWNER_ACTIONS and owner_id is not None and str(owner_id) == principal.user_id):
            return
    raise HTTPException(403, "当前身份无权执行此操作")


def _audit(session, actor, action, resource, details=None):
    session.add(Audit(actor=actor, action=action, resource=str(resource), details=details or {}))


def audit_action(session, principal, action, resource, details=None):
    """Append to the caller's transaction using structured, non-content metadata."""
    allowed = {"task_id", "revision", "control_version", "state_version", "approval_id", "decision", "owner_id", "status", "source", "external_id"}
    if details and set(details) - allowed:
        raise ValueError("审计仅接受结构化状态字段")
    _audit(session, principal.user_id, action, resource, details)


SETTING_DEFAULTS = {
    "external_delivery_enabled": False,
    "scheduler_enabled": False,
    "max_concurrent_tasks": 1,
    "dingtalk_enabled": False,
    "redmine_enabled": False,
    "budget_hard_limit_micros": None,
    "budget_reservation_estimate_micros": None,
    "codex_model": "gpt-6.1-sol",
    "codex_effort": "medium",
    "connectors.dingtalk": {"enabled": False},
    "connectors.redmine": {"enabled": False},
}


def _nonempty(value, maximum=255):
    return isinstance(value, str) and bool(value.strip()) and len(value) <= maximum and not any(ord(char) < 32 for char in value)


def _validate_connector(name, value):
    # Share the manager's supported-field contract, then validate each runtime input.
    from .connections import validate_configuration
    try:
        validate_configuration(name, value)
        if name == "dingtalk":
            for key in ("profile", "chat_id"):
                if key in value and not _nonempty(value[key]):
                    raise ValueError
            if "executable" in value:
                command = value["executable"]
                parts = [command] if isinstance(command, str) else command
                if not isinstance(parts, list) or not parts or len(parts) > 32 or any(not _nonempty(part, 4096) for part in parts):
                    raise ValueError
                if any(re.search(r"(?:^|[-_])(token|password|secret|api[-_]?key)(?:=|$)", part, re.I) for part in parts):
                    raise ValueError
            if "self_ids" in value and (not value["self_ids"] or len(value["self_ids"]) > 100 or any(not _nonempty(item) for item in value["self_ids"])):
                raise ValueError
            kind = value.get("kind", "at-me")
            if (kind == "group") != bool(value.get("chat_id")):
                raise ValueError
            required = {"executable", "profile", "self_ids"}
        else:
            if "base_url" in value:
                if not _nonempty(value["base_url"], 2048):
                    raise ValueError
                parsed = urlsplit(value["base_url"])
                if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
                    raise ValueError
                _ = parsed.port
            if "api_key_env" in value and (not isinstance(value["api_key_env"], str) or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,127}", value["api_key_env"])):
                raise ValueError
            if "user_id" in value and (type(value["user_id"]) is not int or value["user_id"] <= 0):
                raise ValueError
            if "project_ids" in value and len(value["project_ids"]) > 1000:
                raise ValueError
            if "initial_since" in value:
                if not _nonempty(value["initial_since"], 80) or datetime.fromisoformat(value["initial_since"].replace("Z", "+00:00")).tzinfo is None:
                    raise ValueError
            if "account_map" in value:
                mapping = value["account_map"]
                if not isinstance(mapping, dict) or len(mapping) > 1000:
                    raise ValueError
                for alias, ids in mapping.items():
                    if not _nonempty(alias, 100) or not isinstance(ids, list) or not ids or len(ids) > 100 or any(type(item) is not int or item <= 0 for item in ids):
                        raise ValueError
            required = {"base_url", "project_ids", "user_id"}
        if value.get("enabled") is True and any(not value.get(key) for key in required):
            raise ValueError
    except (ValueError, TypeError, AttributeError, OverflowError):
        raise HTTPException(422, "连接器配置字段、类型或必填项无效，凭据仅允许环境变量引用") from None


def _validate_setting(key, value):
    if key not in SETTING_DEFAULTS:
        raise HTTPException(422, "不支持的设置字段，凭据必须通过环境变量配置")
    if key.startswith("connectors."):
        _validate_connector(key.split(".")[1], value)
        return
    if key == "codex_model":
        if value is not None and (not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}", value)):
            raise HTTPException(422, "Codex 模型标识无效")
        return
    if key == "codex_effort":
        if value is not None and (not isinstance(value, str) or value not in {"low", "medium", "high", "xhigh", "max", "ultra"}):
            raise HTTPException(422, "Codex 推理强度无效")
        return
    default = SETTING_DEFAULTS[key]
    if isinstance(default, bool):
        valid = type(value) is bool
    elif key == "max_concurrent_tasks":
        valid = type(value) is int and 1 <= value <= 4
    else:
        valid = value is None or (type(value) is int and 0 <= value <= 10**15)
    if not valid:
        raise HTTPException(422, "设置值类型或范围无效")


def get_setting(key, default=None):
    with db.Session() as session:
        setting = session.get(Setting, key)
        return setting.value if setting else default


def settings_snapshot():
    from .connections import get_config
    values = {key: get_setting(key, default) for key, default in SETTING_DEFAULTS.items()}
    for name in ("dingtalk", "redmine"):
        config = get_config("connectors." + name, {"enabled": False})
        try:
            _validate_connector(name, config)
        except HTTPException:
            config = {"enabled": False}
        values["connectors." + name] = config
        values[name + "_enabled"] = config.get("enabled", False)
    return values


def update_settings(values, actor="system"):
    for key, value in values.items():
        _validate_setting(key, value)
    try:
        with db.Session.begin() as session:
            values = dict(values)
            for name in ("dingtalk", "redmine"):
                key, alias = "connectors." + name, name + "_enabled"
                if key in values and alias in values and values[alias] != values[key].get("enabled", False):
                    raise HTTPException(422, "连接器启用字段冲突")
                if alias in values and key not in values:
                    previous = session.get(Setting, key)
                    # Preserve environment-provided configuration when migrating old switches.
                    if previous:
                        config = previous.value
                    else:
                        from .connections import get_config
                        config = get_config(key, {"enabled": False})
                    values[key] = dict(config, enabled=values[alias])
                    _validate_connector(name, values[key])
                if key in values:
                    values[alias] = values[key].get("enabled", False)
            for key, value in values.items():
                session.merge(Setting(key=key, value=value, updated_at=db.now()))
                _audit(session, actor, "settings.write", key, {"value": value})
            if "budget_hard_limit_micros" in values:
                account = session.get(BudgetAccount, "global")
                _configure_budget(session, "global", values["budget_hard_limit_micros"], account.currency if account else "USD", actor)
    except IntegrityError:
        raise HTTPException(409, "设置已变化，请重试") from None
    return settings_snapshot()


def set_setting(key, value):
    update_settings({key: value})
    return value


def _known_user(user_id):
    users = _users()
    if not users and user_id == "admin":
        return Principal("admin", "admin")
    for user in users:
        if user["user_id"] == user_id:
            return Principal(user_id, user["role"])
    # The optional legacy token remains a separate administrator identity.
    if os.getenv("SUPERAGENT_API_TOKEN") and user_id == "admin":
        return Principal("admin", "admin")
    raise HTTPException(422, "用户未配置")


def identity_snapshot(session, identity):
    grant = session.get(IdentityGrant, identity.id)
    return db.dump(identity) | {"project_ids": grant.project_ids if grant else [], "permissions": grant.permissions if grant else []}


def map_actor(source, actor_id, user_id, enabled=True, actor="system", project_ids=None, permissions=None):
    if source not in {"dingtalk", "redmine"} or not actor_id.strip() or len(actor_id) > 255:
        raise HTTPException(422, "外部身份无效")
    _known_user(user_id)
    project_ids = [] if project_ids is None else project_ids
    permissions = [] if permissions is None else permissions
    if not isinstance(project_ids, list) or len(project_ids) > 1000 or any(type(value) is not int or value <= 0 for value in project_ids):
        raise HTTPException(422, "项目授权必须是有效项目 ID 列表")
    if not isinstance(permissions, list) or any(value != "request" for value in permissions):
        raise HTTPException(422, "不支持的外部身份权限")
    project_ids = sorted(set(project_ids))
    permissions = sorted(set(permissions))
    try:
        with db.Session.begin() as session:
            if any(session.get(db.Project, project_id) is None for project_id in project_ids):
                raise HTTPException(422, "授权项目不存在")
            identity = session.scalar(select(Identity).where(Identity.source == source, Identity.actor_id == actor_id))
            if identity is None:
                identity = Identity(source=source, actor_id=actor_id, user_id=user_id)
                session.add(identity)
            identity.user_id = user_id
            identity.enabled = enabled
            session.flush()
            session.merge(IdentityGrant(identity_id=identity.id, project_ids=project_ids, permissions=permissions))
            _audit(session, actor, "identity.write", identity.id, {"source": source, "actor_id": actor_id, "user_id": user_id, "enabled": enabled, "project_ids": project_ids, "permissions": permissions})
            session.flush()
            return identity_snapshot(session, identity)
    except IntegrityError:
        raise HTTPException(409, "身份映射已变化，请重试") from None


def resolve_actor(source, actor_id) -> dict | None:
    with db.Session() as session:
        identity = session.scalar(select(Identity).where(Identity.source == source, Identity.actor_id == str(actor_id), Identity.enabled.is_(True)))
        if identity is None:
            return None
        try:
            user = _known_user(identity.user_id)
        except HTTPException as error:
            if error.status_code == 422:
                return None
            raise
        return identity_snapshot(session, identity) | {"user_id": user.user_id, "role": user.role, "source": source, "actor_id": str(actor_id)}


def assign_task_owner(task_id, user_id, actor="system", session=None):
    _known_user(user_id)
    if session is None:
        with db.Session.begin() as transaction:
            return assign_task_owner(task_id, user_id, actor, transaction)
    task = session.get(db.Task, task_id)
    if task is None:
        raise HTTPException(404, "任务不存在")
    if hasattr(db.Task, "owner_id"):
        task.owner_id = user_id
    session.merge(TaskOwner(task_id=task_id, user_id=user_id))
    _audit(session, actor, "task.assign", task_id, {"user_id": user_id})


def task_owner(task_id, session=None):
    if session is None:
        with db.Session() as transaction:
            return task_owner(task_id, transaction)
    if hasattr(db.Task, "owner_id"):
        task = session.get(db.Task, task_id)
        if task is None:
            return None
        # The db migration assigns local-admin to historical rows. Preserve an
        # existing explicit governance assignment until its column is backfilled.
        if task.owner_id != "local-admin":
            return task.owner_id
        legacy = session.get(TaskOwner, task_id)
        return legacy.user_id if legacy else task.owner_id
    owner = session.get(TaskOwner, task_id)
    return owner.user_id if owner else None


def _amount(value, nullable=False):
    if nullable and value is None:
        return
    if type(value) is not int or not 0 <= value <= 10**15:
        raise HTTPException(422, "金额必须是非负整数微单位")


def configure_budget(account_id, hard_limit_micros, currency="USD", actor="system"):
    _amount(hard_limit_micros, nullable=True)
    if not account_id or len(account_id) > 200 or not currency or len(currency) > 20:
        raise HTTPException(422, "预算账户参数无效")
    with db.Session.begin() as session:
        return _configure_budget(session, account_id, hard_limit_micros, currency, actor)


def _configure_budget(session, account_id, hard_limit_micros, currency, actor):
    # UPDATE first serializes with concurrent reservations on both supported databases.
    changed = session.execute(update(BudgetAccount).where(
        BudgetAccount.id == account_id,
        or_(BudgetAccount.currency == currency,
            (BudgetAccount.spent_micros == 0) & (BudgetAccount.reserved_micros == 0)),
    ).values(hard_limit_micros=hard_limit_micros, currency=currency))
    if not changed.rowcount:
        if session.get(BudgetAccount, account_id):
            raise HTTPException(409, "已有用量的账户不可切换币种")
        session.add(BudgetAccount(id=account_id, hard_limit_micros=hard_limit_micros, currency=currency))
        session.flush()
    account = session.get(BudgetAccount, account_id)
    if account_id == "global":
        session.merge(Setting(key="budget_hard_limit_micros", value=hard_limit_micros, updated_at=db.now()))
    _audit(session, actor, "budget.configure", account_id, {"hard_limit_micros": hard_limit_micros, "currency": currency})
    return db.dump(account)


def reserve_budget(account_id, request_key, estimate_micros, estimate_basis, task_id=None, actor="scheduler"):
    _amount(estimate_micros)
    if not request_key or len(request_key) > 255 or not estimate_basis or len(estimate_basis) > 500:
        raise HTTPException(422, "预算预留需要请求标识和明确估算依据")
    try:
        with db.Session.begin() as session:
            # Lock the account before reading the idempotency key. A no-op update
            # provides the same serialization for SQLite and PostgreSQL.
            locked = session.execute(update(BudgetAccount).where(BudgetAccount.id == account_id).values(reserved_micros=BudgetAccount.reserved_micros))
            if not locked.rowcount:
                raise HTTPException(409, "预算账户尚未配置")
            existing = session.scalar(select(BudgetReservation).where(BudgetReservation.account_id == account_id, BudgetReservation.request_key == request_key))
            if existing:
                if (existing.estimate_micros, existing.estimate_basis, existing.task_id) != (estimate_micros, estimate_basis, task_id):
                    raise HTTPException(409, "预算请求标识已用于其他估算")
                return db.dump(existing)
            account = session.get(BudgetAccount, account_id)
            if account.hard_limit_micros is not None and estimate_micros == 0:
                raise HTTPException(422, "硬预算预留必须使用正数估算")
            allowed = update(BudgetAccount).where(BudgetAccount.id == account_id)
            if account.hard_limit_micros is not None:
                allowed = allowed.where(BudgetAccount.spent_micros + BudgetAccount.reserved_micros + estimate_micros <= BudgetAccount.hard_limit_micros)
            changed = session.execute(allowed.values(reserved_micros=BudgetAccount.reserved_micros + estimate_micros))
            if not changed.rowcount:
                raise HTTPException(409, "预算不足")
            reservation = BudgetReservation(account_id=account_id, request_key=request_key, task_id=task_id, estimate_micros=estimate_micros, estimate_basis=estimate_basis)
            session.add(reservation)
            session.flush()
            _audit(session, actor, "budget.reserve", reservation.id, {"estimate_micros": estimate_micros})
            return db.dump(reservation)
    except IntegrityError:
        raise HTTPException(409, "预算请求冲突，请使用相同标识重试") from None


def settle_budget(reservation_id, actual_micros=None, usage=None, actor="scheduler"):
    _amount(actual_micros, nullable=True)
    if actual_micros is not None and (not isinstance(usage, dict) or not usage):
        raise HTTPException(422, "结算必须附带真实用量及计价依据")
    # Only numerical usage and a pricing/source identifier may be persisted.
    if usage is not None:
        allowed = {"input_tokens", "output_tokens", "total_tokens", "cached_input_tokens", "pricing_version", "source", "model", "evidence"}
        if not isinstance(usage, dict) or set(usage) - allowed:
            raise HTTPException(422, "不支持的用量字段")
        for key, value in usage.items():
            if key.endswith("tokens"):
                _amount(value)
            elif not isinstance(value, str) or not value.strip() or len(value) > (2000 if key == "evidence" else 200):
                raise HTTPException(422, "用量来源无效")
    with db.Session.begin() as session:
        reservation = session.get(BudgetReservation, reservation_id)
        if reservation is None:
            raise HTTPException(404, "预算预留不存在")
        # Match reserve's account-first lock ordering to avoid deadlocks.
        session.execute(update(BudgetAccount).where(BudgetAccount.id == reservation.account_id).values(reserved_micros=BudgetAccount.reserved_micros))
        session.refresh(reservation)
        if reservation.status == "settled":
            if reservation.actual_micros != actual_micros or reservation.usage != usage:
                raise HTTPException(409, "预算已按其他用量结算")
            return db.dump(reservation)
        if actual_micros is None:
            reservation.status = "unknown"
            _audit(session, actor, "budget.unknown", reservation.id)
        else:
            session.execute(update(BudgetAccount).where(BudgetAccount.id == reservation.account_id).values(reserved_micros=BudgetAccount.reserved_micros - reservation.estimate_micros, spent_micros=BudgetAccount.spent_micros + actual_micros))
            reservation.actual_micros = actual_micros
            reservation.usage = usage
            reservation.status = "settled"
            _audit(session, actor, "budget.settle", reservation.id, {"actual_micros": actual_micros, "usage": usage})
        session.flush()
        return db.dump(reservation)
