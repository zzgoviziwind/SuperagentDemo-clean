"""Explicit project-scoped thread subscriptions and durable per-target delivery."""
from sqlalchemy import Integer, String, UniqueConstraint, select, update
from sqlalchemy.orm import Mapped, mapped_column

from .db import Base, Event, Task, Project, Approval, now, dump
from superagent.connectors.common import digest


class WorkerSubscription(Base):
    __tablename__ = 'worker_subscriptions'
    __table_args__ = (UniqueConstraint('project_id', 'thread_key', 'task_id'),)
    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(Integer, index=True)
    source: Mapped[str] = mapped_column(String(40))
    thread_key: Mapped[str] = mapped_column(String(64))
    thread_id: Mapped[str] = mapped_column(String(255))
    profile: Mapped[str] = mapped_column(String(255), default='')
    task_id: Mapped[int] = mapped_column(Integer)
    enabled: Mapped[bool] = mapped_column(default=True)
    created_at: Mapped[str] = mapped_column(String(40), default=now)


class EventTarget(Base):
    __tablename__ = 'event_targets'
    __table_args__ = (UniqueConstraint('event_id', 'task_id'),)
    id: Mapped[int] = mapped_column(primary_key=True)
    event_id: Mapped[int] = mapped_column(Integer, index=True)
    task_id: Mapped[int] = mapped_column(Integer, index=True)
    subscription_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    message_event_id: Mapped[int] = mapped_column(Integer)
    created_at: Mapped[str] = mapped_column(String(40), default=now)


def thread_key(source, thread_id, profile=''):
    return digest({'source': source, 'thread_id': thread_id, 'profile': profile})


def authorized_task(session, task, project, actor):
    from .governance import task_owner
    return bool(task and project and project.enabled and task.project_id == project.id
                and task.status not in {'completed', 'cancelled'} and not task.outcome_unknown
                and actor and actor.get('enabled', True)
                and actor.get('role') in {'admin', 'member'}
                and str(project.id) in {str(i) for i in actor.get('project_ids', [])}
                and 'request' in actor.get('permissions', [])
                and (actor.get('role') == 'admin' or task_owner(task.id, session) == actor.get('user_id')))


def subscribe(session, *, project_id, source, thread_id, task_id, actor, profile=''):
    if source not in {'dingtalk', 'redmine'} or not isinstance(thread_id, str) or not thread_id.strip() or len(thread_id) > 255 or len(profile) > 255:
        raise ValueError('订阅来源或线程无效')
    project, task = session.get(Project, project_id), session.get(Task, task_id)
    if not authorized_task(session, task, project, actor):
        raise ValueError('目标任务不可订阅或身份无权限')
    if source == 'dingtalk' and thread_id not in {str(i) for i in project.dingtalk_chat_ids}:
        raise ValueError('线程未绑定当前项目')
    key = thread_key(source, thread_id, profile)
    row = session.scalar(select(WorkerSubscription).where(WorkerSubscription.project_id == project_id,
        WorkerSubscription.thread_key == key, WorkerSubscription.task_id == task_id))
    if row:
        row.enabled = True
    else:
        row = WorkerSubscription(project_id=project_id, source=source, thread_id=thread_id,
            thread_key=key, profile=profile, task_id=task_id)
        session.add(row)
    session.flush()
    return dump(row)


def deliver_target(session, event, task, actor, subscription_id=None):
    """One canonical worker message per source event/target, in the receipt transaction."""
    existing = session.scalar(select(EventTarget).where(EventTarget.event_id == event.id, EventTarget.task_id == task.id))
    if existing:
        return existing
    requires_interrupt = task.status in {'running', 'waiting_approval'}
    version = task.state_version
    values = dict(state_version=version + 1, revision=task.revision + 1,
        control_version=task.control_version + 1, updated_at=now())
    if task.status in {'running', 'waiting_approval', 'review_ready'}:
        values.update(status='waiting_input', last_error='收到订阅事件，请确认后继续')
    changed = session.execute(update(Task).where(Task.id == task.id, Task.state_version == version,
        Task.status.notin_(['completed', 'cancelled']), Task.outcome_unknown == False).values(**values))
    if changed.rowcount != 1:
        raise ValueError('目标任务版本已变化')
    session.execute(update(Approval).where(Approval.task_id == task.id, Approval.status == 'pending').values(status='expired'))
    message = Event(task_id=task.id, source=event.source, event_type='message', content=event.content,
        data={**{k: v for k, v in event.data.items() if not k.startswith('_')},
              'source_event_id': event.id, 'subscription_id': subscription_id, 'actor': actor['user_id'],
              'routing_status': 'delivered',
              'requires_interrupt': requires_interrupt})
    session.add(message)
    session.flush()
    if event.data.get('attachments'):
        from .ingestion import EventAttachmentJob
        session.add(EventAttachmentJob(event_id=message.id, task_id=task.id,
            revision=task.revision, control_version=task.control_version))
        message.data = {**message.data, 'attachments_status': 'pending'}
        if task.status == 'queued':
            task.status, task.last_error = 'waiting_resource', '正在准备来源附件'
    target = EventTarget(event_id=event.id, task_id=task.id,
        subscription_id=subscription_id, message_event_id=message.id)
    session.add(target)
    session.flush()
    return target


def fanout(session, event, project, actor):
    thread = event.data.get('thread_id')
    if not thread:
        return []
    key = thread_key(event.source, str(thread), event.data.get('metadata', {}).get('profile', ''))
    rows = list(session.scalars(select(WorkerSubscription).where(WorkerSubscription.project_id == project.id,
        WorkerSubscription.thread_key == key, WorkerSubscription.enabled == True).order_by(WorkerSubscription.id)))
    targets = []
    for row in rows:
        task = session.get(Task, row.task_id)
        from .event_rules import blocks_processing
        if task and blocks_processing(session, event, project.id, task.kind):
            continue
        if authorized_task(session, task, project, actor):
            targets.append(deliver_target(session, event, task, actor, row.id))
    return targets
