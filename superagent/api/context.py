"""Authenticated decision ledger and Worker context audit endpoints."""

from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select, update

from superagent.core import db, governance as gov
from superagent.core.context import redact
from superagent.core.message_context import scoped_timeline
from superagent.core.subscriptions import EventTarget

router = APIRouter(prefix='/api/v1', tags=['context'])
DecisionStatus = Literal['active', 'revoked', 'superseded']


class DecisionIn(BaseModel):
    model_config = ConfigDict(extra='forbid')
    project_id: int = Field(gt=0)
    task_id: int | None = Field(default=None, gt=0)
    event_id: int | None = Field(default=None, gt=0)
    kind: Literal['decision', 'constraint', 'accepted', 'note']
    content: str = Field(min_length=1, max_length=10_000)


class RevokeIn(BaseModel):
    model_config = ConfigDict(extra='forbid')
    reason: str = Field(min_length=1, max_length=1000)


def _task(session, task_id, principal, project_id=None):
    task = session.get(db.Task, task_id)
    if task is None or (project_id is not None and task.project_id != project_id):
        raise HTTPException(404, '当前项目内没有该任务')
    gov.require_permission(principal, 'task.control', gov.task_owner(task.id, session))
    return task


def _event_ids(session, task):
    events, _ = scoped_timeline(session, task)
    return {event.id for event in events}


def _assert_project_source(session, project_id, event_id):
    event = session.get(db.Event, event_id)
    if event is not None:
        if event.task_id is None:
            targets = session.scalars(select(db.Task).join(
                EventTarget, EventTarget.task_id == db.Task.id,
            ).where(EventTarget.event_id == event_id, db.Task.project_id == project_id))
        else:
            parent = session.get(db.Task, event.task_id)
            targets = (parent,) if parent is not None and parent.project_id == project_id else ()
        if any(event_id in _event_ids(session, task) for task in targets):
            return
    raise HTTPException(404, '当前项目内没有可用的来源事件')


@router.post('/decisions', status_code=201)
async def create_decision(body: DecisionIn, principal=Depends(gov.authenticate_request)):
    content = redact(body.content)
    if not content:
        raise HTTPException(422, '请填写决定内容')
    with db.Session.begin() as session:
        task = _task(session, body.task_id, principal, body.project_id) if body.task_id else None
        if task is None:
            gov.require_permission(principal, 'project.write')
        project = session.get(db.Project, body.project_id)
        if project is None or not project.enabled or project.archived:
            raise HTTPException(404, '项目不可用')
        if body.event_id:
            if task is not None:
                if body.event_id not in _event_ids(session, task):
                    raise HTTPException(404, '当前任务内没有可用的来源事件')
            else:
                _assert_project_source(session, project.id, body.event_id)
        decision = db.Decision(project_id=project.id, task_id=body.task_id, event_id=body.event_id,
                               kind=body.kind, content=content, actor=principal.user_id,
                               revision=task.revision if task is not None else None)
        session.add(decision)
        session.flush()
        gov.audit_action(session, principal, 'context.decision.create', decision.id,
                         {'task_id': decision.task_id, 'revision': decision.revision, 'status': decision.status})
        return db.dump(decision)


@router.post('/decisions/{decision_id}/revoke')
async def revoke_decision(decision_id: int, body: RevokeIn, principal=Depends(gov.authenticate_request)):
    reason = redact(body.reason)
    if not reason:
        raise HTTPException(422, '请填写撤销原因')
    with db.Session.begin() as session:
        decision = session.get(db.Decision, decision_id)
        if decision is None:
            raise HTTPException(404, '找不到决定')
        if principal.role != 'admin':
            if decision.task_id is None:
                gov.require_permission(principal, 'project.write')
            task = _task(session, decision.task_id, principal, decision.project_id)
            if decision.event_id and decision.event_id not in _event_ids(session, task):
                raise HTTPException(404, '当前任务内没有该决定')
        changed = session.execute(update(db.Decision).where(
            db.Decision.id == decision.id, db.Decision.status == 'active',
        ).values(status='revoked', revoked_at=db.now(), revoked_by=principal.user_id, revocation_reason=reason))
        if changed.rowcount:
            gov.audit_action(session, principal, 'context.decision.revoke', decision.id,
                             {'task_id': decision.task_id, 'revision': decision.revision, 'status': 'revoked'})
        session.refresh(decision)
        if decision.status != 'revoked':
            raise HTTPException(409, '该决定已被替代')
        return db.dump(decision)


def _list_decisions(session, principal, project_id, task_id, status, after, limit):
    query = select(db.Decision).where(db.Decision.status == status, db.Decision.id > after)
    if task_id is not None:
        task = _task(session, task_id, principal, project_id)
        project_id = task.project_id
        visible_ids = _event_ids(session, task)
        query = query.where((db.Decision.task_id.is_(None)) | (db.Decision.task_id == task.id))
        query = query.where((db.Decision.event_id.is_(None)) | (db.Decision.event_id.in_(visible_ids)))
    else:
        gov.require_permission(principal, 'project.write')
    if project_id is not None:
        query = query.where(db.Decision.project_id == project_id)
    decisions = session.scalars(query.order_by(db.Decision.id).limit(limit)).all()
    return {'items': [db.dump(row) for row in decisions]}


@router.get('/decisions')
def list_decisions(project_id: int | None = None, task_id: int | None = None,
                   status: DecisionStatus = 'active', after: int = Query(0, ge=0),
                   limit: int = Query(100, ge=1, le=200), principal=Depends(gov.authenticate_request)):
    with db.Session() as session:
        return _list_decisions(session, principal, project_id, task_id, status, after, limit)


@router.get('/tasks/{task_id}/decisions')
def task_decisions(task_id: int, status: DecisionStatus = 'active', after: int = Query(0, ge=0),
                   limit: int = Query(100, ge=1, le=200), principal=Depends(gov.authenticate_request)):
    with db.Session() as session:
        return _list_decisions(session, principal, None, task_id, status, after, limit)


@router.get('/attempts/{attempt_id}/context')
def attempt_context(attempt_id: str, principal=Depends(gov.authenticate_request)):
    with db.Session() as session:
        attempt = session.get(db.ExecutionAttempt, attempt_id)
        if attempt is None:
            raise HTTPException(404, '找不到执行尝试')
        task = _task(session, attempt.task_id, principal)
        manifest = session.get(db.ContextManifest, attempt.manifest_id) if attempt.manifest_id is not None else None
        if (manifest is None or manifest.attempt_id != attempt.id
                or (principal.role != 'admin' and manifest.project_id != task.project_id)):
            raise HTTPException(404, '找不到上下文清单')
        return db.dump(manifest)


@router.get('/tasks/{task_id}/context')
def task_context(task_id: int, limit: int = Query(30, ge=1, le=100),
                 principal=Depends(gov.authenticate_request)):
    with db.Session() as session:
        task = _task(session, task_id, principal)
        query = select(db.ContextManifest).where(db.ContextManifest.task_id == task.id)
        if principal.role != 'admin':
            query = query.where(db.ContextManifest.project_id == task.project_id)
        manifests = session.scalars(query.order_by(db.ContextManifest.id.desc()).limit(limit)).all()
        return {'items': [db.dump(row) for row in manifests]}
