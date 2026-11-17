"""Reply drafts, explicit approval, and crash-safe external action accounting."""

import os
import json
from contextlib import nullcontext
from datetime import datetime, timezone

from sqlalchemy import Integer, JSON, String, Text, UniqueConstraint, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Mapped, mapped_column

from superagent.connectors.common import AuthorizedAction, digest, preview
from .connections import get_config
from .db import Approval, Base, Event, Session, Task, dump, now


class ReplyDraft(Base):
    __tablename__ = "reply_drafts"
    id: Mapped[int] = mapped_column(primary_key=True)
    task_id: Mapped[int] = mapped_column(Integer, index=True)
    event_id: Mapped[int] = mapped_column(Integer)
    approval_id: Mapped[int] = mapped_column(Integer, unique=True)
    content: Mapped[str] = mapped_column(Text)
    created_at: Mapped[str] = mapped_column(String(40), default=now)


class DeliveryRecord(Base):
    __tablename__ = "delivery_records"
    action_id: Mapped[str] = mapped_column(String(80), primary_key=True)
    action_hash: Mapped[str] = mapped_column(String(64))
    result: Mapped[dict] = mapped_column(JSON)
    created_at: Mapped[str] = mapped_column(String(40), default=now)


class DeliveryEchoBinding(Base):
    __tablename__ = "delivery_echo_bindings"
    __table_args__ = (UniqueConstraint("action_id"),)
    journal_key: Mapped[str] = mapped_column(String(64), primary_key=True)
    action_id: Mapped[str] = mapped_column(String(80))
    event_id: Mapped[int] = mapped_column(Integer)
    created_at: Mapped[str] = mapped_column(String(40), default=now)


def dingtalk_reply_targets(session, event, message_id, project_id):
    """Resolve a quoted assistant message through confirmed delivery evidence."""
    metadata = event.data.get('metadata', {})
    rows = session.execute(select(ReplyDraft.task_id, Approval.action)
        .join(Approval, Approval.id == ReplyDraft.approval_id)
        .join(DeliveryRecord, DeliveryRecord.action_id == 'reply-' + ReplyDraft.approval_id.cast(String))
        .join(Task, Task.id == ReplyDraft.task_id)
        .where(Task.project_id == project_id, Approval.action['source'].as_string() == 'dingtalk',
               Approval.action['target']['profile'].as_string() == metadata.get('profile'),
               Approval.action['target']['conversation_id'].as_string() == event.data.get('thread_id'),
               DeliveryRecord.result['write_status'].as_string() == 'succeeded',
               DeliveryRecord.result['message_id'].as_string() == message_id)).all()
    from .message_policy import conversation_type
    return {task_id for task_id, action in rows if conversation_type(metadata) != 'direct'
            or action.get('target', {}).get('recipient_id') == event.data.get('actor_id')}


def recognize_redmine_echo(session, event, *, settings=None):
    """Match one journal, allowing bounded pre-claim clock skew as candidates."""
    metadata = event.data.get("metadata", {})
    journal_id = metadata.get("journal_id")
    if (event.source != "redmine" or event.event_type != "issue.comment" or not journal_id
            or metadata.get("details") or event.data.get("attachments") or not event.content):
        return False
    config = (settings or get_config)("connectors.redmine", {})
    endpoint = metadata.get("redmine_endpoint")
    actor_id = str(event.data.get("actor_id", ""))
    if (not config.get("user_id") or actor_id != str(config["user_id"])
            or endpoint != str(config.get("base_url", "")).rstrip("/")):
        return False
    try:
        occurred = datetime.fromisoformat(str(event.data["occurred_at"]).replace("Z", "+00:00"))
        if occurred.tzinfo is None:
            return False
        issue_id = int(event.data["issue_id"])
    except (KeyError, TypeError, ValueError):
        return False
    journal_key = digest({"endpoint": endpoint, "issue_id": issue_id, "journal_id": str(journal_id)})
    bound = session.get(DeliveryEchoBinding, journal_key)
    candidates = session.execute(select(DeliveryRecord, ReplyDraft, Approval)
        .join(ReplyDraft, DeliveryRecord.action_id == "reply-" + ReplyDraft.approval_id.cast(String))
        .join(Approval, Approval.id == ReplyDraft.approval_id)
        .where(ReplyDraft.content == event.content, Approval.action["source"].as_string() == "redmine",
               Approval.action["target"]["base_url"].as_string() == endpoint,
               Approval.action["target"]["issue_id"].as_integer() == issue_id)
        .order_by(DeliveryRecord.created_at, DeliveryRecord.action_id).with_for_update(of=DeliveryRecord)).all()
    for record, draft, approval in candidates:
        target = approval.action.get("target", {})
        if (approval.action.get("source") != "redmine" or approval.action.get("kind") != "comment"
                or target.get("base_url") != endpoint or target.get("issue_id") != issue_id
                or approval.action.get("payload", {}).get("content") != event.content or draft.content != event.content
                or record.action_hash != approval.action_hash or record.result.get("sender_actor_id") != actor_id
                or record.action_hash != preview("redmine", "comment", target, {"content": event.content})["action_hash"]
                or record.result.get("write_status") not in {"succeeded", "unknown"}):
            continue
        if bound and bound.action_id != record.action_id:
            continue
        other = session.scalar(select(DeliveryEchoBinding).where(DeliveryEchoBinding.action_id == record.action_id))
        if other and other.journal_key != journal_key:
            continue
        try:
            claimed = datetime.fromisoformat(record.created_at.replace("Z", "+00:00"))
            elapsed = (occurred - claimed).total_seconds()
        except (TypeError, ValueError):
            continue
        # Redmine may expose only whole seconds. Such overlap stays a candidate.
        coarse_overlap = -1 < elapsed < 0 and occurred.microsecond == 0
        clock_skew_overlap = -30 <= elapsed < 0
        if not 0 <= elapsed <= 120 and not clock_skew_overlap:
            continue
        candidate = record.result["write_status"] == "unknown" or clock_skew_overlap
        status = "self_echo_candidate" if candidate else "self_echo"
        reason = "matched_successful_write"
        if clock_skew_overlap:
            reason = "source_clock_skew_overlap"
        if coarse_overlap:
            reason = "source_second_precision_overlap"
        if record.result["write_status"] == "unknown":
            reason = "write_outcome_unknown"
        if not bound:
            session.add(DeliveryEchoBinding(journal_key=journal_key, action_id=record.action_id, event_id=event.id))
        event.task_id = draft.task_id
        event.data = {**event.data, "routing_status": status, "delivery_action_id": record.action_id,
                      "echo_journal_id": str(journal_id), "echo_reason": reason}
        evidence = {"event_id": event.id, "journal_id": str(journal_id), "occurred_at": event.data["occurred_at"],
                    "routing_status": status, "reason": reason, "claimed_at": record.created_at,
                    "endpoint": endpoint, "issue_id": issue_id, "actor_id": actor_id, "elapsed_seconds": elapsed}
        record.result = {**record.result, "echo_evidence": evidence}
        from .governance import Audit
        session.add(Audit(actor="system", action="delivery." + status, resource=record.action_id, details=evidence))
        return True
    return False


def _get(session, cls, ident):
    obj = session.get(cls, ident)
    if obj is None:
        raise ValueError("记录不存在")
    return obj


def _valid(task, approval):
    return (approval.revision == task.revision and approval.control_version == task.control_version
            and task.status != "cancelled" and not task.outcome_unknown)


def _check_delivery_policy(session, source, settings):
    if source == 'dingtalk':
        from .message_policy import response_policy
        if response_policy(session, settings)['delivery'] not in ('approved_send', 'auto_send'):
            raise PermissionError('当前钉钉策略为仅生成草稿，请选择批准后发送并逐条审批')


def _check_automatic_authorization(session, draft, settings):
    source_event = _get(session, Event, draft.event_id)
    if not reply_source_allowed(session, source_event, draft.task_id):
        raise PermissionError('该来源的回复权限已变化，请检查人员与项目规则')
    automatic = session.scalar(select(Event.id).where(Event.event_type == 'delivery.auto_authorized',
        Event.task_id == draft.task_id, Event.data['draft_id'].as_integer() == draft.id))
    if automatic:
        task = _get(session, Task, draft.task_id)
        decision = current_reply_decision(session, task)
        if (not decision or decision.data.get('draft_id') != draft.id
                or not automatic_reply_allowed(session, task, source_event, decision, settings)):
            raise PermissionError('自动交付策略已变化，请核对当前规则')


def has_account_followup(session, task_id, source_event):
    from .event_groups import group_events
    from .message_context import time_key
    source_meta = source_event.data.get('metadata') or {}
    return source_event.source == 'dingtalk' and any(
        e.source == source_event.source and e.data.get('routing_status') == 'self_context'
        and e.data.get('thread_id') == source_event.data.get('thread_id')
        and (e.data.get('metadata') or {}).get('profile') == source_meta.get('profile')
        and ((e.data.get('metadata') or {}).get('reply_to_message_id') in (None, source_meta.get('message_id')))
        and (time_key(e), e.id) > (time_key(source_event), source_event.id)
        for e in group_events(session, task_id)
    )


def reply_source_allowed(session, event, task_id):
    # A resumed thread may retain information read from other projects.
    if session.scalar(select(Event.id).where(Event.task_id == task_id,
                      Event.event_type == 'analysis_reference_scope').limit(1)):
        return False
    if event.task_id != task_id or (event.data.get('metadata') or {}).get('self_authored'):
        return False
    if event.source == 'dingtalk':
        from .message_access import access_config, resolve_requester
        from .governance import resolve_actor
        access = access_config(session)
        if access is not None:
            actor, _, reason = resolve_requester(session, event, resolve_actor)
            task = session.get(Task, task_id)
            if reason or not actor or not task or task.project_id not in actor.get('project_ids', []):
                return False
    status = event.data.get('routing_status')
    if status == 'routed':
        return True
    if status != 'delivered':
        return False
    from .subscriptions import EventTarget
    return session.scalars(select(EventTarget.id).where(EventTarget.task_id == task_id,
                           EventTarget.message_event_id == event.id,
                           EventTarget.event_id == event.data.get('source_event_id'))).first() is not None


def latest_reply_source(session, task_id):
    from .message_context import time_key
    events = session.scalars(select(Event).where(Event.task_id == task_id, Event.source.in_(['dingtalk', 'redmine'])))
    return max((e for e in events if reply_source_allowed(session, e, task_id)),
               key=lambda e: (time_key(e), e.id), default=None)


def current_reply_decision(session, task):
    return session.scalar(select(Event).where(Event.task_id == task.id, Event.source == 'runtime',
        Event.event_type == 'reply_decision', Event.data['revision'].as_integer() == task.revision,
        Event.data['control_version'].as_integer() == task.control_version).order_by(Event.id.desc()).limit(1))


def reply_age_seconds(source):
    from .message_context import time_key
    return datetime.now(timezone.utc).timestamp() - time_key(source)


def retire_automatic_draft(session, task, source, decision, approval, policy):
    from .message_policy import DEFAULT_REPLY_MAX_AGE_MINUTES
    if has_account_followup(session, task.id, source):
        reason = '来源会话已收到本账号后续发言，自动回复已跳过。'
    elif reply_age_seconds(source) > 60 * policy.get('reply_max_age_minutes', DEFAULT_REPLY_MAX_AGE_MINUTES):
        reason = '来信已超过自动回复有效期，本轮不再自动回复。'
    else:
        return False
    approval.status = 'expired'
    task.state_version += 1
    task.updated_at = now()
    session.add(Event(task_id=task.id, source='runtime', event_type='reply_decision', content=reason,
                      data={**decision.data, 'decision': 'skip', 'draft_id': None}))
    return True


def automatic_reply_allowed(session, task, source, decision, settings):
    from .event_rules import evaluate
    from .message_policy import DEFAULT_REPLY_MAX_AGE_MINUTES, policy_allows, response_policy
    from .db import Project
    policy = response_policy(session, settings)
    project = session.get(Project, task.project_id)
    if (task.status != 'review_ready' or task.outcome_unknown
            or not project or not project.enabled or project.archived
            or decision.data.get('decision') != 'send' or decision.data.get('source_event_id') != source.id
            or decision.data.get('guidance_hash') != digest(policy.get('reply_guidance', ''))
            or policy['delivery'] != 'auto_send' or not settings('external_delivery_enabled', False)
            or not settings('connectors.' + source.source, {}).get('enabled')
            or evaluate(session, source, task.project_id, task.kind)):
        return False
    if source.source == 'dingtalk' and not policy_allows(policy, source.data.get('metadata') or {}, source.data.get('thread_id')):
        return False
    age = reply_age_seconds(source)
    if not -30 <= age <= 60 * policy.get('reply_max_age_minutes', DEFAULT_REPLY_MAX_AGE_MINUTES):
        return False
    latest = latest_reply_source(session, task.id)
    if not latest or latest.id != source.id or has_account_followup(session, task.id, source):
        return False
    # A manual send or unknown outcome for this source also prevents duplicate automation.
    origin_id = source.data.get('source_event_id') or source.id
    previous = session.scalar(select(DeliveryRecord.action_id)
        .join(ReplyDraft, DeliveryRecord.action_id == 'reply-' + ReplyDraft.approval_id.cast(String))
        .join(Event, Event.id == ReplyDraft.event_id)
        .where(Event.source == source.source,
               or_(Event.id == origin_id, Event.data['source_event_id'].as_integer() == origin_id),
               DeliveryRecord.result['write_status'].as_string().in_(['succeeded', 'unknown'])).limit(1))
    return previous is None


def create_draft(task_id, event_id, content, *, session_factory=None, settings=None, db_session=None):
    if not content.strip():
        raise ValueError("回复草稿不能为空")
    factory, settings = session_factory or Session, settings or get_config
    with (nullcontext(db_session) if db_session is not None else factory.begin()) as session:
        task = _get(session, Task, task_id)
        event = _get(session, Event, event_id)
        if not reply_source_allowed(session, event, task.id):
            raise ValueError("回复目标必须来自已路由的任务事件")
        config = settings("connectors." + event.source, {})
        if event.source == "dingtalk":
            metadata = event.data.get('metadata', {})
            if metadata.get('profile') != config.get('profile'):
                raise ValueError('来源事件与当前钉钉账号不匹配')
            target = {"profile": config.get("profile"), "conversation_id": event.data.get("thread_id"),
                      "message_id": metadata.get("message_id")}
            from .message_policy import conversation_type
            if conversation_type(metadata) == 'direct':
                target['recipient_id'] = event.data.get('actor_id')
            kind = "reply"
        elif event.source == "redmine":
            endpoint = event.data.get("metadata", {}).get("redmine_endpoint")
            if endpoint != str(config.get("base_url", "")).rstrip("/"):
                raise ValueError("事件来源与当前 Redmine 服务不匹配")
            target = {"base_url": endpoint, "issue_id": int(event.data.get("issue_id"))}
            kind = "comment"
        else:
            raise ValueError("不支持该回复渠道")
        if not all(target.values()):
            raise ValueError("来源事件缺少明确回复目标")
        plan = preview(event.source, kind, target, {"content": content})
        approval = Approval(task_id=task.id, revision=task.revision, control_version=task.control_version,
                            action_hash=plan["action_hash"], action=plan)
        session.add(approval)
        session.flush()
        draft = ReplyDraft(task_id=task.id, event_id=event.id, approval_id=approval.id, content=content)
        session.add(draft)
        session.flush()
        return {**dump(draft), "approval": dump(approval)}


def decide_draft(draft_id, decision, action_hash, *, session_factory=None):
    if decision not in {"approve", "reject"}:
        raise ValueError("审批决定无效")
    with (session_factory or Session).begin() as session:
        draft = _get(session, ReplyDraft, draft_id)
        task = session.get(Task, draft.task_id, with_for_update=True)
        approval = session.get(Approval, draft.approval_id, with_for_update=True)
        if approval.status != "pending" or approval.action_hash != action_hash or not _valid(task, approval):
            raise ValueError("审批已过期或动作不匹配")
        approval.status = "approved" if decision == "approve" else "rejected"
        session.add(Event(task_id=task.id, source="web", event_type="delivery.approval",
                          content=decision, data={"draft_id": draft.id, "action_hash": action_hash}))
        return dump(approval)


class PersistentActionLedger:
    def __init__(self, session_factory=None, settings=None):
        self.sessions = session_factory or Session
        self.settings = settings or get_config

    async def claim(self, action_id, action_hash):
        try:
            with self.sessions.begin() as session:
                if session.get(DeliveryRecord, action_id):
                    return False
                approval_id = int(action_id.removeprefix("reply-"))
                approval = session.get(Approval, approval_id)
                if approval is None:
                    raise PermissionError("审批不存在")
                task = session.get(Task, approval.task_id, with_for_update=True)
                session.refresh(approval, with_for_update=True)
                if approval.status != "approved" or approval.action_hash != action_hash or not _valid(task, approval):
                    raise PermissionError("发送授权无效或已过期")
                from .event_rules import blocks_processing
                draft = session.scalar(select(ReplyDraft).where(ReplyDraft.approval_id == approval.id))
                if draft:
                    _check_automatic_authorization(session, draft, self.settings)
                if draft and blocks_processing(session, _get(session, Event, draft.event_id), task.project_id, task.kind):
                    raise PermissionError('当前交付暂不可用，请在工作台检查')
                _check_delivery_policy(session, approval.action.get('source'), self.settings)
                sender = {}
                if approval.action.get("source") == "redmine":
                    config = self.settings("connectors.redmine", {})
                    if not config.get("user_id"):
                        raise PermissionError("Redmine 发送需要明确账号 user_id")
                    sender = {"sender_actor_id": str(config["user_id"])}
                session.add(DeliveryRecord(action_id=action_id, action_hash=action_hash,
                                           result={"action_id": action_id, "action_hash": action_hash,
                                                   "write_status": "unknown", "reason": "claimed_outcome_pending_reconciliation", **sender}))
                session.flush()
            return True
        except IntegrityError:
            return False

    async def get(self, action_id):
        with self.sessions() as session:
            row = session.get(DeliveryRecord, action_id)
            return dict(row.result) if row else {}

    async def finish(self, action_id, result):
        with self.sessions.begin() as session:
            row = session.get(DeliveryRecord, action_id, with_for_update=True)
            if row is None:
                raise ValueError("发送账本不存在")
            retained = {key: row.result[key] for key in ("sender_actor_id", "echo_evidence") if key in row.result}
            newly_sent = row.result.get("write_status") != "succeeded" and result.get("write_status") == "succeeded"
            row.result = {**retained, **result}
            if newly_sent:
                approval = session.get(Approval, int(action_id.removeprefix("reply-")))
                task = session.get(Task, approval.task_id, with_for_update=True) if approval else None
                if task and task.kind == 'reply' and task.status == 'review_ready' and _valid(task, approval):
                    task.state_version += 1
                    task.updated_at = now()
                    session.add(Event(task_id=task.id, source='runtime', event_type='reply_sent',
                        data={'revision': task.revision, 'control_version': task.control_version, 'action_id': action_id}))


async def publish_draft(draft_id, *, session_factory=None, settings=None, client=None):
    factory, settings = session_factory or Session, settings or get_config
    with factory() as session:
        draft = _get(session, ReplyDraft, draft_id)
        approval = _get(session, Approval, draft.approval_id)
        plan = dict(approval.action)
        action_id = "reply-" + str(approval.id)
        record = session.get(DeliveryRecord, action_id)
        if record:
            return dict(record.result)
        _check_automatic_authorization(session, draft, settings)
        if approval.status != "approved" or not _valid(_get(session, Task, draft.task_id), approval):
            raise PermissionError("需要有效的明确发送批准")
        from .event_rules import blocks_processing
        policy_task = _get(session, Task, draft.task_id)
        policy_event = _get(session, Event, draft.event_id)
        if blocks_processing(session, policy_event, policy_task.project_id, policy_task.kind):
            raise PermissionError('当前交付暂不可用，请在工作台检查')
        _check_delivery_policy(session, plan['source'], settings)
        authorization = AuthorizedAction(action_id, approval.action_hash)
    source, target = plan["source"], plan["target"]
    config = settings("connectors." + source, {})
    if config.get("enabled") is not True or settings("external_delivery_enabled", False) is not True:
        raise PermissionError("外部交付尚未明确启用")
    owned = client is None
    if source == "redmine":
        if str(config.get("base_url", "")).rstrip("/") != target["base_url"]:
            raise PermissionError("回复服务配置已变化，请重新生成草稿")
        if client is None:
            from superagent.connectors.redmine import RedmineClient
            key = os.getenv(config.get("api_key_env", "HLZJ_REDMINE_API_KEY"))
            if not key:
                raise ValueError("缺少环境变量凭据")
            client = RedmineClient(target["base_url"], key)
    else:
        if config.get("profile") != target["profile"]:
            raise PermissionError("回复账号配置已变化，请重新生成草稿")
        if client is None:
            from superagent.connectors.dingtalk import DingTalkClient
            client = DingTalkClient(config.get("executable", "dws"), profile=target["profile"])
    ledger = PersistentActionLedger(factory, settings)
    try:
        if source == "redmine":
            await client.add_comment(target["issue_id"], plan["payload"]["content"], authorization=authorization, ledger=ledger)
        else:
            options = {'recipient_id': target['recipient_id']} if target.get('recipient_id') else {}
            await client.reply(target["conversation_id"], target["message_id"], plan["payload"]["content"], authorization=authorization, ledger=ledger, **options)
        return await ledger.get(action_id)
    finally:
        if owned:
            await client.close()


def reconcile_delivery(draft_id, outcome, evidence, *, session_factory=None):
    if outcome not in {"succeeded", "failed"} or not evidence.strip():
        raise ValueError("请提供外部核验结果和证据")
    with (session_factory or Session).begin() as session:
        draft = _get(session, ReplyDraft, draft_id)
        record = _get(session, DeliveryRecord, "reply-" + str(draft.approval_id))
        if record.result.get("write_status") != "unknown":
            raise ValueError("仅可对账结果未知的交付")
        record.result = {**record.result, "write_status": outcome, "reconciliation_evidence": evidence,
                         "reconciled_at": now()}
        session.add(Event(task_id=draft.task_id, source="web", event_type="delivery.reconciled",
                          content=evidence, data={"action_id": record.action_id, "outcome": outcome}))
        return dict(record.result)


async def deliver_automatically(*, session_factory=None, settings=None, client=None):
    """Apply standing authorization to verified current results, one action per tick."""
    factory, settings = session_factory or Session, settings or get_config
    if not settings('external_delivery_enabled', False):
        return
    from .message_policy import response_policy
    from .db import Project
    candidate = None
    with factory.begin() as session:
        policy = response_policy(session, settings)
        if policy['delivery'] != 'auto_send':
            return
        tasks = session.scalars(select(Task).where(Task.status == 'review_ready',
            Task.outcome_unknown.is_(False)).order_by(Task.id)).all()
        for task in tasks:
            project = session.get(Project, task.project_id)
            if not project or not project.enabled or project.archived:
                continue
            decision = current_reply_decision(session, task)
            if not decision or decision.data.get('decision') != 'send':
                continue
            draft = session.get(ReplyDraft, decision.data['draft_id']) if decision.data.get('draft_id') else None
            if not draft or draft.task_id != task.id:
                continue
            approval = session.get(Approval, draft.approval_id)
            if not approval or not _valid(task, approval) or session.get(DeliveryRecord, 'reply-' + str(approval.id)):
                continue
            if approval.status != 'pending' and not (approval.status == 'approved' and session.scalar(
                select(Event.id).where(Event.task_id == task.id, Event.event_type == 'delivery.auto_authorized',
                    Event.data['draft_id'].as_integer() == draft.id).limit(1))):
                continue
            source = session.get(Event, draft.event_id)
            if not source or not reply_source_allowed(session, source, task.id):
                continue
            latest = latest_reply_source(session, task.id)
            if not latest or latest.id != source.id:
                continue
            if retire_automatic_draft(session, task, source, decision, approval, policy):
                continue
            if not automatic_reply_allowed(session, task, source, decision, settings):
                continue
            if approval.status == 'pending':
                approval.status = 'approved'
                session.add(Event(task_id=task.id, source='runtime', event_type='delivery.auto_authorized',
                    data={'draft_id': draft.id, 'revision': task.revision, 'action_hash': approval.action_hash}))
            candidate = draft.id
            break
    if candidate is not None:
        try:
            await publish_draft(candidate, session_factory=factory, settings=settings, client=client)
        except Exception as exc:
            # A claimed action remains in the ledger and cannot be sent twice.
            with factory.begin() as session:
                draft = session.get(ReplyDraft, candidate)
                approval = session.get(Approval, draft.approval_id)
                approval.status = 'failed'
                session.add(Event(task_id=draft.task_id, source='runtime', event_type='delivery.auto_failed',
                    content=type(exc).__name__, data={'draft_id': candidate}))
