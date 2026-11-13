"""Governance routes enforce authentication independently of main middleware."""
import os

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, Field, StrictInt
from sqlalchemy import select

from superagent.core import db
from superagent.core import governance as gov

router = APIRouter(prefix="/api/v1", tags=["governance"])


@router.post("/auth/login")
async def login(request: Request, response: Response):
    gov.check_origin(request)
    secure = gov.session_requires_secure(request)
    try:
        body = await request.json()
    except ValueError:
        raise HTTPException(422, "登录请求格式无效") from None
    if not isinstance(body, dict) or set(body) != {"token"} or not isinstance(body["token"], str) or not 1 <= len(body["token"]) <= 8192:
        raise HTTPException(422, "请提供有效的登录令牌")
    cookie, principal = gov.issue_session(body["token"])
    response.set_cookie(gov.SESSION_COOKIE, cookie, max_age=gov.SESSION_TTL_SECONDS, httponly=True, secure=secure, samesite="strict", path="/api/v1")
    response.headers["Cache-Control"] = "no-store"
    return principal.to_dict()


@router.post("/auth/logout")
def logout(request: Request, response: Response):
    gov.check_origin(request)
    secure = gov.session_requires_secure(request)
    response.delete_cookie(gov.SESSION_COOKIE, path="/api/v1", secure=secure, httponly=True, samesite="strict")
    response.headers["Cache-Control"] = "no-store"
    return {"logged_out": True}


@router.get("/auth/me")
def me(principal: gov.Principal = Depends(gov.authenticate_request)):
    return principal.to_dict()


@router.get("/settings")
def settings(principal: gov.Principal = Depends(gov.authenticate_request)):
    gov.require_permission(principal, "settings.read")
    return gov.settings_snapshot() | {"authentication_required": bool(os.getenv("SUPERAGENT_API_TOKEN") or os.getenv("SUPERAGENT_USERS_JSON"))}


@router.patch("/settings")
def update_settings(body: dict, principal: gov.Principal = Depends(gov.authenticate_request)):
    gov.require_permission(principal, "settings.write")
    return gov.update_settings(body, actor=principal.user_id)


class IdentityIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    source: str
    actor_id: str = Field(min_length=1, max_length=255)
    user_id: str = Field(min_length=1, max_length=200)
    enabled: bool = True
    project_ids: list[StrictInt] = Field(default_factory=list, max_length=1000)
    permissions: list[str] = Field(default_factory=list, max_length=1)


@router.get("/identities")
def identities(principal: gov.Principal = Depends(gov.authenticate_request)):
    gov.require_permission(principal, "identity.read")
    with db.Session() as session:
        return [gov.identity_snapshot(session, row) for row in session.scalars(select(gov.Identity).order_by(gov.Identity.id))]


@router.post("/identities")
@router.patch("/identities")
def map_identity(body: IdentityIn, principal: gov.Principal = Depends(gov.authenticate_request)):
    gov.require_permission(principal, "identity.write")
    return gov.map_actor(**body.model_dump(), actor=principal.user_id)


@router.delete("/identities/{identity_id}")
def disable_identity(identity_id: int, principal: gov.Principal = Depends(gov.authenticate_request)):
    gov.require_permission(principal, "identity.write")
    with db.Session.begin() as session:
        row = session.get(gov.Identity, identity_id)
        if row is None:
            raise HTTPException(404, "身份映射不存在")
        row.enabled = False
        gov._audit(session, principal.user_id, "identity.disable", identity_id)
        session.flush()
        return gov.identity_snapshot(session, row)


@router.get("/audit")
def audit(limit: int = 100, principal: gov.Principal = Depends(gov.authenticate_request)):
    gov.require_permission(principal, "audit.read")
    if not 1 <= limit <= 1000:
        raise HTTPException(422, "审计条数必须在 1 到 1000 之间")
    with db.Session() as session:
        return [db.dump(row) for row in session.scalars(select(gov.Audit).order_by(gov.Audit.id.desc()).limit(limit))]


class BudgetIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    hard_limit_micros: int | None = Field(default=None, ge=0, le=10**15, strict=True)
    currency: str = Field(default="USD", min_length=1, max_length=20)


@router.get("/budgets")
def budgets(principal: gov.Principal = Depends(gov.authenticate_request)):
    gov.require_permission(principal, "budget.write")
    with db.Session() as session:
        return [db.dump(row) for row in session.scalars(select(gov.BudgetAccount).order_by(gov.BudgetAccount.id))]


@router.patch("/budgets/{account_id}")
def configure_budget(account_id: str, body: BudgetIn, principal: gov.Principal = Depends(gov.authenticate_request)):
    gov.require_permission(principal, "budget.write")
    return gov.configure_budget(account_id, **body.model_dump(), actor=principal.user_id)


@router.get("/budget-reservations")
def budget_reservations(account_id: str | None = None, status: str | None = None, limit: int = 100,
                        principal: gov.Principal = Depends(gov.authenticate_request)):
    gov.require_permission(principal, "budget.write")
    if not 1 <= limit <= 1000 or status is not None and status not in {"reserved", "unknown", "settled"}:
        raise HTTPException(422, "预算查询条件无效")
    query = select(gov.BudgetReservation).order_by(gov.BudgetReservation.id.desc()).limit(limit)
    if account_id is not None:
        query = query.where(gov.BudgetReservation.account_id == account_id)
    if status is not None:
        query = query.where(gov.BudgetReservation.status == status)
    with db.Session() as session:
        return [db.dump(row) for row in session.scalars(query)]


class BudgetReconciliationIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    actual_micros: int = Field(ge=0, le=10**15, strict=True)
    evidence: str = Field(min_length=1, max_length=2000)


@router.post("/budget-reservations/{reservation_id}/reconcile")
def reconcile_budget(reservation_id: int, body: BudgetReconciliationIn,
                     principal: gov.Principal = Depends(gov.authenticate_request)):
    gov.require_permission(principal, "budget.write")
    if not body.evidence.strip():
        raise HTTPException(422, "人工对账需要实际费用依据")
    return gov.settle_budget(reservation_id, body.actual_micros,
                             {"source": "administrator_reconciliation", "evidence": body.evidence}, actor=principal.user_id)
