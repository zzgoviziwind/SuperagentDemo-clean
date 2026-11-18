"""Event group operations reuse execution authorization and version protections."""
from collections import Counter
from typing import Literal
from fastapi import APIRouter, BackgroundTasks, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import select, update
from superagent.core.db import Session, Task, Event, Project, Approval, dump, now
from superagent.core import governance as gov
from superagent.core.event_groups import group_events, group_view, event_view, outcomes, actionable, visible_message
from superagent.core.event_triage import group_state, no_action_reason, receipt_bundles, receipt_state
from superagent.core.subscriptions import EventTarget, WorkerSubscription
from superagent.core.semantic_routing import SemanticRoutingJob
from superagent.core.sessions import RoutingSession
from superagent.api.sessions import allowed_worker

router = APIRouter(prefix='/api/v1/event-groups', tags=['event-groups'])
INDEX_STATUS_BUCKETS = {
    'needs_action': frozenset({'review', 'attention'}),
    'finished': frozenset({'completed', 'closed'}),
}


@router.get('/index')
def event_index(request: Request, q: str = '', offset: int = 0, limit: int = 30, source: str = '',
                status: str = '', project_id: int | None = None):
    if offset < 0 or not 1 <= limit <= 100:
        raise HTTPException(422, '分页参数无效')
    with Session() as s:
        items = []
        tasks = select(Task).order_by(Task.id.desc())
        if project_id is not None:
            tasks = tasks.where(Task.project_id == project_id)
        for task in s.scalars(tasks):
            if not allowed_worker(s, task, request.state.principal):
                continue
            events = group_events(s, task.id)
            results = outcomes(events)
            group = group_view(s, task, events, results)
            items.append({'key': f'group:{task.id}', 'group': group, 'state': group_state(group),
                'messages': [event_view(e, task.id, results.get(e.id)) for e in events if visible_message(e)]})
        if request.state.principal.role == 'admin' and project_id is None:
            linked = select(EventTarget.event_id)
            receipts = s.scalars(select(Event).where(Event.task_id.is_(None), Event.id.not_in(linked),
                    Event.source.in_(['dingtalk', 'redmine']), Event.external_id.is_not(None))).all()
            for rows in receipt_bundles(receipts):
                states = {receipt_state(row) for row in rows}
                items.append({'key': f'message:{rows[0].id}', 'group': None,
                              'event': {'id': rows[0].id, 'project_id': None, 'worker_id': None,
                                        'project_assessment': rows[0].data.get('project_assessment')},
                              'state': next(state for state in ('triage', 'active', 'closed') if state in states),
                              'messages': [receipt_view(row) for row in rows]})
        if q.strip():
            query = q.strip().casefold()
            items = [item for item in items if query in '\n'.join(
                [(item['group'] or {}).get('title', ''), *[e['content'] for e in item['messages']]]).casefold()]
        if source:
            items = [item for item in items if any(e['source'] == source for e in item['messages'])]
        counts = dict(Counter(item['state'] for item in items))
        if status in INDEX_STATUS_BUCKETS:
            items = [item for item in items if item['state'] in INDEX_STATUS_BUCKETS[status]]
        elif status in {'triage', 'active', 'closed'}:
            items = [item for item in items if item['state'] == status]
        elif status:
            items = [item for item in items if item['state'] == status
                     or (item['group'] or {}).get('processing_status') == status
                     or not item['group'] and any(e['data'].get('routing_status') == status for e in item['messages'])]
        items.sort(key=lambda x: (x['state'] != 'closed', max((e['created_at'] for e in x['messages']),
                                      default=(x['group'] or {}).get('updated_at', '')), x['key']), reverse=True)
        return {'items': items[offset:offset + limit], 'total': len(items), 'counts': counts,
                'has_more': offset + limit < len(items)}


def receipt_view(row):
    state = receipt_state(row)
    reason = row.data.get('routing_reason')
    if state == 'closed' and row.data.get('routing_status') not in {'ignored', 'self_echo', 'dismissed'}:
        reason = no_action_reason(row) or reason
    return {**dump(row), 'state': state, 'triage_reason': reason}


def require_triage_admin(request):
    if request.state.principal.role != 'admin':
        raise HTTPException(403, '仅管理员可处理未分派的来源消息')


@router.get('/triage-options')
def triage_options(request: Request):
    require_triage_admin(request)
    with Session() as s:
        projects = list(s.scalars(select(Project).where(Project.enabled.is_(True),
                                  Project.archived.is_(False)).order_by(Project.name)))
        names = {p.id: p.name for p in projects}
        return {'projects': [{'id': p.id, 'name': p.name} for p in projects],
                'groups': [{'id': t.id, 'title': t.title, 'project': names[t.project_id],
                            'state_version': t.state_version}
                           for t in s.scalars(select(Task).where(Task.project_id.in_(list(names)),
                               Task.status.in_(['queued', 'paused', 'waiting_input', 'review_ready', 'failed']),
                               Task.outcome_unknown.is_(False)).order_by(Task.id.desc()))]}


class Triage(BaseModel):
    action: Literal['close', 'create', 'link']
    event_ids: list[int] = Field(min_length=1, max_length=100)
    project_id: int | None = None
    group_id: int | None = None
    expected_state_version: int | None = None
    title: str = Field(default='', max_length=300)
    goal: str = Field(default='', max_length=20000)
    kind: Literal['analysis', 'repair', 'reply'] = 'analysis'


@router.post('/triage')
def triage(body: Triage, request: Request, background_tasks: BackgroundTasks = None):
    from superagent.connectors.dingtalk import message_attachments
    from superagent.core.connections import schedule_attachments
    from superagent.core.ingestion import EventAttachmentJob
    require_triage_admin(request)
    principal = request.state.principal
    ids = sorted(set(body.event_ids))
    downloads = []
    with Session.begin() as s:
        # The semantic router claims a job before reading its receipt. Use the same lock order.
        s.execute(update(SemanticRoutingJob).where(SemanticRoutingJob.event_id.in_(ids))
                  .values(updated_at=SemanticRoutingJob.updated_at))
        s.execute(update(Event).where(Event.id.in_(ids)).values(content=Event.content))
        rows = list(s.scalars(select(Event).where(Event.id.in_(ids)).order_by(Event.id)))
        linked = s.scalar(select(EventTarget.id).where(EventTarget.event_id.in_(ids)).limit(1))
        if len(rows) != len(ids) or linked is not None or any(row.task_id is not None or not row.external_id
                or row.source not in {'dingtalk', 'redmine'} for row in rows):
            raise HTTPException(409, '所选消息已关联或不可处理，请刷新事件')
        jobs = list(s.scalars(select(SemanticRoutingJob).where(SemanticRoutingJob.event_id.in_(ids))))
        if any(job.status == 'running' for job in jobs):
            raise HTTPException(409, '正在识别所选消息，请稍后刷新')
        if body.action != 'close' and any(
                (e.data.get('metadata') or {}).get('self_authored') or
                e.data.get('routing_status') in {'self_echo', 'self_echo_candidate'}
                                         for e in rows):
            raise HTTPException(409, '本账号发言和渠道回声不能作为新的处理来源')
        task = None
        if body.action == 'create':
            gov.require_permission(principal, 'task.create')
            project = s.get(Project, body.project_id) if body.project_id else None
            if not project or not project.enabled or project.archived:
                raise HTTPException(422, '请选择可用项目')
            if not body.title.strip() or not body.goal.strip():
                raise HTTPException(422, '请填写事件名称和处理要求')
            task = Task(title=body.title.strip(), goal=body.goal.strip(), project_id=project.id,
                        owner_id=principal.user_id, kind=body.kind, source='web')
            s.add(task)
            s.flush()
            gov.assign_task_owner(task.id, principal.user_id, actor=principal.user_id, session=s)
        elif body.action == 'link':
            if body.group_id is None or body.expected_state_version is None:
                raise HTTPException(422, '请选择要关联的已有事件')
            task = owned(s, body.group_id, request)
            project = s.get(Project, task.project_id)
            if (not project or not project.enabled or project.archived or task.status not in
                    {'queued', 'paused', 'waiting_input', 'review_ready', 'failed'}):
                raise HTTPException(409, '请选择可补充消息的事件，执行中的事件请先暂停')
            version(s, task, body.expected_state_version)
            task.revision += 1
            task.control_version += 1
            if task.status == 'review_ready':
                task.status, task.last_error = 'waiting_input', '收到人工关联的消息，请确认后继续'
            s.execute(update(Approval).where(Approval.task_id == task.id, Approval.status == 'pending')
                      .values(status='expired'))
        for row in rows:
            data = row.data
            row.data = {**data, 'routing_status': 'manually_linked' if task else 'dismissed',
                        'routing_reason': 'linked_manually' if task else 'closed_manually',
                        'triage_actor': principal.user_id, 'triaged_at': now()}
            if task:
                row.task_id = task.id
                # Append an input now so resumed workers see even an old receipt after
                # their previous input cursor. Keep the original receipt and exclude the copy from the timeline.
                message = Event(task_id=task.id, source=row.source, event_type='message', content=row.content,
                                data={'source_event_id': row.id, 'routing_status': 'manually_linked',
                                      'actor': principal.user_id})
                s.add(message)
                s.flush()
                s.add(EventTarget(event_id=row.id, task_id=task.id, message_event_id=message.id))
                meta = data.get('metadata') or {}
                if row.source == 'dingtalk' and meta.get('profile') and meta.get('message_id') and data.get('thread_id'):
                    attachments = message_attachments(row.content, data.get('attachments'))
                    if attachments:
                        row.data = {**row.data, 'attachments': attachments, 'attachments_status': 'pending'}
                        s.add(EventAttachmentJob(event_id=row.id, task_id=task.id,
                                                 revision=task.revision, control_version=task.control_version))
                        if task.status == 'queued':
                            task.status, task.last_error = 'waiting_resource', '正在准备来源附件'
                        downloads.append(dump(row))
            gov.audit_action(s, principal, 'event.triage.' + body.action, row.id,
                             {'task_id': row.task_id, 'source': row.source, 'external_id': row.external_id,
                              'status': row.data['routing_status']})
        for job in jobs:
            if job.status == 'queued':
                job.status = 'closed'
                conversation = s.get(RoutingSession, job.event_id)
                if conversation:
                    conversation.status = 'idle'
                    conversation.state_version += 1
        s.flush()
        if task:
            events = group_events(s, task.id)
            results = outcomes(events)
            group = group_view(s, task, events, results)
            result = {'key': f'group:{task.id}', 'group': group, 'state': group_state(group),
                      'messages': [event_view(e, task.id, results.get(e.id)) for e in events if visible_message(e)]}
        else:
            result = {'messages': [receipt_view(row) for row in rows]}
    async def dispatch_downloads():
        for receipt in downloads:
            schedule_attachments(receipt, session_factory=Session)
    if downloads and background_tasks is not None:
        background_tasks.add_task(dispatch_downloads)
    return result


class Rename(BaseModel):
    title: str = Field(min_length=1, max_length=300)
    expected_state_version: int


@router.post('/{ident}/rename')
def rename(ident: int, body: Rename, request: Request):
    if not body.title.strip():
        raise HTTPException(422, '事件名称不能为空')
    with Session.begin() as s:
        task = owned(s, ident, request)
        gov.require_permission(request.state.principal, 'task.message', gov.task_owner(ident, s))
        old = task.title
        result = s.execute(update(Task).where(Task.id == ident, Task.state_version == body.expected_state_version)
            .values(title=body.title.strip(), state_version=Task.state_version + 1, updated_at=now()))
        if result.rowcount != 1:
            raise HTTPException(409, '事件已变化，请刷新后重命名')
        s.add(Event(task_id=ident, source='web', event_type='group_renamed', content=body.title.strip(),
                    data={'previous_title': old, 'actor': request.state.principal.user_id}))
        s.refresh(task)
        return dump(task)


def owned(s, ident, request):
    task = s.get(Task, ident)
    if not task or not allowed_worker(s, task, request.state.principal):
        raise HTTPException(404, '事件组不存在')
    return task


def version(s, task, expected):
    if task.outcome_unknown:
        raise HTTPException(409, '执行结果未知，请先核验')
    changed = s.execute(update(Task).where(Task.id == task.id, Task.state_version == expected)
                        .values(state_version=expected + 1, updated_at=now()))
    if changed.rowcount != 1:
        raise HTTPException(409, '事件组已变化，请刷新')
    s.refresh(task)


@router.get('')
def groups(request: Request):
    with Session() as s:
        return [group_view(s, t) for t in s.scalars(select(Task).order_by(Task.id.desc()))
                if allowed_worker(s, t, request.state.principal)]


@router.post('/{ident}/sync-own-dingtalk')
async def sync_own_dingtalk(ident: int, request: Request):
    """Import this account's messages from the specific private chat already linked."""
    from datetime import datetime, timezone
    from superagent.connectors.common import ConnectorError
    from superagent.connectors.dingtalk import normalize_event
    from superagent.connectors.history import read_own_direct_messages
    from superagent.core.connections import get_config, history_timezone
    from superagent.core.ingestion import ingest_event
    from superagent.core.message_context import time_key

    if request.state.principal.role != 'admin':
        raise HTTPException(403, '仅管理员可从已连接钉钉同步消息')
    config = get_config('connectors.dingtalk', {})
    if not all(config.get(key) for key in ('executable', 'profile', 'self_ids')):
        raise HTTPException(409, '未配置钉钉账号')
    with Session() as s:
        owned(s, ident, request)
        receipts = [e for e in group_events(s, ident) if e.source == 'dingtalk'
                    and e.data.get('routing_status') in {'routed', 'manually_linked'}
                    and e.data.get('metadata', {}).get('conversation_type') == 'direct'
                    and e.data['metadata'].get('profile') == config['profile']
                    and e.data['metadata'].get('message_id') and e.data.get('occurred_at')
                    and e.data.get('thread_id') and e.data.get('actor_id')]
        if len({(e.data['thread_id'], e.data['actor_id']) for e in receipts}) != 1:
            raise HTTPException(409, '此事件没有唯一且可核对的钉钉私聊')
        anchor = min(receipts, key=time_key)
        data = anchor.data
    history = config.get('history') or {}
    tz = history_timezone(history['history_timezone']) if history.get('history_timezone') else datetime.now().astimezone().tzinfo or timezone.utc
    try:
        rows = await read_own_direct_messages(
            config['executable'], profile=config['profile'], peer=data['actor_id'],
            conversation=data['thread_id'], anchor_id=data['metadata']['message_id'],
            since=data['occurred_at'], self_ids=config['self_ids'], history_timezone=tz,
            sender_map=history.get('sender_map'))
        linked = 0
        for row in rows:
            receipt = ingest_event(normalize_event(row, profile=config['profile'], self_ids=config['self_ids']))
            if receipt['task_id'] == ident and not receipt['duplicate']:
                linked += 1
    except (ConnectorError, TimeoutError, ValueError) as exc:
        raise HTTPException(409, '未能完整核对原钉钉会话，请稍后重试或手动补充') from exc
    return {'added': linked}


@router.get('/{ident}')
def detail(ident: int, request: Request):
    with Session() as s:
        task = owned(s, ident, request)
        events = group_events(s, ident)
        results = outcomes(events)
        return {'group': group_view(s, task),
                'events': [event_view(e, ident, results.get(e.id)) for e in events],
                'following': [dump(x) for x in s.scalars(select(WorkerSubscription).where(
                    WorkerSubscription.task_id == ident))]}


class Resolution(BaseModel):
    status: Literal['resolved', 'dismissed', 'pending']
    evidence: str = Field(min_length=1, max_length=10000)
    expected_state_version: int


@router.post('/{ident}/events/{event_id}/resolution')
def resolve(ident: int, event_id: int, body: Resolution, request: Request):
    if not body.evidence.strip():
        raise HTTPException(422, '请填写处理依据')
    with Session.begin() as s:
        task = owned(s, ident, request)
        row = next((e for e in group_events(s, ident) if e.id == event_id), None)
        if row is None or not actionable(row):
            raise HTTPException(404, '事件不属于当前事件组')
        version(s, task, body.expected_state_version)
        outcome = {'status': body.status, 'evidence': body.evidence,
                   'actor': request.state.principal.user_id, 'at': now()}
        s.add(Event(task_id=ident, source='web', event_type='event_resolution', content=body.evidence,
                    data={'event_id': event_id, **outcome}))
        return event_view(row, ident, outcome)


class Delegate(BaseModel):
    goal: str = Field(min_length=1, max_length=20000)
    expected_state_version: int
    request_key: str = Field(min_length=1, max_length=100)
    kind: Literal['analysis', 'repair'] = 'analysis'


@router.post('/{ident}/delegations')
def delegate(ident: int, body: Delegate, request: Request):
    if not body.goal.strip():
        raise HTTPException(422, '请填写协作目标')
    with Session.begin() as s:
        parent = owned(s, ident, request)
        key = f'{ident}:{body.request_key}'
        old = s.scalar(select(Event).where(Event.source == 'coordination', Event.external_id == key))
        if old:
            if old.data['request'] != body.model_dump():
                raise HTTPException(409, '请求键已用于其他内容')
            return dump(old)
        if parent.status in {'completed', 'cancelled'}:
            raise HTTPException(409, '已结束的事件组不能委派')
        project = s.get(Project, parent.project_id)
        if not project or not project.enabled:
            raise HTTPException(409, '项目已禁用')
        gov.require_permission(request.state.principal, 'task.create')
        version(s, parent, body.expected_state_version)
        child = Task(project_id=parent.project_id, owner_id=gov.task_owner(ident, s),
                     title=f'协作：{body.goal[:100]}', goal=body.goal, kind=body.kind,
                     acceptance_criteria='返回证据与未完成事项，由主 Worker 汇总核验。')
        s.add(child); s.flush()
        s.add(Event(task_id=child.id, source='web', event_type='created', content=body.goal,
                    data={'parent_group_id': ident}))
        row = Event(task_id=ident, source='coordination', external_id=key,
                    event_type='collaboration_requested', content=body.goal,
                    data={'child_group_id': child.id, 'request': body.model_dump(), 'status': 'pending'})
        s.add(row); s.flush()
        return dump(row)


class Follow(BaseModel):
    enabled: bool
    expected_state_version: int


@router.post('/{ident}/following/{subscription_id}')
def follow(ident: int, subscription_id: int, body: Follow, request: Request):
    with Session.begin() as s:
        task = owned(s, ident, request)
        row = s.get(WorkerSubscription, subscription_id)
        if not row or row.task_id != ident:
            raise HTTPException(404, '跟进关系不存在')
        if body.enabled and task.status in {'completed', 'cancelled'}:
            raise HTTPException(409, '事件组已结束')
        version(s, task, body.expected_state_version)
        row.enabled = body.enabled
        s.add(Event(task_id=ident, source='web', event_type='following_changed',
                    data={'subscription_id': row.id, 'enabled': row.enabled},
                    content='恢复持续跟进' if row.enabled else '停止持续跟进'))
        return dump(row)
