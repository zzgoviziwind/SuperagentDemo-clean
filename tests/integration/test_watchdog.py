import asyncio

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from superagent.core import db
from superagent.core.watchdog import WatchdogService, WatchdogRun


class Worker:
    def __init__(self):
        self.stops = []
    def lock(self, task_id):
        return asyncio.Lock()
    async def stop_run(self, task_id, action):
        self.stops.append((task_id, action))
        with db.Session.begin() as session:
            session.get(db.Task, task_id).status = 'paused'


class Reviewer:
    action = 'pause'
    async def review(self, run_id, evidence, save_session):
        save_session('independent-watchdog-thread', 'watchdog-turn')
        return {'action': self.action, 'reason': '同一错误持续出现，建议暂停核查'}


@pytest.fixture
def store(tmp_path, monkeypatch):
    engine = create_engine('sqlite:///' + str(tmp_path / 'watchdog.db'))
    db.Base.metadata.create_all(engine)
    monkeypatch.setattr(db, 'Session', sessionmaker(engine, expire_on_commit=False))
    with db.Session.begin() as session:
        session.add(db.Project(id=1, name='test', repo_path=str(tmp_path)))
        session.add(db.Task(id=1, title='test', goal='修复测试', project_id=1, status='running'))
    yield
    engine.dispose()


def test_pause_and_independent_evidence(store):
    worker = Worker()
    service = WatchdogService(worker, Reviewer())
    run_id = asyncio.run(service.review(1))
    with db.Session() as session:
        row, task = session.get(WatchdogRun, run_id), session.get(db.Task, 1)
        assert row.thread_id == 'independent-watchdog-thread'
        assert row.evidence['task']['goal'] == '修复测试'
        assert row.conclusion['applied'] == 'paused'
        assert task.status == 'paused'
        assert task.control_version == 2
    assert worker.stops == [(1, 'pause')]


def test_unknown_worker_is_never_resumed_or_marked_stopped(store):
    with db.Session.begin() as session:
        session.get(db.Task, 1).outcome_unknown = True
    worker = Worker()
    asyncio.run(WatchdogService(worker, Reviewer()).review(1))
    with db.Session() as session:
        task = session.get(db.Task, 1)
        assert task.outcome_unknown and task.status == 'running'
    assert worker.stops == []


def test_model_cannot_choose_unsafe_action(store):
    model = Reviewer()
    model.action = 'repair_database'
    service = WatchdogService(Worker(), model)
    with pytest.raises(ValueError):
        asyncio.run(service.review(1))
    with db.Session() as session:
        assert session.scalars(select(WatchdogRun)).one().status == 'unknown'
        assert session.get(db.Task, 1).status == 'running'
    with pytest.raises(ValueError, match='上次巡检'):
        asyncio.run(service.review(1))


def test_stale_model_result_is_not_applied(store):
    class MutatingReviewer(Reviewer):
        async def review(self, *args):
            with db.Session.begin() as session:
                session.get(db.Task, 1).state_version += 1
            return await super().review(*args)
    run_id = asyncio.run(WatchdogService(Worker(), MutatingReviewer()).review(1))
    with db.Session() as session:
        assert session.get(WatchdogRun, run_id).conclusion['applied'] == 'stale_evidence'
        assert session.get(db.Task, 1).status == 'running'


def test_failed_stop_is_recorded_as_unknown(store):
    class BrokenWorker(Worker):
        async def stop_run(self, *args):
            raise RuntimeError('stop failed')
    with pytest.raises(RuntimeError):
        asyncio.run(WatchdogService(BrokenWorker(), Reviewer()).review(1))
    with db.Session() as session:
        assert session.scalars(select(WatchdogRun)).one().status == 'unknown'
        assert session.get(db.Task, 1).outcome_unknown


def test_unconfirmed_stop_is_recorded_as_unknown(store):
    class UnconfirmedWorker(Worker):
        async def stop_run(self, *args):
            pass
    run_id = asyncio.run(WatchdogService(UnconfirmedWorker(), Reviewer()).review(1))
    with db.Session() as session:
        assert session.get(WatchdogRun, run_id).conclusion['applied'] == 'stop_unconfirmed'
        assert session.get(db.Task, 1).outcome_unknown


@pytest.mark.parametrize('native_type', ['userMessage', 'commandExecution'])
def test_real_protocol_user_message_and_native_tool_boundary(tmp_path, monkeypatch, native_type):
    from superagent.core import watchdog as module, scheduler as worker_module
    monkeypatch.setattr(module, 'settings_snapshot', lambda: {'budget_reservation_estimate_micros': 1})
    monkeypatch.setattr(module, 'monetary_budget_required', lambda: True)
    monkeypatch.setattr(module, 'reserve_model_run', lambda *args, **kwargs: {'id': 1})
    monkeypatch.setattr(module, 'settle_budget', lambda *args, **kwargs: None)
    monkeypatch.setattr(worker_module, 'executable', lambda: 'fake')
    monkeypatch.setenv('SUPERAGENT_WATCHDOG_ROOT', str(tmp_path))
    class Protocol:
        def __init__(self, *args, **kwargs):
            pass
        async def start(self):
            pass
        async def start_thread(self, cwd, **kwargs):
            assert kwargs['read_only']
            return {'id': 'watchdog'}
        async def start_turn(self, thread_id, prompt, **kwargs):
            return {'id': 'turn'}
        async def close(self):
            pass
        async def events(self):
            yield {'method': 'item/completed', 'params': {'threadId': 'watchdog', 'turnId': 'turn', 'item': {'type': native_type}}}
            yield {'method': 'item/completed', 'params': {'threadId': 'watchdog', 'turnId': 'turn', 'item': {'type': 'agentMessage', 'text': '{"action":"observe","reason":"仍有进展"}'}}}
            yield {'method': 'turn/completed', 'params': {'threadId': 'watchdog', 'turn': {'id': 'turn', 'status': 'completed'}}}
    monkeypatch.setattr(module, 'CodexAppServer', Protocol)
    async def review():
        return await module.CodexWatchdogModel().review('test', {'goal': 'test'}, lambda *args: None)
    if native_type == 'userMessage':
        assert asyncio.run(review())['action'] == 'observe'
    else:
        with pytest.raises(module.WatchdogReviewError, match='commandExecution'):
            asyncio.run(review())


@pytest.mark.parametrize('configured,expected', [(None, 240), ('17', 17)])
def test_review_timeout_default_and_environment_override(store, monkeypatch, configured, expected):
    from superagent.core import watchdog as module
    if configured is None:
        monkeypatch.delenv('SUPERAGENT_WATCHDOG_TIMEOUT', raising=False)
    else:
        monkeypatch.setenv('SUPERAGENT_WATCHDOG_TIMEOUT', configured)
    timeouts = []
    async def capture_timeout(awaitable, timeout):
        timeouts.append(timeout)
        return await awaitable
    monkeypatch.setattr(module.asyncio, 'wait_for', capture_timeout)
    asyncio.run(WatchdogService(Worker(), Reviewer()).review(1))
    assert timeouts == [expected]


@pytest.mark.parametrize('failure', ['timeout', 'unknown'])
def test_manual_review_returns_conflict_with_persistent_record(store, monkeypatch, failure):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from superagent.api import operations as api
    from superagent.runtime.codex import UnknownOutcome
    class FailedReviewer:
        async def review(self, run_id, evidence, save_session):
            save_session('failed-watchdog-thread', 'failed-turn')
            if failure == 'timeout':
                raise TimeoutError()
            raise UnknownOutcome('connection lost')
    monkeypatch.setattr(api.operations, 'watchdog', WatchdogService(Worker(), FailedReviewer()))
    app = FastAPI()
    app.include_router(api.router)
    app.dependency_overrides[api.admin] = lambda: None
    with TestClient(app) as client:
        response = client.post('/api/v1/operations/watchdog/tasks/1/run')
    assert response.status_code == 409
    with db.Session() as session:
        row = session.scalars(select(WatchdogRun)).one()
        assert row.status == 'unknown'
        assert row.thread_id == 'failed-watchdog-thread'
        assert row.id in response.json()['detail']
        assert '/api/v1/operations/watchdog?task_id=1' in response.json()['detail']
        expected_message = '等待超时' if failure == 'timeout' else '结果未知'
        assert expected_message in response.json()['detail']
        assert session.get(db.Task, 1).status == 'running'


def test_elapsed_timeout_preserves_unknown_record(store, monkeypatch):
    from superagent.core.watchdog import WatchdogOutcomeUnknown
    monkeypatch.setenv('SUPERAGENT_WATCHDOG_TIMEOUT', '0.01')
    class SlowReviewer:
        async def review(self, run_id, evidence, save_session):
            save_session('slow-watchdog', 'slow-turn')
            await asyncio.sleep(10)
    service = WatchdogService(Worker(), SlowReviewer())
    with pytest.raises(WatchdogOutcomeUnknown) as failure:
        asyncio.run(service.review(1))
    assert failure.value.timed_out
    assert not service.active
    with db.Session() as session:
        row = session.get(WatchdogRun, failure.value.run_id)
        assert row.status == 'unknown'
        assert row.conclusion['error'] == 'TimeoutError'
        assert row.thread_id == 'slow-watchdog'
