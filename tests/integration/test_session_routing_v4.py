import asyncio
import json
from types import SimpleNamespace
import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from superagent.core.db import Base, Event, Project, Task, Artifact
from superagent.core.execution_nodes import ProjectNodeBinding
from superagent.core.governance import Setting, Principal
from superagent.core.sessions import RoutingSession, RoutingMessage
from superagent.core.semantic_routing import SemanticRoutingJob, SemanticRoutingService, validate_decision
from superagent.core.ingestion import ingest_event
from superagent.api import sessions as api


@pytest.fixture
def env(tmp_path, monkeypatch):
    engine = create_engine('sqlite:///' + str(tmp_path / 'routing-sessions.db'))
    Base.metadata.create_all(engine)
    sessions = sessionmaker(engine, expire_on_commit=False)
    with sessions.begin() as s:
        s.add(Project(id=1, name='project', repo_path=str(tmp_path), dingtalk_chat_ids=['chat']))
        s.add(Setting(key='semantic_routing_enabled', value=True))
    actor = {'user_id': 'u', 'role': 'admin', 'permissions': ['request'], 'project_ids': [1]}
    monkeypatch.setattr(api, 'Session', sessions)
    monkeypatch.setattr(api.gov, 'settings_snapshot', lambda: {})
    yield sessions, actor
    engine.dispose()


def receive(sessions, actor, external='e1'):
    return ingest_event(dict(source='dingtalk', external_id=external, event_type='message.received',
        actor_id='u', project_external_id='chat', thread_id='chat', content='请分析这个现象', metadata={}),
        session_factory=sessions, actor_resolver=lambda *_: actor)


def decision(action='confirm', kind='analysis', target=None, version=None):
    return {'action': action, 'kind': kind, 'task_id': target, 'state_version': version, 'reason': '判定说明'}


def request(role='admin', user='u'):
    return SimpleNamespace(state=SimpleNamespace(principal=Principal(user_id=user, role=role)))


async def no_dispatch(_):
    pass


def test_routing_session_input_output_review_and_reply(env, monkeypatch):
    sessions, actor = env
    first = receive(sessions, actor)
    inputs = []
    async def model(context):
        inputs.append(context)
        return decision('confirm') if len(inputs) == 1 else decision('create', 'reply')
    service = SemanticRoutingService(session_factory=sessions, actor_resolver=lambda *_: actor,
        model_runner=model, dispatch_hook=no_dispatch)
    monkeypatch.setattr(api, 'semantic_routing_service', service)
    asyncio.run(service.run_once())
    ident = f"semantic:{first['id']}"
    detail = api.session_detail(ident, request())
    assert detail['session']['kind'] == 'routing'
    assert any(message['role'] == 'assistant' for message in detail['messages'])
    assert json.loads(detail['messages'][0]['content'])['event_id'] == first['id']
    assert not detail['transcript']['complete']
    body = api.MessageIn(content='只需给我一个答复', expected_state_version=detail['session']['state_version'])
    asyncio.run(api.post_message(ident, body, request()))
    asyncio.run(service.run_once())
    result = api.session_detail(ident, request())
    assert inputs[1]['user_review'] == '只需给我一个答复'
    assert result['session']['worker_session_ids']
    assert {m['data'].get('status') for m in result['messages']} >= {'completed', 'visible_output', 'applied'}
    with sessions() as s:
        assert s.scalar(select(Task)).kind == 'reply'
    assert ident in {row['id'] for row in api.list_sessions(request())}
    assert ident not in {row['id'] for row in api.list_sessions(request('member'))}
    with pytest.raises(HTTPException):
        api.session_detail(ident, request('member'))


def test_applied_event_review_suggests_without_reapplying(env):
    sessions, actor = env
    first = receive(sessions, actor)
    inputs = []
    async def model(context):
        inputs.append(context)
        return decision('create')
    service = SemanticRoutingService(session_factory=sessions, actor_resolver=lambda *_: actor,
        model_runner=model, dispatch_hook=no_dispatch)
    asyncio.run(service.run_once())
    with sessions() as s:
        version = s.get(RoutingSession, first['id']).state_version
    service.enqueue_review(first['id'], '重新看看分派原因', version)
    asyncio.run(service.run_once())
    with sessions() as s:
        assert len(s.scalars(select(Task)).all()) == 1
        assert s.scalar(select(Task)).revision == 1
        assert s.scalar(select(RoutingMessage).where(RoutingMessage.data['status'].as_string() == 'suggestion'))
    assert inputs[1]['event_already_applied'] is True


def test_unknown_review_needs_reconcile_and_never_replays(env):
    sessions, actor = env
    first = receive(sessions, actor)
    calls = []
    async def model(context):
        calls.append(1)
        raise TimeoutError()
    service = SemanticRoutingService(session_factory=sessions, actor_resolver=lambda *_: actor, model_runner=model)
    asyncio.run(service.run_once())
    with sessions() as s:
        row = s.get(RoutingSession, first['id'])
        version = row.state_version
        assert row.outcome_unknown
    with pytest.raises(ValueError):
        service.enqueue_review(first['id'], '继续', version)
    asyncio.run(service.reconcile(first['id'], '已核验模型退出', version))
    asyncio.run(service.run_once())
    assert len(calls) == 1
    with sessions() as s:
        row = s.get(RoutingSession, first['id'])
        service.enqueue_review(first['id'], '现在重新复核', row.state_version)
    async def success(_): return decision('create')
    service.model_runner = success
    asyncio.run(service.run_once())
    with sessions() as s:
        assert len(s.scalars(select(Task)).all()) == 1


def test_review_sees_current_project_results_and_versions(env):
    sessions, actor = env
    with sessions.begin() as s:
        s.add(Task(id=1, project_id=1, title='known', goal='g'))
        s.add(Artifact(task_id=1, revision=1, kind='summary', content='近期执行结果'))
    first = receive(sessions, actor)
    async def initial(_): return decision()
    service = SemanticRoutingService(session_factory=sessions, actor_resolver=lambda *_: actor,
        model_runner=initial, dispatch_hook=no_dispatch)
    asyncio.run(service.run_once())
    with sessions.begin() as s:
        s.get(Task, 1).state_version = 3
        version = s.get(RoutingSession, first['id']).state_version
    service.enqueue_review(first['id'], '关联已知任务', version)
    async def review(context):
        assert context['tasks'][0]['state_version'] == 3
        assert context['shared_state']['recent_results'][0]['content'] == '近期执行结果'
        return decision('dispatch', target=1, version=3)
    service.model_runner = review
    asyncio.run(service.run_once())
    with sessions() as s:
        assert s.get(Task, 1).revision == 2
        assert s.get(SemanticRoutingJob, first['id']).context['tasks'][0]['state_version'] == 1


def test_transcript_reads_only_owned_thread_and_filters_hidden_items(env, monkeypatch):
    sessions, actor = env
    first = receive(sessions, actor)
    with sessions.begin() as s:
        s.get(SemanticRoutingJob, first['id']).thread_id = 'owned-thread'
    seen = []
    class Client:
        async def read_thread(self, thread_id, include_turns):
            seen.append((thread_id, include_turns))
            return {'thread': {'id': thread_id, 'turns': [{'id': 'turn', 'items': [
                {'id': 'input', 'type': 'userMessage', 'content': [{'type': 'text', 'text': 'original'}]},
                {'id': 'output', 'type': 'agentMessage', 'text': 'visible answer'},
                {'id': 'tool', 'type': 'commandExecution', 'command': 'test'},
                {'id': 'internal', 'type': 'reasoning', 'content': 'private internal reasoning'}]}]}}
    service = SemanticRoutingService(session_factory=sessions)
    service.clients[first['id']] = Client()
    monkeypatch.setattr(api, 'semantic_routing_service', service)
    transcript = asyncio.run(api.session_transcript(f"semantic:{first['id']}", request()))
    assert transcript['complete'] and transcript['source'] == 'codex_thread'
    assert [item['id'] for item in transcript['items']] == ['input', 'output', 'tool']
    assert seen == [('owned-thread', True)]
    with pytest.raises(HTTPException):
        asyncio.run(api.session_transcript(f"semantic:{first['id']}", request('member')))
    assert len(seen) == 1


def test_legacy_transcript_and_stale_review_are_explicit(env):
    sessions, actor = env
    with sessions.begin() as s:
        s.add(Event(id=1, source='dingtalk', external_id='old', event_type='message.received', content='old', data={}))
        s.add(SemanticRoutingJob(event_id=1, project_id=1, context={'tasks': [], 'content': 'old'}, output='old output', status='rejected'))
    detail = api.session_detail('semantic:1', request())
    assert detail['messages'][0]['data']['historical_snapshot']
    assert not detail['transcript']['complete']
    service = SemanticRoutingService(session_factory=sessions)
    with pytest.raises(ValueError):
        service.enqueue_review(1, 'new review', 999)
    with sessions() as s:
        assert not list(s.scalars(select(RoutingMessage)))


def test_reply_schema_and_write_safety():
    assert validate_decision(decision('create', 'reply'), {'tasks': []})['kind'] == 'reply'
    with pytest.raises(ValueError):
        validate_decision(decision('create', 'shell'), {'tasks': []})


def test_real_model_adapter_resumes_same_thread_for_review(env, monkeypatch, tmp_path):
    from superagent.core import model_usage, local_agents, scheduler
    from superagent.runtime import codex
    sessions, actor = env
    first = receive(sessions, actor)
    monkeypatch.setenv('SUPERAGENT_ROUTER_ROOT', str(tmp_path / 'router'))
    monkeypatch.setattr(model_usage, 'reserve_model_run', lambda *a, **k: {'id': None, 'billing_mode': 'subscription'})
    monkeypatch.setattr(local_agents, 'client_options', lambda: {'use_existing_login': True, 'codex_home': str(tmp_path)})
    monkeypatch.setattr(scheduler, 'executable', lambda: 'fake')
    monkeypatch.setattr(api.gov, 'settings_snapshot', lambda: {})
    calls = []
    class Client:
        def __init__(self, executable, cwd, **options):
            assert options['use_existing_login']
            self.turn_id = None
        async def start(self): pass
        async def close(self): pass
        async def start_thread(self, cwd, instructions, read_only):
            assert read_only and 'reply' in instructions
            calls.append('start')
            return {'id': 'same-real-thread'}
        async def resume_thread(self, thread_id, read_only):
            assert thread_id == 'same-real-thread' and read_only
            calls.append('resume')
            return {'id': thread_id}
        async def start_turn(self, thread_id, prompt, **kwargs):
            self.turn_id = f'turn-{len(calls)}'
            calls.append(json.loads(prompt))
            return {'id': self.turn_id}
        async def events(self):
            yield {'method': 'item/completed', 'params': {'threadId': 'same-real-thread', 'turnId': self.turn_id,
                'item': {'id': self.turn_id + '-answer', 'type': 'agentMessage', 'text': json.dumps(decision('confirm'))}}}
            yield {'method': 'turn/completed', 'params': {'threadId': 'same-real-thread',
                'turn': {'id': self.turn_id, 'status': 'completed'}}}
    monkeypatch.setattr(codex, 'CodexAppServer', Client)
    service = SemanticRoutingService(session_factory=sessions, actor_resolver=lambda *_: actor, dispatch_hook=no_dispatch)
    asyncio.run(service.run_once())
    with sessions() as s:
        version = s.get(RoutingSession, first['id']).state_version
    service.enqueue_review(first['id'], '复核原判断', version)
    asyncio.run(service.run_once())
    assert calls[0] == 'start' and calls[2] == 'resume'
    assert calls[3]['user_review'] == '复核原判断'
    with sessions() as s:
        messages = list(s.scalars(select(RoutingMessage).where(RoutingMessage.role == 'assistant')))
        assert len(messages) == 2
        assert {m.data['thread_id'] for m in messages} == {'same-real-thread'}
        assert len({m.data['turn_id'] for m in messages}) == 2


def test_worker_session_preserves_kind_and_task_kind(env):
    sessions, actor = env
    with sessions.begin() as s:
        for ident, kind in enumerate(['reply', 'analysis', 'repair'], start=1):
            s.add(Task(id=ident, title=kind, kind=kind, goal='g', project_id=1))
    for ident, kind in enumerate(['reply', 'analysis', 'repair'], start=1):
        detail = api.session_detail(f'worker:{ident}', request())
        assert detail['session']['kind'] == 'worker'
        assert detail['session']['task_kind'] == kind
        assert not detail['transcript']['complete']


def test_direct_message_context_expresses_reply_policy_and_default_project(env):
    sessions, actor = env
    with sessions.begin() as s:
        s.add(Setting(key='dingtalk_response_policy', value={'direct_messages': 'reply', 'group_messages': 'requests',
            'delivery': 'draft', 'default_project_id': 1}))
    first = ingest_event(dict(source='dingtalk', external_id='dm', event_type='message.received', actor_id='u',
        project_external_id='direct-user', thread_id='direct-user', content='请分析这句话如何理解',
        metadata={'dws_event_type': 'user_im_message_receive_o2o_all'}),
        session_factory=sessions, actor_resolver=lambda *_: actor)
    async def model(context):
        assert context['conversation_type'] == 'direct'
        assert context['source_policy']['direct_messages'] == 'reply'
        return decision('confirm', 'reply')
    service = SemanticRoutingService(session_factory=sessions, actor_resolver=lambda *_: actor,
        model_runner=model, dispatch_hook=no_dispatch)
    asyncio.run(service.run_once())
    with sessions() as s:
        version = s.get(RoutingSession, first['id']).state_version
    service.enqueue_review(first['id'], '按私聊策略答复', version)
    async def review(context):
        assert context['conversation_type'] == 'direct'
        return decision('create', 'reply')
    service.model_runner = review
    asyncio.run(service.run_once())
    with sessions() as s:
        assert s.scalar(select(Task)).kind == 'reply'


@pytest.mark.parametrize('status', ['running', 'review_ready'])
def test_worker_transcript_reconnects_once_after_execution_client_closes(env, monkeypatch, tmp_path, status):
    from superagent.core import scheduler, local_agents
    from superagent.runtime import codex
    sessions, actor = env
    with sessions.begin() as s:
        s.add(Task(id=1, title='reply', goal='g', project_id=1, kind='reply', status=status,
            codex_thread_id='worker-thread', codex_turn_id='turn-2', state_version=7))
    calls = []
    class ClosingClient:
        async def read_thread(self, thread_id, include_turns):
            calls.append(('execution-read', thread_id, include_turns))
            raise ConnectionError('execution client is closing')
        async def close(self):
            raise AssertionError('execution owner controls cleanup')
    class Reader:
        def __init__(self, executable, cwd, **options):
            calls.append(('reader-create', options))
        async def start(self): calls.append(('reader-start',))
        async def read_thread(self, thread_id, include_turns):
            calls.append(('reader-read', thread_id, include_turns))
            return {'thread': {'id': thread_id, 'turns': [
                {'id': f'turn-{index}', 'items': [
                    {'id': f'input-{index}', 'type': 'userMessage', 'content': []},
                    {'id': f'output-{index}', 'type': 'agentMessage', 'text': 'answer'}]}
                for index in [1, 2]]}}
        async def close(self): calls.append(('reader-close',))
    monkeypatch.setenv('SUPERAGENT_ROUTER_ROOT', str(tmp_path / 'router'))
    monkeypatch.setattr(scheduler.scheduler, 'clients', {1: ClosingClient()})
    monkeypatch.setattr(scheduler, 'executable', lambda: 'fake')
    monkeypatch.setattr(local_agents, 'client_options', lambda: {'use_existing_login': True})
    monkeypatch.setattr(codex, 'CodexAppServer', Reader)
    transcript = asyncio.run(api.session_transcript('worker:1', request()))
    assert transcript['complete'] and transcript['source'] == 'codex_thread'
    assert len(transcript['items']) == 4
    assert [call[0] for call in calls] == ['execution-read', 'reader-create', 'reader-start', 'reader-read', 'reader-close']
    assert calls[0][1:] == calls[3][1:] == ('worker-thread', True)
    with sessions() as s:
        task = s.get(Task, 1)
        assert (task.status, task.state_version, task.codex_turn_id) == (status, 7, 'turn-2')
        assert not s.scalars(select(Event)).all()


def test_remote_transcript_close_failure_keeps_remote_reader_boundary(env, monkeypatch):
    from superagent.core import scheduler
    from superagent.runtime import codex
    sessions, actor = env
    with sessions.begin() as s:
        s.add(Task(id=1, title='remote', goal='g', project_id=1, status='review_ready', codex_thread_id='remote-thread'))
        s.add(ProjectNodeBinding(project_id=1, node_id='remote-node'))
    calls = []
    class ClosingClient:
        async def read_thread(self, thread_id, include_turns):
            calls.append(thread_id)
            raise ConnectionError()
    def forbidden_reader(*args, **kwargs):
        raise AssertionError('remote thread must not use a local reader')
    monkeypatch.setattr(scheduler.scheduler, 'clients', {1: ClosingClient()})
    monkeypatch.setattr(codex, 'CodexAppServer', forbidden_reader)
    transcript = asyncio.run(api.session_transcript('worker:1', request()))
    assert not transcript['complete']
    assert '远端' in transcript['reason']
    assert calls == ['remote-thread']


def test_failed_transcript_reader_is_closed_without_further_retry(env, monkeypatch, tmp_path):
    from superagent.core import scheduler, local_agents
    from superagent.runtime import codex
    sessions, actor = env
    with sessions.begin() as s:
        s.add(Task(id=1, title='local', goal='g', project_id=1, status='review_ready', codex_thread_id='local-thread'))
    calls = []
    class ClosingClient:
        async def read_thread(self, *args, **kwargs):
            calls.append('execution-read')
            raise ConnectionError()
    class Reader:
        def __init__(self, *args, **kwargs): calls.append('reader-create')
        async def start(self): calls.append('reader-start')
        async def read_thread(self, *args, **kwargs):
            calls.append('reader-read')
            raise TimeoutError()
        async def close(self): calls.append('reader-close')
    monkeypatch.setenv('SUPERAGENT_ROUTER_ROOT', str(tmp_path / 'router'))
    monkeypatch.setattr(scheduler.scheduler, 'clients', {1: ClosingClient()})
    monkeypatch.setattr(scheduler, 'executable', lambda: 'fake')
    monkeypatch.setattr(local_agents, 'client_options', lambda: {})
    monkeypatch.setattr(codex, 'CodexAppServer', Reader)
    transcript = asyncio.run(api.session_transcript('worker:1', request()))
    assert not transcript['complete']
    assert 'TimeoutError' in transcript['reason']
    assert calls == ['execution-read', 'reader-create', 'reader-start', 'reader-read', 'reader-close']
