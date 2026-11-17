"""Administrator controls for semantic routing and explicit subscriptions."""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from uuid import uuid4

from superagent.api.connections import require_admin
from superagent.core.db import Session, Event, Project, Task, dump
from superagent.core.governance import Audit
from superagent.core.subscriptions import WorkerSubscription, subscribe, authorized_task
from superagent.core.semantic_routing import SemanticRoutingJob, semantic_routing_service

router = APIRouter(prefix='/api/v1', dependencies=[Depends(require_admin)])


class AssessmentInput(BaseModel):
    event_ids: list[int] = Field(min_length=2, max_length=5)


def comparison_context(session, ids):
    from superagent.connectors.dingtalk import message_attachments
    from superagent.core.event_rules import blocks_processing
    from superagent.core.governance import Setting
    from superagent.core.ingestion import trusted_actor
    from superagent.core.message_access import resolve_requester
    from superagent.core.message_policy import policy_allows, response_policy
    from superagent.core.unassigned_routing import context_for
    rows = session.scalars(select(Event).where(Event.id.in_(ids)).order_by(Event.id)).all()
    if len(rows) != len(ids) or not all(row.external_id and row.task_id is None for row in rows):
        raise ValueError('请选择尚未分派的来源事件')
    anchor = rows[-1]
    scope = lambda row: (row.data.get('thread_id'), row.data.get('actor_id'),
                         (row.data.get('metadata') or {}).get('profile'))
    policy = response_policy(session)
    for row in rows:
        actor, _, error = resolve_requester(session, row, trusted_actor)
        if (scope(row) != scope(anchor) or error or not actor or not actor.get('enabled', True)
                or (row.data.get('metadata') or {}).get('self_authored')
                or not policy_allows(policy, row.data.get('metadata') or {}, row.data.get('thread_id'))
                or blocks_processing(session, row, None, 'analysis')
                or context_for(session, row, actor) is None):
            raise ValueError('事件必须来自同一获准的钉钉私聊')
    receipts = {row.id: {**row.data, 'attachments': message_attachments(row.content, row.data.get('attachments'))}
                for row in rows}
    context = context_for(session, anchor, actor)
    context['comparison'] = [{'event_id': row.id, 'content': row.content[:4000],
                              'has_image': bool(receipts[row.id]['attachments'])} for row in rows]
    setting = session.get(Setting, 'connectors.dingtalk')
    return context, receipts, setting.value if setting else {}


@router.post('/routing/assessments')
async def assess_receipts(body: AssessmentInput, principal=Depends(require_admin)):
    """Compare receipts without replaying ingestion or applying a routing decision."""
    import json
    from superagent.core.unassigned_routing import TriageEvidence, validate_project_assessment
    ids = sorted(set(body.event_ids))
    if len(ids) != len(body.event_ids):
        raise HTTPException(422, '事件编号不能重复')
    try:
        with Session() as session:
            context, receipts, config = comparison_context(session, ids)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from None
    evidence = TriageEvidence(context, receipts, config)
    key = 'comparison-' + uuid4().hex
    result = {'event_ids': ids, 'assessment_id': key, 'status': 'incomplete'}
    try:
        output = await semantic_routing_service._model(ids[-1], context, evidence=evidence, batch_key=key)
        result['decision'] = validate_project_assessment(json.loads(output), context)
        attempted = {('chat_evidence', None), *(('source_image', row['event_id'])
                      for row in context['comparison'] if row['has_image'])}
        complete = attempted <= evidence.attempted
        result['status'] = 'assessed' if complete else 'incomplete'
        if not complete:
            result['error'] = '模型未尝试读取所有要求的证据'
    except Exception as exc:
        result['error'] = type(exc).__name__
    result.update(evidence=evidence.calls, thread_id=evidence.thread_id, turn_id=evidence.turn_id,
                  evidence_turn_id=evidence.evidence_turn_id, visual_inputs=evidence.visual_inputs)
    with Session.begin() as session:
        session.add(Audit(actor=principal.user_id, action='event.readonly_assessment',
                          resource=key, details=result))
    return result


class SubscriptionInput(BaseModel):
    project_id: int
    task_id: int
    source: str
    thread_id: str = Field(min_length=1, max_length=255)
    profile: str = Field(default='', max_length=255)


@router.post('/subscriptions')
def create_subscription(body: SubscriptionInput, principal=Depends(require_admin)):
    try:
        with Session.begin() as session:
            # This administrative operation grants an explicit subscription only.
            actor = {'user_id': principal.user_id, 'role': 'admin', 'permissions': ['request'],
                     'project_ids': [body.project_id]}
            result = subscribe(session, **body.model_dump(), actor=actor)
            session.add(Audit(actor=principal.user_id, action='subscription.create', resource=str(result['id']), details=body.model_dump()))
            return result
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from None


@router.delete('/subscriptions/{subscription_id}')
def delete_subscription(subscription_id: int, principal=Depends(require_admin)):
    with Session.begin() as session:
        row = session.get(WorkerSubscription, subscription_id)
        if not row:
            raise HTTPException(404, '订阅不存在')
        row.enabled = False
        session.add(Audit(actor=principal.user_id, action='subscription.cancel', resource=str(row.id), details={}))
        return dump(row)


@router.get('/routing/jobs')
def list_jobs(after: int = 0, limit: int = 50):
    if after < 0 or not 1 <= limit <= 100:
        raise HTTPException(422, '分页参数无效')
    with Session() as session:
        rows = list(session.scalars(select(SemanticRoutingJob).where(SemanticRoutingJob.event_id > after).order_by(SemanticRoutingJob.event_id).limit(limit + 1)))
        from superagent.core.ingestion import trusted_actor
        items = []
        for row in rows[:limit]:
            event = session.get(Event, row.event_id)
            actor = trusted_actor(event.source, str(event.data.get('actor_id', '')))
            project = session.get(Project, row.project_id)
            candidates = session.scalars(select(Task).where(Task.project_id == row.project_id).order_by(Task.id).limit(100))
            tasks = [{'id': t.id, 'title': t.title, 'state_version': t.state_version}
                     for t in candidates if authorized_task(session, t, project, actor)]
            items.append({**dump(row), 'project_id': row.project_id or None,
                          'routing_session_id': f'semantic:{row.event_id}', 'correction_tasks': tasks})
        return {'items': items, 'has_more': len(rows) > limit,
                'next_after': rows[min(len(rows), limit)-1].event_id if rows else after}


class ScheduleInput(BaseModel):
    event_id: int | None = None


@router.post('/routing/schedule')
async def schedule(body: ScheduleInput):
    result = semantic_routing_service.schedule_pending(body.event_id)
    for event_id in result['routed_event_ids']:
        await semantic_routing_service.dispatch(event_id)
    return result


class CorrectionInput(BaseModel):
    decision: dict
    evidence: str = Field(min_length=1, max_length=4000)


@router.post('/routing/jobs/{event_id}/correction')
async def correct(event_id: int, body: CorrectionInput):
    try:
        return await semantic_routing_service.apply_and_dispatch(event_id, body.decision, evidence=body.evidence)
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from None
