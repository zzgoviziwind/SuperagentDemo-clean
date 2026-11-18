"""Durable ownership of Worker executions and controller startup recovery."""

import asyncio
import logging
import os
import uuid
from contextvars import ContextVar
from datetime import datetime, timedelta, timezone
from pathlib import Path

from sqlalchemy import exists, func, or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import object_session

from . import db

ACTIVE = db.ACTIVE_ATTEMPT_STATUSES
WORKER_APPROVALS = ('item/commandExecution/requestApproval', 'item/fileChange/requestApproval')
STOPPING = '正在停止执行'
UNKNOWN_STOP = '停止未确认，运行结果未知，需人工对账'
STARTUP_UNKNOWN = '服务重启，运行结果未知，请人工对账'
current_attempt = ContextVar('worker_execution_attempt', default=None)


def enabled():
    return os.getenv('SUPERAGENT_EXECUTION_MODE', 'legacy') == 'attempt'


class OwnershipLost(RuntimeError):
    pass


def advance_task(session, task, **values):
    """Apply a Worker state change behind the same version check as the HTTP API."""
    version = task.state_version
    result = session.execute(
        update(db.Task).where(db.Task.id == task.id, db.Task.state_version == version)
        .values(**values, state_version=version + 1, updated_at=db.now())
    )
    if result.rowcount != 1:
        raise OwnershipLost('任务状态已变化')


def bump(task, **values):
    if current_attempt.get():
        advance_task(object_session(task), task, **values)
    else:
        for key, value in values.items():
            setattr(task, key, value)
        task.state_version += 1
        task.updated_at = db.now()


def claim_task(task_id, owner, *, sessions=None, lease=None):
    sessions = sessions or db.Session
    attempt_id = str(uuid.uuid4())
    with sessions.begin() as session:
        if lease:
            lease.check(session)
        active = exists().where(db.ExecutionAttempt.task_id == task_id,
                                db.ExecutionAttempt.status.in_(ACTIVE))
        changed = session.execute(
            update(db.Task).where(db.Task.id == task_id, db.Task.status == 'queued',
                                  db.Task.outcome_unknown.is_(False), ~active)
            .values(status='running', last_error=None, codex_turn_id=None, updated_at=db.now(),
                    state_version=db.Task.state_version + 1)
        )
        if changed.rowcount != 1:
            return None
        task = session.get(db.Task, task_id)
        last = session.scalar(select(func.max(db.ExecutionAttempt.attempt_no))
                              .where(db.ExecutionAttempt.task_id == task_id)) or 0
        session.add(db.ExecutionAttempt(id=attempt_id, task_id=task_id, owner=owner,
                                       attempt_no=last + 1, status='claimed', phase='claimed',
                                       revision=task.revision, control_version=task.control_version))
    return attempt_id


def begin_attempt(session, task_id, attempt_id, owner):
    current_task = exists().where(
        db.Task.id == task_id, db.Task.id == db.ExecutionAttempt.task_id,
        db.Task.status == 'running', db.Task.outcome_unknown.is_(False),
        db.Task.revision == db.ExecutionAttempt.revision,
        db.Task.control_version == db.ExecutionAttempt.control_version,
    )
    result = session.execute(
        update(db.ExecutionAttempt)
        .where(db.ExecutionAttempt.id == attempt_id, db.ExecutionAttempt.owner == owner,
               db.ExecutionAttempt.task_id == task_id, db.ExecutionAttempt.status == 'claimed', current_task)
        .values(status='running', started_at=db.now(), updated_at=db.now())
    )
    return result.rowcount == 1


def set_attempt(session, attempt_id, owner, *, from_statuses=ACTIVE, **values):
    if attempt_id is None:
        return True
    changed = session.execute(
        update(db.ExecutionAttempt)
        .where(db.ExecutionAttempt.id == attempt_id, db.ExecutionAttempt.owner == owner,
               db.ExecutionAttempt.status.in_(from_statuses))
        .values(**values, updated_at=db.now())
    )
    return changed.rowcount == 1


def finish_attempt(session, attempt_id, owner, status, error=None, *, from_statuses=ACTIVE):
    values = {'status': status, 'last_error': error, 'ended_at': db.now()}
    if status == 'completed':
        values['phase'] = 'done'
    return set_attempt(session, attempt_id, owner, from_statuses=from_statuses, **values)


def expire_worker_approvals(session, task_id, status, states=('pending', 'dispatching')):
    result = session.execute(update(db.Approval).where(
        db.Approval.task_id == task_id, db.Approval.status.in_(states),
        db.Approval.action['method'].as_string().in_(WORKER_APPROVALS),
    ).values(status=status))
    return result.rowcount


def recover_startup(session):
    counts = dict(abandoned=0, unknown=0, legacy_unknown=0, approvals_expired=0)
    attempts = session.scalars(select(db.ExecutionAttempt).where(db.ExecutionAttempt.status.in_(ACTIVE))).all()
    recovered_ids = set()
    for attempt in attempts:
        task = session.get(db.Task, attempt.task_id)
        recovered_ids.add(attempt.task_id)
        safe = (attempt.turn_id is None and attempt.phase in ('claimed', 'workspace', 'thread')
                and attempt.status != 'waiting_approval'
                and (task is None or (task.status != 'waiting_approval' and not task.outcome_unknown)))
        outcome = 'abandoned' if safe else 'unknown'
        finish_attempt(session, attempt.id, attempt.owner, outcome, None if safe else STARTUP_UNKNOWN)
        counts[outcome] += 1
        if task:
            if not safe:
                advance_task(session, task, status='waiting_resource', outcome_unknown=True,
                             last_error=STARTUP_UNKNOWN)
            elif task.status in ('running', 'waiting_approval') or task.last_error == STOPPING:
                advance_task(session, task,
                             status='paused' if task.last_error == STOPPING else 'queued',
                             outcome_unknown=False, last_error=None)
    legacy = session.scalars(select(db.Task).where(or_(
        db.Task.status.in_(('running', 'waiting_approval')),
        (db.Task.status == 'waiting_resource') & (db.Task.last_error == STOPPING),
    ))).all()
    for task in legacy:
        if task.id in recovered_ids:
            continue
        advance_task(session, task, status='waiting_resource', outcome_unknown=True, last_error=STARTUP_UNKNOWN)
        counts['legacy_unknown'] += 1
    # A tool request is tied to the old process even if its Task had already failed.
    result = session.execute(update(db.Approval).where(
        db.Approval.status.in_(('pending', 'dispatching')),
        db.Approval.action['method'].as_string().in_(WORKER_APPROVALS),
    ).values(status='expired_on_restart'))
    counts['approvals_expired'] += result.rowcount
    session.add(db.Event(source='runtime', event_type='startup_recovered', data=counts))
    return counts


def _utc(offset=0):
    return (datetime.now(timezone.utc) + timedelta(seconds=offset)).isoformat(timespec='microseconds')


class ControllerLease:
    """Hold a process lock locally and a renewable singleton lease in the database."""

    heartbeat_seconds = 10
    ttl_seconds = 30
    lease_id = 'controller'

    def __init__(self, owner, sessions):
        self.owner = owner
        self.sessions = sessions
        self.epoch = None
        self.file = None
        self.lost = False

    def acquire(self):
        path = Path(os.getenv('SUPERAGENT_STATE_ROOT', 'deploy/state')) / 'controller.lock'
        path.parent.mkdir(parents=True, exist_ok=True)
        stream = path.open('a+b')
        try:
            if os.name == 'nt':
                import msvcrt
                stream.seek(0)
                msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            stream.close()
            raise RuntimeError('已有控制器运行，无法取得本机锁') from None
        self.file = stream
        try:
            with self.sessions.begin() as session:
                row = session.get(db.ControllerLease, self.lease_id)
                now = _utc()
                expires = _utc(self.ttl_seconds)
                if row is None:
                    self.epoch = 1
                    session.add(db.ControllerLease(id=self.lease_id, owner=self.owner, epoch=self.epoch,
                                                   heartbeat_at=now, expires_at=expires))
                else:
                    self.epoch = row.epoch + 1
                    changed = session.execute(update(db.ControllerLease).where(
                        db.ControllerLease.id == self.lease_id, db.ControllerLease.epoch == row.epoch,
                        db.ControllerLease.expires_at <= now,
                    ).values(owner=self.owner, epoch=self.epoch, heartbeat_at=now, expires_at=expires))
                    if changed.rowcount != 1:
                        raise RuntimeError('已有控制器运行，数据库租约仍有效')
        except BaseException as exc:
            self.file.close()
            self.file = None
            if isinstance(exc, IntegrityError):
                raise RuntimeError('已有控制器运行，数据库租约已被领取') from None
            raise

    def _owned(self):
        return (db.ControllerLease.id == self.lease_id, db.ControllerLease.owner == self.owner,
                db.ControllerLease.epoch == self.epoch)

    def check(self, session):
        if self.lost or session.scalar(select(db.ControllerLease.id).where(
                *self._owned(), db.ControllerLease.expires_at > _utc()).with_for_update()) is None:
            raise OwnershipLost('控制器租约已失效')

    async def heartbeat(self, on_loss):
        while True:
            await asyncio.sleep(self.heartbeat_seconds)
            try:
                with self.sessions.begin() as session:
                    now = _utc()
                    updated = session.execute(update(db.ControllerLease)
                        .where(*self._owned(), db.ControllerLease.expires_at > now)
                        .values(heartbeat_at=now, expires_at=_utc(self.ttl_seconds)))
                    if updated.rowcount != 1:
                        raise OwnershipLost('控制器租约已失效')
            except Exception:
                self.lost = True
                logging.exception('控制器续租失败，暂停调度并停止当前执行')
                await on_loss()
                return

    def release(self):
        if self.file is None:
            return
        try:
            with self.sessions.begin() as session:
                session.execute(update(db.ControllerLease).where(*self._owned()).values(expires_at=_utc()))
        finally:
            self.file.close()
            self.file = None
