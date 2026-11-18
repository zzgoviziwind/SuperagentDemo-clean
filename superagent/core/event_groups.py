"""Event-centred projections over durable execution records.

Task remains the internal execution aggregate; receipts retain independent outcomes.
No execution completion is inferred to mean every source event was resolved.
"""
from sqlalchemy import select, update
from .db import Event, Task, Artifact, Approval, dump
from .subscriptions import EventTarget


def group_events(session, group_id):
    targets = select(EventTarget.event_id).where(EventTarget.task_id == group_id)
    rows = session.scalars(select(Event).where(
        (Event.id.in_(targets)) | (Event.task_id == group_id)
    ).order_by(Event.id)).all()
    # Canonical delivery copies are represented by their original receipt.
    return [row for row in rows if not row.data.get('source_event_id')
            or row.source not in {'dingtalk', 'redmine'}]


def visible_message(row):
    return (row.external_id is not None and row.source in {'dingtalk', 'redmine'}) or (
        row.event_type in {'created', 'message', 'goal_changed', 'collaboration_result', 'project_rebound'}
        and row.source in {'web', 'coordination'})


def actionable(row):
    return (visible_message(row) and row.data.get('routing_status') != 'self_context'
            and not (row.source == 'web' and row.event_type in {'message', 'goal_changed', 'project_rebound'}))


def outcomes(events):
    return {e.data['event_id']: e.data for e in events
            if e.event_type == 'event_resolution' and 'event_id' in e.data}


def event_view(row, group_id, outcome=None):
    outcome = outcome or row.data.get('group_outcomes', {}).get(str(group_id))
    return {**dump(row), 'requires_resolution': actionable(row), 'visible_message': visible_message(row),
            'processing': outcome or {'status': 'pending', 'evidence': ''}}


def group_view(session, task, events=None, results=None):
    events = group_events(session, task.id) if events is None else events
    results = outcomes(events) if results is None else results
    pending = sum(actionable(e) and results.get(e.id, e.data.get('group_outcomes', {}).get(str(task.id), {})).get('status')
                  not in {'resolved', 'dismissed'} for e in events)
    status = ('needs_review' if task.status == 'completed' and pending else task.status)
    reply_decision = next((e.data['decision'] for e in reversed(events)
        if e.event_type == 'reply_decision' and e.source == 'runtime'
        and e.data.get('revision') == task.revision and e.data.get('control_version') == task.control_version), None)
    if task.kind == 'reply' and task.status == 'review_ready' and not task.outcome_unknown:
        if any(e.event_type == 'reply_sent' and e.source == 'runtime' and e.data.get('revision') == task.revision
               and e.data.get('control_version') == task.control_version for e in events):
            status = 'reply_sent'
        elif reply_decision == 'skip':
            status = 'reply_skipped'
    return {**dump(task), 'worker_id': f'worker:{task.id}', 'event_count': len(events),
            'pending_event_count': pending, 'processing_status': status, 'reply_decision': reply_decision}


def collect_collaboration_results(session):
    """Emit once after a child settles; never steer an active or unknown parent."""
    for request in session.scalars(select(Event).where(Event.event_type == 'collaboration_requested')):
        if request.data.get('status') != 'pending':
            continue
        child = session.get(Task, request.data['child_group_id'])
        parent = session.get(Task, request.task_id)
        if not child or not parent or child.outcome_unknown or child.status not in {
            'review_ready', 'completed', 'failed', 'cancelled', 'waiting_input'}:
            continue
        if parent.outcome_unknown or parent.status in {'running', 'waiting_approval', 'waiting_resource'}:
            continue
        summary = session.scalar(select(Artifact).where(Artifact.task_id == child.id,
            Artifact.revision == child.revision, Artifact.kind == 'summary').order_by(Artifact.id.desc()))
        if child.status == 'waiting_input' and not summary:
            continue
        claimed = session.execute(update(Task).where(Task.id == parent.id,
            Task.state_version == parent.state_version).values(state_version=parent.state_version + 1))
        if claimed.rowcount != 1:
            continue
        session.refresh(parent)
        content = f'协作 Worker #{child.id} 返回，状态 {child.status}。\n' + (
            summary.content if summary else child.last_error or '暂无结果正文，请核验协作记录。')
        session.add(Event(task_id=parent.id, source='coordination', event_type='collaboration_result',
            content=content, data={'child_group_id': child.id, 'request_event_id': request.id,
                                  'artifact_id': summary.id if summary else None}))
        request.data = {**request.data, 'status': 'returned'}
        if parent.status not in {'completed', 'cancelled', 'paused'}:
            parent.status = 'queued'
            parent.revision += 1
            parent.control_version += 1
            for approval in session.scalars(select(Approval).where(Approval.task_id == parent.id,
                                                                     Approval.status == 'pending')):
                approval.status = 'expired'


def collect_worker_requests(session):
    """Accept bounded, read-only collaboration requests from saved Worker reports.

Children cannot delegate recursively; report text is never an execution command.
"""
    import json
    for parent in session.scalars(select(Task).where(Task.status.in_(['review_ready', 'waiting_input']))):
        if parent.outcome_unknown:
            continue
        origin = session.scalar(select(Event).where(Event.task_id == parent.id, Event.event_type == 'created'))
        if origin and origin.data.get('parent_group_id'):
            continue
        previous = list(session.scalars(select(Event).where(Event.task_id == parent.id,
                                                           Event.event_type == 'collaboration_requested')))
        if len(previous) >= 3:
            continue
        report = session.scalar(select(Artifact).where(Artifact.task_id == parent.id,
            Artifact.revision == parent.revision, Artifact.kind == 'summary').order_by(Artifact.id.desc()))
        if not report or any(e.data.get('report_id') == report.id for e in previous):
            continue
        try:
            parsed = json.loads(report.content)
            requests = parsed.get('collaboration_requests', []) if isinstance(parsed, dict) else []
        except (ValueError, TypeError):
            continue
        if not isinstance(requests, list):
            continue
        requests = [item for item in requests[:3 - len(previous)] if isinstance(item, dict)
                    and isinstance(item.get('goal'), str) and item['goal'].strip()]
        if not requests:
            continue
        claimed = session.execute(update(Task).where(Task.id == parent.id,
            Task.state_version == parent.state_version).values(state_version=parent.state_version + 1))
        if claimed.rowcount != 1:
            continue
        session.refresh(parent)
        for item in requests[:3 - len(previous)]:
            if not isinstance(item, dict) or not isinstance(item.get('goal'), str) or not item['goal'].strip():
                continue
            goal = item['goal'][:20000]
            child = Task(project_id=parent.project_id, owner_id=parent.owner_id,
                         title='协作：' + goal[:100], goal=goal, kind='analysis',
                         acceptance_criteria='只读调查，返回证据及未完成事项，由主 Worker 汇总。')
            session.add(child); session.flush()
            session.add(Event(task_id=child.id, source='web', event_type='created', content=goal,
                              data={'parent_group_id': parent.id}))
            session.add(Event(task_id=parent.id, source='coordination', event_type='collaboration_requested',
                              content=goal, data={'child_group_id': child.id, 'status': 'pending',
                                                  'report_id': report.id, 'requested_by': 'worker'}))
            parent.status = 'waiting_input'
            parent.state_version += 1
