"""Supplementary tests for reachable control paths, no live service or runtime."""
import asyncio
from types import SimpleNamespace

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
import pytest

from superagent import main
from superagent.core import db, governance
from superagent.core.message_context import timeline, describe_message
from superagent.core.scheduler import Scheduler, build_worker_prompt


def test_bounded_start_prompt_keeps_recent_but_misses_old_decision(tmp_path):
    engine = create_engine('sqlite:///' + (tmp_path / 'prompt.db').as_posix())
    db.Base.metadata.create_all(engine)
    with sessionmaker(engine).begin() as session:
        for i in range(31):
            text = ('AUDIT_OLDEST_DECISION ' if not i else f'AUDIT_{i:02d} ') + '文' * 4200 + 'AUDIT_TAIL'
            session.add(db.Event(task_id=1, source='web', event_type='message', content=text))
        session.flush()
        rows = timeline(session, 1)
        info = dict(goal='fixture', criteria='', kind='repair', test_command='', project_name='test', workspace='fixture',
                    references={}, recent_work=[], previous_summary='', repositories=[], reply_source_id=None,
                    event_context=[describe_message(row) for row in rows])
        prompt = build_worker_prompt(info, '')
        assert session.get(db.Event, 1).content.startswith('AUDIT_OLDEST_DECISION')
        assert len(rows) == 24 and 'AUDIT_30 ' in prompt
        assert 'AUDIT_OLDEST_DECISION' not in prompt and 'AUDIT_TAIL' not in prompt
        print(f'real SQLite and prompt builder: 31 messages >4200 chars; injected=24; prompt_chars={len(prompt)}; old marker and tails absent')


def test_restart_handler_fences_approval_and_running_rows(tmp_path, monkeypatch):
    engine = create_engine('sqlite:///' + (tmp_path / 'restart.db').as_posix())
    db.Base.metadata.create_all(engine)
    sessions = sessionmaker(engine, expire_on_commit=False)
    monkeypatch.setattr(main, 'Session', sessions)
    monkeypatch.setattr(main, 'init_db', lambda: None)
    monkeypatch.setattr(main.feishu_decisions.Config, 'load', lambda: None)

    async def noop():
        pass

    for component, methods in [
        (main.operations, ('start', 'close')), (main.scheduler, ('start', 'close')),
        (main.manager, ('start', 'stop')), (main.semantic_routing_service, ('start', 'close')),
        (main.router_agent, ('close',)),
    ]:
        for method in methods:
            monkeypatch.setattr(component, method, noop)
    monkeypatch.setattr(main.semantic_routing_service, 'sessions', sessions)
    with sessions.begin() as session:
        for ident, state in enumerate(('running', 'waiting_approval', 'queued'), 1):
            session.add(db.Task(id=ident, title='fixture', goal='goal', project_id=1, status=state,
                                codex_thread_id='t', codex_turn_id='u'))
        session.add(db.Approval(id=1, task_id=2, revision=1, control_version=1, action_hash='offline',
                                action={'method':'item/commandExecution/requestApproval'}, status='pending'))

    async def scenario():
        async with main.lifespan(main.app):
            pass
        with sessions() as session:
            for ident in (1, 2):
                task = session.get(db.Task, ident)
                assert (task.status, task.outcome_unknown, task.codex_thread_id, task.codex_turn_id, task.state_version
                        ) == ('waiting_resource', True, 't', 'u', 2)
            assert session.get(db.Task, 3).status == 'queued'
            assert session.get(db.Approval, 1).status == 'pending'
        req = SimpleNamespace(state=SimpleNamespace(principal=governance.Principal('admin', 'admin')))
        from fastapi import HTTPException
        for callback in (
            lambda: main.control(1, main.ControlIn(action='retry'), req),
            lambda: main.decide(1, main.DecisionIn(decision='approve', action_hash='offline'), req),
        ):
            try:
                await callback()
            except HTTPException as exc:
                assert exc.status_code == 409
            else:
                raise AssertionError('an unknown action was allowed')
        print('startup recovery body + SQLite: running/approval -> unknown; queue preserved; retry and old approval both 409')

    asyncio.run(scenario())


def test_noise_keeps_run_alive_beyond_inactivity_limit(monkeypatch):
    monkeypatch.setenv('SUPERAGENT_RUN_IDLE_TIMEOUT_SECONDS', '1')
    runtime = Scheduler()

    class Client:
        async def events(self):
            while True:
                await asyncio.sleep(.15)
                yield {'method':'item/agentMessage/delta', 'params':{'delta':'same', 'itemId':'same'}}

    async def scenario():
        count = 0
        start = asyncio.get_running_loop().time()
        async with asyncio.timeout(3):
            gen = runtime.monitored_events(Client(), 1)
            try:
                async for _ in gen:
                    count += 1
                    if asyncio.get_running_loop().time() - start > 2:
                        break
            finally:
                await gen.aclose()
        assert count > 10
        print(f'idle limit=1s; {count} equal deltas over >2s; no stall was identified by the monitor')

    asyncio.run(scenario())


def test_silent_stream_trips_inactivity_limit(monkeypatch):
    monkeypatch.setenv('SUPERAGENT_RUN_IDLE_TIMEOUT_SECONDS', '1')
    monkeypatch.setattr('superagent.core.scheduler.Session', lambda: FakeSession())

    class FakeSession:
        def __enter__(self):
            return self

        def __exit__(self, *_):
            pass

        def get(self, *_):
            return SimpleNamespace(status='running')

    class Client:
        async def events(self):
            await asyncio.sleep(10)
            yield {}

    with pytest.raises(TimeoutError, match='长时间无进展'):
        asyncio.run(anext(Scheduler().monitored_events(Client(), 1)))
    print('silent stream crossed the 1s limit and raised TimeoutError')


def test_running_web_message_targets_matching_worker(tmp_path, monkeypatch):
    engine = create_engine('sqlite:///' + (tmp_path / 'steer.db').as_posix())
    db.Base.metadata.create_all(engine)
    sessions = sessionmaker(engine, expire_on_commit=False)
    monkeypatch.setattr(main, 'Session', sessions)
    runtime = Scheduler()
    monkeypatch.setattr(main, 'scheduler', runtime)
    calls = []

    class Client:
        async def steer_turn(self, thread, turn, content):
            calls.append((thread, turn, content))

    with sessions.begin() as session:
        for ident in (1, 2):
            session.add(db.Task(id=ident, title='fixture', goal='goal', project_id=1, status='running',
                                codex_thread_id=f't{ident}', codex_turn_id=f'u{ident}'))
            runtime.clients[ident] = Client()
    req = SimpleNamespace(state=SimpleNamespace(principal=governance.Principal('admin', 'admin')))
    item = asyncio.run(main.message(2, main.MessageIn(content='AUDIT_STEER', expected_state_version=1), req))
    with sessions() as session:
        assert session.get(db.Event, item['id']).task_id == 2
        assert session.get(db.Task, 1).state_version == 1
    assert calls == [('t2', 'u2', 'AUDIT_STEER')]
    print('stored message only for Worker 2; steer called matching thread and turn on stub')
