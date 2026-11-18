"""Offline WP1 coverage with real SQLite transactions and disposable child processes."""

import asyncio
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Barrier
from unittest.mock import AsyncMock

import httpx
import pytest
from sqlalchemy import func, inspect, select, text, update
from sqlalchemy.orm import sessionmaker

import superagent.main as main
from superagent.core import db, execution, reply_worker, scheduler as worker


def setup(root, patch, boundary=''):
    for name, suffix in [('STATE_ROOT', 'state'), ('WORKSPACES_ROOT', 'workspaces'),
                         ('REPLY_ROOT', 'replies'), ('CODEX_HOME', 'codex')]:
        patch.setenv('SUPERAGENT_' + name, str(root / suffix))
    patch.setenv('SUPERAGENT_EXECUTION_MODE', 'attempt')
    patch.setenv('SUPERAGENT_FEISHU_ENABLED', '0')
    patch.setenv('SUPERAGENT_API_TOKEN', 'wp1-test-token')
    engine = db.create_engine('sqlite:///' + (root / 'control.db').as_posix())
    sessions = sessionmaker(engine, expire_on_commit=False)
    patch.setattr(db, 'engine', engine)
    for module in (db, main, worker):
        patch.setattr(module, 'Session', sessions)
    patch.setattr(main, 'scheduler', worker.Scheduler())
    for service, methods in [(main.operations, ('start', 'close')), (main.manager, ('start', 'stop')),
                             (main.semantic_routing_service, ('start', 'close')), (main.router_agent, ('close',))]:
        for method in methods:
            patch.setattr(service, method, AsyncMock())
    patch.setattr(worker, 'executable', lambda: 'fake')
    patch.setattr(worker, 'select_node', lambda _: None)
    patch.setattr(worker, 'monetary_budget_required', lambda: False)
    for module in (worker, reply_worker):
        patch.setattr(module, 'reserve_model_run', lambda *args, **kwargs: {'id': None})
        patch.setattr(module, 'settings_snapshot', lambda: {'scheduler_enabled': True})
    patch.setattr(reply_worker, 'client_options', lambda: {})
    patch.setattr('superagent.core.local_agents.client_options', lambda: {})

    def park():
        (root / 'ready').touch()
        while True:
            time.sleep(0.02)

    class FakeCodex:
        def __init__(self, _command, cwd, **_options):
            self.cwd = cwd
            self.interrupted = asyncio.Event()
            self.waiting = asyncio.Event()

        async def start(self):
            if boundary == 'workspace':
                park()

        async def start_thread(self, _cwd, *, instructions='', read_only=False, tool_less=False):
            return {'id': 'thread'}

        async def resume_thread(self, _thread, *, read_only=False, tool_less=False):
            return {'id': 'thread'}

        async def start_turn(self, _thread, _prompt, *, model=None, effort=None, **_options):
            with (root / 'side_effects').open('a', encoding='utf-8') as marker:
                marker.write('file-write\ntest-run\n')
            if boundary == 'turn_dispatch':
                park()
            return {'id': 'turn'}

        async def events(self):
            params = {'threadId': 'thread', 'turnId': 'turn'}
            if boundary in ('turn', 'approval', 'drain'):
                self.waiting.set()
                if boundary == 'turn':
                    park()
                if boundary == 'approval':
                    yield {'id': 1, 'method': 'item/commandExecution/requestApproval', 'params': params}
                await self.interrupted.wait()
                return
            if boundary != 'reply':
                yield {'method': 'item/completed', 'params': {**params, 'item': {
                    'type': 'commandExecution', 'id': 'test', 'command': 'verify', 'cwd': self.cwd,
                    'status': 'completed', 'exitCode': 0, 'aggregatedOutput': 'mock verified'}}}
            yield {'method': 'item/completed', 'params': {**params, 'item': {
                'type': 'agentMessage', 'id': 'summary', 'text': '{"status":"completed","summary":"mock fix"}'}}}
            yield {'method': 'turn/completed', 'params': {**params, 'turn': {'id': 'turn', 'status': 'completed'}}}

        async def interrupt_turn(self, _thread, _turn):
            self.interrupted.set()

        async def respond_approval(self, _request, _decision):
            pass

        async def close(self):
            pass

    def prepare(_repo, _branch, key, workspace_root, *_repositories, **_options):
        target = Path(workspace_root) / key
        target.mkdir()
        if boundary == 'partial_workspace':
            park()
        return {'path': str(target), 'base_sha': 'a' * 40}

    def changes(*_args):
        if boundary == 'evidence':
            park()
        return {'diff': 'fake diff', 'untracked_artifacts': []}

    patch.setattr(worker, 'CodexAppServer', FakeCodex)
    patch.setattr(reply_worker, 'CodexAppServer', FakeCodex)
    patch.setattr(worker, 'prepare_project_workspace', prepare)
    patch.setattr(worker, 'validate_workspace_changes', lambda *_args: None)
    patch.setattr(worker, 'validate_allowed_paths', lambda *_args: None)
    patch.setattr(worker, 'collect_changes', changes)
    if boundary == 'thread':
        patch.setattr(worker, 'build_worker_prompt', lambda *_args: park())
    return engine, sessions, FakeCodex


def seed(sessions, *, kind='repair'):
    with sessions.begin() as session:
        session.add(db.Project(id=1, name='offline', repo_path='unused', test_command='verify',
                               allowed_paths=['.']))
        session.add(db.Task(id=1, project_id=1, title='isolated', goal='check execution', kind=kind))


def rows(sessions):
    with sessions() as session:
        task = session.get(db.Task, 1)
        attempts = session.scalars(select(db.ExecutionAttempt).order_by(db.ExecutionAttempt.attempt_no)).all()
        return task, attempts


async def until(condition):
    async with asyncio.timeout(8):
        while not (result := condition()):
            await asyncio.sleep(0.01)
        return result


def test_atomic_claim_and_only_winner_enters_run(tmp_path, monkeypatch):
    engine, sessions, _fake = setup(tmp_path, monkeypatch)
    db.init_db()
    seed(sessions)
    workers = [worker.Scheduler(), worker.Scheduler()]
    barrier = Barrier(2)

    def compete(scheduler):
        barrier.wait(timeout=5)
        return execution.claim_task(1, scheduler.owner, sessions=sessions)

    with ThreadPoolExecutor(max_workers=2) as pool:
        claims = list(pool.map(compete, workers))
    assert sum(bool(claim) for claim in claims) == 1
    winner = workers[0] if claims[0] else workers[1]
    loser = workers[1] if claims[0] else workers[0]
    attempt_id = next(claim for claim in claims if claim)
    assert rows(sessions)[0].state_version == 2
    asyncio.run(loser.run(1, attempt_id))
    assert not (tmp_path / 'side_effects').exists()
    asyncio.run(winner.run(1, attempt_id))
    asyncio.run(winner.run(1, attempt_id))
    task, attempts = rows(sessions)
    assert task.status == 'review_ready'
    assert [(a.id, a.status, a.phase) for a in attempts] == [(attempt_id, 'completed', 'done')]
    assert (tmp_path / 'side_effects').read_text().splitlines() == ['file-write', 'test-run']
    with sessions() as session:
        assert {a.attempt_id for a in session.scalars(select(db.Artifact))} == {attempt_id}
        assert {e.data.get('attempt_id') for e in session.scalars(select(db.Event))} == {attempt_id}
    engine.dispose()


def test_two_polls_only_dispatch_claimed_task(tmp_path, monkeypatch):
    engine, sessions, _fake = setup(tmp_path, monkeypatch, 'drain')
    db.init_db()
    seed(sessions)
    workers = [worker.Scheduler(), worker.Scheduler()]
    invocations = []

    async def scenario():
        def track(run):
            async def tracked(task_id, attempt_id):
                invocations.append((task_id, attempt_id))
                await run(task_id, attempt_id)
            return tracked

        for scheduler in workers:
            monkeypatch.setattr(scheduler, 'run', track(scheduler.run))
        await asyncio.gather(*(scheduler.start() for scheduler in workers))
        await until(lambda: any(client.waiting.is_set() for scheduler in workers for client in scheduler.clients.values()))
        await asyncio.sleep(0.3)
        await asyncio.gather(*(scheduler.close() for scheduler in workers))

    asyncio.run(scenario())
    task, attempts = rows(sessions)
    assert task.status == 'paused'
    assert len(attempts) == 1
    assert invocations == [(1, attempts[0].id)]
    engine.dispose()


def child(root, boundary):
    with pytest.MonkeyPatch.context() as patch:
        _engine, sessions, _fake = setup(root, patch, boundary)
        scheduler = main.scheduler
        lease = execution.ControllerLease(scheduler.owner, sessions)
        lease.acquire()
        scheduler.lease = lease
        if boundary == 'before_claim':
            (root / 'ready').touch()
        else:
            attempt_id = execution.claim_task(1, scheduler.owner, sessions=sessions, lease=lease)
            if boundary != 'after_claim':
                asyncio.run(scheduler.run(1, attempt_id))
            (root / 'ready').touch()
        while True:
            time.sleep(0.02)


@pytest.mark.parametrize(('boundary', 'phase', 'can_restart'), [
    ('before_claim', None, True), ('after_claim', 'claimed', True),
    ('partial_workspace', 'claimed', True), ('workspace', 'workspace', True),
    ('thread', 'thread', True),
    ('turn_dispatch', 'turn', False), ('turn', 'turn', False), ('evidence', 'evidence', False),
])
def test_process_kill_and_startup_recovery(tmp_path, monkeypatch, boundary, phase, can_restart):
    engine, sessions, _fake = setup(tmp_path, monkeypatch)
    db.init_db()
    seed(sessions)
    code = ('import runpy, sys; from pathlib import Path; '
            'runpy.run_path(sys.argv[1])["child"](Path(sys.argv[2]), sys.argv[3])')
    process = subprocess.Popen([sys.executable, '-c', code, __file__, str(tmp_path), boundary],
                               stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    try:
        limit = time.monotonic() + 15
        while not (tmp_path / 'ready').exists() and process.poll() is None and time.monotonic() < limit:
            time.sleep(0.02)
    finally:
        if process.poll() is None:
            process.kill()
        output, _ = process.communicate(timeout=5)
    assert (tmp_path / 'ready').exists(), output.decode(errors='replace')
    task, prior = rows(sessions)
    assert task.revision == 1
    assert [a.phase for a in prior] == ([phase] if phase else [])
    with pytest.raises(RuntimeError, match='数据库租约仍有效'):
        execution.ControllerLease('premature', sessions).acquire()
    # Move the expired controller's clock boundary forward without a 30-second wait.
    with sessions.begin() as session:
        session.execute(update(db.ControllerLease).values(expires_at=execution._utc(-1)))

    async def restart():
        monkeypatch.setattr(main.scheduler, 'start', AsyncMock())
        async with main.lifespan(main.app):
            task, attempts = rows(sessions)
            assert task.goal == 'check execution' and task.revision == 1
            assert (task.status, task.outcome_unknown) == (('queued', False) if can_restart else ('waiting_resource', True))
            if prior:
                assert attempts[-1].status == ('abandoned' if can_restart else 'unknown')
                assert attempts[-1].turn_id == ('turn' if boundary in ('turn', 'evidence') else None)
            attempt_id = execution.claim_task(1, main.scheduler.owner, sessions=sessions, lease=main.scheduler.lease)
            if can_restart:
                assert attempt_id
                await main.scheduler.run(1, attempt_id)
                assert rows(sessions)[0].status == 'review_ready'
            else:
                assert attempt_id is None
            with sessions() as session:
                assert session.get(db.ControllerLease, 'controller').epoch == 2
                assert session.scalar(select(func.count()).select_from(db.Event)
                                      .where(db.Event.event_type == 'startup_recovered')) == 1
                assert session.scalar(select(func.count()).select_from(db.Artifact)
                                      .where(db.Artifact.kind == 'verification')) == int(can_restart)

    asyncio.run(restart())
    assert (tmp_path / 'side_effects').read_text().splitlines() == ['file-write', 'test-run']
    engine.dispose()


def test_restart_expires_worker_approvals_and_preserves_delivery(tmp_path, monkeypatch):
    engine, sessions, _fake = setup(tmp_path, monkeypatch, 'approval')
    db.init_db()
    seed(sessions)

    async def scenario():
        old = worker.Scheduler()
        await old.start()
        await until(lambda: rows(sessions)[0].status == 'waiting_approval')
        with sessions.begin() as session:
            attempt = session.scalar(select(db.ExecutionAttempt))
            assert (attempt.status, attempt.phase) == ('waiting_approval', 'approval')
            approval = session.scalar(select(db.Approval))
            session.add(db.Approval(task_id=1, revision=1, control_version=1,
                                   action_hash='delivery', action={'source': 'redmine'}))
        # Simulate losing the controller while its approval is retained in the database.
        old.loop_task.cancel()
        await asyncio.gather(old.loop_task, return_exceptions=True)
        monkeypatch.setattr(main.scheduler, 'start', AsyncMock())
        async with main.lifespan(main.app):
            transport = httpx.ASGITransport(app=main.app)
            async with httpx.AsyncClient(transport=transport, base_url='http://testserver',
                                        headers={'Authorization': 'Bearer wp1-test-token'}) as client:
                response = await client.post(f'/api/v1/approvals/{approval.id}/decision',
                                             json={'decision': 'reject', 'action_hash': approval.action_hash})
                assert response.status_code == 409
                assert '重启' in response.json()['detail']
                response = await client.get('/api/v1/operations/tasks/1/attempts')
                assert response.json()['items'][0]['status'] == 'unknown'
            with sessions() as session:
                assert [a.status for a in session.scalars(select(db.Approval).order_by(db.Approval.id))] == [
                    'expired_on_restart', 'pending']
                assert session.get(db.Task, 1).outcome_unknown
        old.clients[1].interrupted.set()
        await asyncio.gather(*old.active.values())

    asyncio.run(scenario())
    engine.dispose()


def test_startup_freezes_inflight_turn_after_goal_changed(tmp_path, monkeypatch):
    engine, sessions, _fake = setup(tmp_path, monkeypatch)
    db.init_db()
    seed(sessions)
    attempt_id = execution.claim_task(1, 'old', sessions=sessions)
    with sessions.begin() as session:
        assert execution.begin_attempt(session, 1, attempt_id, 'old')
        execution.set_attempt(session, attempt_id, 'old', phase='turn', turn_id='turn')
        task = session.get(db.Task, 1)
        execution.advance_task(session, task, status='waiting_input', goal='new goal',
                               revision=2, control_version=2)
    with sessions.begin() as session:
        execution.recover_startup(session)
    task, attempts = rows(sessions)
    assert (task.status, task.outcome_unknown, attempts[0].status) == ('waiting_resource', True, 'unknown')
    assert (task.goal, task.revision, task.control_version) == ('new goal', 2, 2)
    engine.dispose()


@pytest.mark.parametrize('hang_close', [False, True])
def test_shutdown_waits_for_exit_then_pauses_or_freezes(tmp_path, monkeypatch, hang_close):
    engine, sessions, fake = setup(tmp_path, monkeypatch, 'drain')
    db.init_db()
    seed(sessions)
    scheduler = main.scheduler
    scheduler.drain_seconds = 0.4 if hang_close else 4

    async def scenario():
        unblock = asyncio.Event()

        async def close(_client):
            if hang_close:
                await unblock.wait()

        monkeypatch.setattr(fake, 'close', close)
        await scheduler.start()
        await until(lambda: scheduler.clients.get(1) and scheduler.clients[1].waiting.is_set())
        active = scheduler.active[1]
        before = time.monotonic()
        await scheduler.close()
        assert time.monotonic() - before < scheduler.drain_seconds + 0.3
        task, attempts = rows(sessions)
        assert task.control_version > 1
        expected = ('waiting_resource', True, 'unknown') if hang_close else ('paused', False, 'cancelled')
        assert (task.status, task.outcome_unknown, attempts[0].status) == expected
        unblock.set()
        await active
        assert rows(sessions)[1][0].status == expected[2]

    asyncio.run(scenario())
    engine.dispose()


def test_reply_runs_with_claimed_execution_attempt(tmp_path, monkeypatch):
    engine, sessions, _fake = setup(tmp_path, monkeypatch, 'reply')
    db.init_db()
    seed(sessions, kind='reply')
    scheduler = main.scheduler

    async def scenario():
        await scheduler.start()
        await until(lambda: rows(sessions)[0].status == 'review_ready')
        await scheduler.close()

    asyncio.run(scenario())
    task, attempts = rows(sessions)
    assert attempts[0].status == 'completed'
    assert (attempts[0].thread_id, attempts[0].turn_id) == ('thread', 'turn')
    assert task.workspace_path is None and Path(attempts[0].workspace_path).is_dir()
    with sessions() as session:
        assert {a.attempt_id for a in session.scalars(select(db.Artifact))} == {attempts[0].id}
    engine.dispose()


def test_live_approval_updates_attempt_and_cancel_stops_worker(tmp_path, monkeypatch):
    engine, sessions, _fake = setup(tmp_path, monkeypatch, 'approval')
    db.init_db()
    seed(sessions)
    scheduler = main.scheduler

    async def scenario():
        await scheduler.start()
        await until(lambda: rows(sessions)[0].status == 'waiting_approval')
        with sessions() as session:
            approval = session.scalar(select(db.Approval))
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app),
                                     base_url='http://testserver',
                                     headers={'Authorization': 'Bearer wp1-test-token'}) as client:
            response = await client.post(f'/api/v1/approvals/{approval.id}/decision',
                                         json={'decision': 'reject', 'action_hash': approval.action_hash})
            assert response.status_code == 200, response.text
            assert response.json()['status'] == 'rejected'
            task, attempts = rows(sessions)
            assert (task.status, attempts[0].status, attempts[0].phase) == ('running', 'running', 'turn')
            response = await client.post('/api/v1/tasks/1/controls',
                                         json={'action': 'cancel', 'expected_state_version': task.state_version})
            assert response.status_code == 200
        await until(lambda: rows(sessions)[0].status == 'cancelled')
        await scheduler.close()

    asyncio.run(scenario())
    assert rows(sessions)[1][0].status == 'cancelled'
    engine.dispose()


def test_lease_excludes_local_owner_and_stops_on_heartbeat_loss(tmp_path, monkeypatch):
    engine, sessions, _fake = setup(tmp_path, monkeypatch)
    db.init_db()
    lease = execution.ControllerLease('owner', sessions)
    lease.acquire()
    try:
        with pytest.raises(RuntimeError, match='本机锁'):
            execution.ControllerLease('second', sessions).acquire()
        lease.heartbeat_seconds = 0.02

        async def scenario():
            on_loss = AsyncMock()
            heartbeat = asyncio.create_task(lease.heartbeat(on_loss))
            with sessions() as session:
                before = session.get(db.ControllerLease, 'controller').heartbeat_at

            def renewed():
                with sessions() as session:
                    return session.get(db.ControllerLease, 'controller').heartbeat_at != before

            await until(renewed)
            with sessions.begin() as session:
                session.execute(update(db.ControllerLease).values(expires_at=execution._utc(-1)))
            await asyncio.wait_for(heartbeat, 2)
            on_loss.assert_awaited_once()
            with sessions() as session, pytest.raises(execution.OwnershipLost):
                lease.check(session)

        asyncio.run(scenario())
    finally:
        lease.release()
        engine.dispose()


def test_additive_migration_preserves_existing_artifact(tmp_path, monkeypatch):
    engine, sessions, _fake = setup(tmp_path, monkeypatch)
    with engine.begin() as conn:
        conn.execute(text('CREATE TABLE artifacts (id INTEGER PRIMARY KEY, task_id INTEGER, '
                          'revision INTEGER, kind TEXT, content TEXT, created_at TEXT)'))
        conn.execute(text("INSERT INTO artifacts VALUES (1, 1, 1, 'summary', 'kept', 'yesterday')"))
    db.init_db()
    db.init_db()
    with sessions() as session:
        artifact = session.get(db.Artifact, 1)
        assert (artifact.content, artifact.attempt_id) == ('kept', None)
    assert {'execution_attempts', 'controller_leases'} <= set(inspect(engine).get_table_names())
    engine.dispose()
