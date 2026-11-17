import asyncio
from pathlib import Path

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from superagent.core import router_agent as module
from superagent.core.db import Base, Project
from superagent.core.sessions import RouterSession, RouterMessage


@pytest.fixture
def setup(tmp_path, monkeypatch):
    engine = create_engine('sqlite:///' + str(tmp_path / 'router.db'))
    Base.metadata.create_all(engine)
    factory = sessionmaker(engine, expire_on_commit=False)
    monkeypatch.setattr(module, 'Session', factory)
    settings = {'router_agent_enabled': True, 'budget_reservation_estimate_micros': 1}
    monkeypatch.setattr(module, 'settings_snapshot', lambda: settings)
    monkeypatch.setattr(module, 'executable', lambda: 'fake-codex')
    monkeypatch.setattr(module, 'monetary_budget_required', lambda: True)
    monkeypatch.setattr(module, 'reserve_model_run', lambda *a, **k: {'id': 1})
    settlements = []
    monkeypatch.setattr(module, 'settle_budget', lambda *a, **k: settlements.append(k))
    monkeypatch.setenv('SUPERAGENT_ROUTER_ROOT', str(tmp_path / 'workspace'))
    with factory.begin() as s:
        s.add(Project(id=1, name='测试项目', repo_path=str(tmp_path)))
    agent = module.RouterAgent()
    yield agent, factory, settings, settlements
    engine.dispose()


class FakeCodex:
    threads = []
    def __init__(self, *a, **k): pass
    async def start(self): pass
    async def start_thread(self, path, **kw):
        assert kw['read_only'] is True
        return {'id': 'router-thread'}
    async def resume_thread(self, ident, **kw):
        assert ident == 'router-thread' and kw['read_only'] is True
        self.threads.append(ident)
        return {'id': ident}
    async def start_turn(self, ident, prompt, **kw):
        assert '测试项目' in prompt
        return {'id': 'turn'}
    async def events(self):
        # Wrong-thread output must never leak into this project's conversation.
        yield {'method': 'item/completed', 'params': {'threadId': 'other', 'turnId': 'turn',
               'item': {'id': 'wrong', 'type': 'agentMessage', 'text': '不属于本项目'}}}
        yield {'method': 'item/completed', 'params': {'threadId': 'router-thread', 'turnId': 'turn',
               'item': {'id': 'answer', 'type': 'agentMessage', 'text': '建议先分析，再确认执行。'}}}
        yield {'method': 'turn/completed', 'params': {'threadId': 'router-thread',
               'turn': {'id': 'turn', 'status': 'completed'}}}
    async def close(self): pass


def test_persistent_reply_resume_and_budget_uncertainty(setup, monkeypatch):
    agent, factory, settings, settlements = setup
    sent = []
    class CaptureCodex(FakeCodex):
        async def start_turn(self, ident, prompt, **options):
            sent.append((ident, options))
            return await super().start_turn(ident, prompt, **options)
    monkeypatch.setattr(module, 'CodexAppServer', CaptureCodex)
    settings.update(codex_model='global-model', codex_effort='medium',
                    codex_task_profiles={'router': {'model': 'router-model', 'effort': 'high'}})
    async def scenario():
        await agent.enqueue(1, '请解释当前任务')
        await agent.active[1]
        settings['codex_task_profiles'] = {'router': {'effort': 'low'}}
        await agent.enqueue(1, '先分析')
        await agent.active[1]
    asyncio.run(scenario())
    assert sent == [
        ('router-thread', {'model': 'router-model', 'effort': 'high'}),
        ('router-thread', {'model': 'global-model', 'effort': 'low'}),
    ]
    with factory() as s:
        row = s.get(RouterSession, 1)
        assert row.status == 'idle' and row.codex_thread_id == 'router-thread'
        msgs = s.scalars(select(RouterMessage).order_by(RouterMessage.id)).all()
        assert [m.role for m in msgs] == ['user', 'assistant', 'user', 'assistant']
        assert all('不属于本项目' not in m.content for m in msgs)
    assert FakeCodex.threads
    assert settlements[-1]['actual_micros'] is None


def test_notes_and_stale_version_do_not_start_model(setup):
    agent, factory, settings, _ = setup
    settings['router_agent_enabled'] = False
    asyncio.run(agent.enqueue(1, '控制备注', 1))
    assert not agent.active
    with pytest.raises(HTTPException) as exc:
        asyncio.run(agent.enqueue(1, '旧版本', 1))
    assert exc.value.status_code == 409
    with factory() as s:
        assert len(s.scalars(select(RouterMessage)).all()) == 1


def test_disconnect_requires_reconciliation_without_automatic_replay(setup, monkeypatch):
    agent, factory, settings, _ = setup
    class Broken(FakeCodex):
        async def events(self):
            yield {'method': 'runtime/disconnected', 'params': {}}
    monkeypatch.setattr(module, 'CodexAppServer', Broken)
    async def scenario():
        await agent.enqueue(1, '处理')
        await agent.active[1]
        with pytest.raises(HTTPException):
            await agent.enqueue(1, '重复')
        with factory() as s:
            row = s.get(RouterSession, 1)
            assert row.outcome_unknown is True
            version = row.state_version
        await agent.reconcile(1, '已确认后台进程退出，仅讨论建议没有执行动作', version)
    asyncio.run(scenario())
    with factory() as s:
        assert s.get(RouterSession, 1).outcome_unknown is False
        assert len(s.scalars(select(RouterMessage).where(RouterMessage.role == 'user')).all()) == 1


def test_missing_budget_does_not_accept_unschedulable_message(setup):
    agent, factory, settings, _ = setup
    settings['budget_reservation_estimate_micros'] = None
    with pytest.raises(HTTPException):
        asyncio.run(agent.enqueue(1, '不要丢失'))
    with factory() as s:
        assert not s.scalars(select(RouterMessage)).all()


def test_cleanup_failure_blocks_followup_and_still_accounts(setup, monkeypatch):
    agent, factory, _, settlements = setup
    class CloseFailure(FakeCodex):
        async def close(self):
            raise RuntimeError('cleanup failed')
    monkeypatch.setattr(module, 'CodexAppServer', CloseFailure)
    async def scenario():
        await agent.enqueue(1, '检查清理错误')
        await agent.active[1]
        with pytest.raises(HTTPException):
            await agent.enqueue(1, '不可自动重试')
    asyncio.run(scenario())
    assert settlements and not agent.active and agent.clients
    with factory() as s:
        assert s.get(RouterSession, 1).outcome_unknown is True
