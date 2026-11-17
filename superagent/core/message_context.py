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
    return sorted(rows, key=lambda row: (time_key(row), row.id))[-limit:]


def _audience(session, task):
    return {
        (e.source, e.data['thread_id'], (e.data.get('metadata') or {}).get('profile'), e.data['actor_id'])
        for e in group_events(session, task.id)
        if e.source in {'dingtalk', 'redmine'} and e.data.get('thread_id') and e.data.get('actor_id')
        and not (e.data.get('metadata') or {}).get('self_authored')
    }


def recent_work(session, task):
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
        result = session.scalar(select(db.Artifact).where(
            db.Artifact.task_id == previous.id, db.Artifact.revision == previous.revision,
            db.Artifact.kind == 'summary',
        ).order_by(db.Artifact.id.desc()))
        work.append({'task_id': previous.id, 'title': previous.title, 'status': previous.status,
                     'updated_at': previous.updated_at, 'summary': result.content[:1500] if result else None})
        if len(work) == 4:
            break
    return work
