"""Bounded, attributed evidence shared by reply and execution workers."""
from datetime import datetime, timedelta

from sqlalchemy import select
from superagent.connectors.common import timestamp

from . import db
from .event_groups import group_events, visible_message


def message_time(event):
    try:
        return timestamp(event.data.get('occurred_at') or event.created_at)
    except (ValueError, TypeError, OverflowError):
        return event.created_at


def time_key(event):
    try:
        return datetime.fromisoformat(message_time(event)).timestamp()
    except (ValueError, TypeError, OverflowError):
        return datetime.fromisoformat(event.created_at).timestamp()


def describe_message(event):
    meta = event.data.get('metadata') or {}
    return {
        'event_id': event.id, 'source': event.source, 'time': message_time(event),
        'sender': meta.get('sender_name') or event.data.get('actor_id') or event.data.get('actor') or
        ('SuperAgent' if event.source in {'runtime', 'coordination'} else 'operator'),
        'sender_id': event.data.get('actor_id') or event.data.get('actor'),
        'direction': 'own_account' if meta.get('self_authored') else
        'received' if event.external_id else 'local',
        'content': event.content[:3000],
    }


def attach_self_message(session, event):
    """Context only. Explicit quote wins; infer only a unique recent private event."""
    data = event.data
    meta = data['metadata']
    event.data = {**data, 'routing_status': 'ignored', 'routing_reason': 'self_context_unmatched'}
    if not data.get('thread_id') or not meta.get('profile') or meta.get('needs_confirmation'):
        return
    quote = meta.get('reply_to_message_id')
    rows = select(db.Event).join(db.Task, db.Task.id == db.Event.task_id).where(
        db.Event.id != event.id, db.Event.source == 'dingtalk',
        db.Event.data['thread_id'].as_string() == data['thread_id'],
        db.Event.data['metadata']['profile'].as_string() == meta['profile'],
        db.Event.data['routing_status'].as_string().in_(['routed', 'manually_linked', 'self_context']),
    )
    if quote:
        rows = rows.where(db.Event.data['metadata']['message_id'].as_string() == quote)
    elif meta.get('conversation_type') == 'direct':
        if not data.get('occurred_at'):
            return
        try:
            end = datetime.fromisoformat(data['occurred_at'])
            if end.tzinfo is None:
                return
            start = end - timedelta(minutes=30)
        except (ValueError, TypeError):
            return
        occurred = db.Event.data['occurred_at'].as_string()
        rows = rows.where(db.Event.data['metadata']['conversation_type'].as_string() == 'direct',
                          db.Event.data['routing_status'].as_string() != 'self_context',
                          occurred >= timestamp(start), occurred <= timestamp(end))
    else:
        return
    ids = set(session.scalars(rows.with_only_columns(db.Event.task_id).distinct().limit(2)))
    if len(ids) == 1:
        event.task_id = ids.pop()
        event.data = {**data, 'routing_status': 'self_context'}


def timeline(session, task_id, limit=24):
    rows = [row for row in group_events(session, task_id) if visible_message(row)]
    rows.sort(key=lambda row: (time_key(row), row.id))
    return rows if limit is None else rows[-limit:]


def scoped_timeline(session, task):
    """Restrict historical context to this project's current task scope."""
    from .governance import task_owner

    rebound = session.scalar(select(db.Event).where(
        db.Event.task_id == task.id, db.Event.event_type == 'project_rebound',
    ).order_by(db.Event.id.desc()).limit(1))
    owner = task_owner(task.id, session)
    permitted = {None: True, task.id: True}
    rows = []
    for row in timeline(session, task.id, limit=None):
        if rebound and row.id < rebound.id:
            continue
        if row.task_id not in permitted:
            origin = session.get(db.Task, row.task_id)
            permitted[row.task_id] = bool(origin and origin.project_id == task.project_id and
                                          owner and task_owner(row.task_id, session) == owner)
        if permitted[row.task_id]:
            rows.append(row)
    return rows, rebound


def active_decisions(session, task, event_ids):
    rows = session.scalars(select(db.Decision).where(
        db.Decision.project_id == task.project_id, db.Decision.status == 'active',
        (db.Decision.task_id.is_(None)) | (db.Decision.task_id == task.id),
    ).order_by((db.Decision.kind == 'constraint').desc(), db.Decision.id))
    return [row for row in rows if row.event_id is None or row.event_id in event_ids]


def _audience(session, task):
    return {
        (e.source, e.data['thread_id'], (e.data.get('metadata') or {}).get('profile'), e.data['actor_id'])
        for e in group_events(session, task.id)
        if e.source in {'dingtalk', 'redmine'} and e.data.get('thread_id') and e.data.get('actor_id')
        and not (e.data.get('metadata') or {}).get('self_authored')
    }


def recent_work(session, task, *, summary_limit=1500, include_summary_id=False):
    """Only share prior work with the same project, owner and external audience."""

    from .governance import task_owner
    owner = task_owner(task.id, session)
    if not owner:
        return []
    candidates = session.scalars(select(db.Task).where(
        db.Task.project_id == task.project_id, db.Task.id != task.id,
        db.Task.owner_id == owner, db.Task.outcome_unknown.is_(False),
    ).order_by(db.Task.updated_at.desc(), db.Task.id.desc()).limit(12))
    audience = _audience(session, task)
    if task.source in {'dingtalk', 'redmine'} and not audience:
        return []
    work = []
    for previous in candidates:
        if task_owner(previous.id, session) != owner or _audience(session, previous) != audience:
            continue
        if audience and session.scalar(select(db.Event.id).where(db.Event.task_id == previous.id,
                                         db.Event.source == 'field').limit(1)):
            continue
        result = session.scalar(select(db.Artifact).where(
            db.Artifact.task_id == previous.id, db.Artifact.revision == previous.revision,
            db.Artifact.kind == 'summary',
        ).order_by(db.Artifact.id.desc()))
        item = {'task_id': previous.id, 'title': previous.title, 'status': previous.status,
                'updated_at': previous.updated_at, 'summary': result.content[:summary_limit] if result else None}
        if include_summary_id:
            item['summary_id'] = result.id if result else None
        work.append(item)
        if len(work) == 4:
            break
    return work
