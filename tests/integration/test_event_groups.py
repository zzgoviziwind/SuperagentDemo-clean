import json
from types import SimpleNamespace
import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from superagent.core.db import Base, Task, Project, Event, Artifact
from superagent.core.governance import Principal
from superagent.core.subscriptions import EventTarget
from superagent.core.event_groups import collect_collaboration_results, collect_worker_requests
from superagent.api import event_groups as api


@pytest.fixture
def setup(tmp_path, monkeypatch):
    engine = create_engine('sqlite:///' + str(tmp_path / 'groups.db'))
    Base.metadata.create_all(engine)
    factory = sessionmaker(engine, expire_on_commit=False)
    monkeypatch.setattr(api, 'Session', factory)
    with factory.begin() as s:
        s.add(Project(id=1, name='demo', repo_path=str(tmp_path)))
        s.add_all([Task(id=i, title=f'group {i}', goal='investigate', project_id=1,
                        owner_id='u') for i in (1, 2)])
        s.add(Event(id=1, task_id=1, source='redmine', external_id='issue',
                    event_type='message', content='evidence'))
        s.add(Event(id=2, task_id=2, source='redmine', event_type='message',
                    content='evidence', data={'source_event_id': 1}))
        s.add(EventTarget(event_id=1, task_id=2, message_event_id=2))
    yield factory, SimpleNamespace(state=SimpleNamespace(principal=Principal('u', 'member')))
    engine.dispose()


def test_fanout_outcomes_are_independent_and_completion_is_not_resolution(setup):
    factory, request = setup
    api.resolve(1, 1, api.Resolution(status='resolved', evidence='verified file', expected_state_version=1), request)
    assert api.detail(1, request)['group']['pending_event_count'] == 0
    assert api.detail(2, request)['group']['pending_event_count'] == 1
    assert len(api.detail(2, request)['events']) == 1
    with factory.begin() as s:
        s.get(Task, 2).status = 'completed'
    assert api.detail(2, request)['group']['processing_status'] == 'needs_review'
    with pytest.raises(HTTPException) as stale:
        api.resolve(1, 1, api.Resolution(status='pending', evidence='new finding', expected_state_version=1), request)
    assert stale.value.status_code == 409
    api.resolve(1, 1, api.Resolution(status='pending', evidence='new finding', expected_state_version=2), request)
    assert api.detail(1, request)['group']['pending_event_count'] == 1


def test_index_counts_use_same_state_and_project_scope_as_filtered_rows(setup):
    factory, _ = setup
    request = SimpleNamespace(state=SimpleNamespace(principal=Principal('root', 'admin')))
    with factory.begin() as s:
        s.add(Project(id=2, name='other', repo_path='another'))
        s.get(Task, 1).status = 'waiting_resource'
        s.get(Task, 2).status = 'completed'
        s.add(Task(id=3,title='closed',goal='done',project_id=2,owner_id='u',status='cancelled'))
        s.add(Task(id=4,title='completed',goal='done',project_id=2,owner_id='u',status='completed'))
        s.add(Event(id=3,source='dingtalk',external_id='unassigned',event_type='message.received',
                    content='请帮核对',data={'routing_status':'pending_confirmation'}))
    all_items = api.event_index(request)
    assert all_items['total'] == 5
    assert all_items['counts'] == {'attention':1,'review':1,'closed':1,'completed':1,'triage':1}
    filtered = api.event_index(request, project_id=1, status='attention', limit=1)
    assert filtered['counts'] == {'attention':1,'review':1}
    assert filtered['total'] == 1
    assert filtered['items'][0]['key'] == 'group:1'
    first = api.event_index(request, project_id=1, status='needs_action', limit=1)
    second = api.event_index(request, project_id=1, status='needs_action', limit=1, offset=1)
    assert first['total'] == second['total'] == 2
    assert first['has_more'] and not second['has_more']
    assert {first['items'][0]['state'], second['items'][0]['state']} == {'attention', 'review'}
    finished = api.event_index(request, project_id=2, status='finished')
    assert finished['total'] == 2
    assert {item['state'] for item in finished['items']} == {'completed', 'closed'}
    closed = api.event_index(request, project_id=2, status='closed')
    assert closed['total'] == 1
    assert [item['key'] for item in closed['items']] == ['group:3']


def test_end_accepted_event_with_pending_source_preserves_evidence(setup, monkeypatch):
    import asyncio
    from superagent import main
    factory, request = setup
    monkeypatch.setattr(main, 'Session', factory)
    with factory.begin() as s:
        s.get(Task, 2).status = 'completed'
        s.add(Artifact(task_id=2, revision=1, kind='summary', content='已验收的分析'))
    assert api.event_index(request, status='needs_action')['total'] == 1
    updated = asyncio.run(main.control(2, main.ControlIn(action='cancel', expected_state_version=1), request))
    assert updated['status'] == 'cancelled'
    assert api.event_index(request, status='needs_action')['total'] == 0
    assert api.event_index(request, status='finished')['items'][0]['state'] == 'closed'
    assert api.detail(2, request)['events'][0]['processing']['status'] == 'pending'
    with factory() as s:
        assert s.scalars(select(Artifact).where(Artifact.task_id == 2)).one().content == '已验收的分析'


def test_ownership_and_unrelated_event_denied(setup):
    _, request = setup
    with pytest.raises(HTTPException) as missing:
        api.resolve(1, 999, api.Resolution(status='resolved', evidence='x', expected_state_version=1), request)
    assert missing.value.status_code == 404
    request.state.principal = Principal('other', 'member')
    assert api.groups(request) == []
    with pytest.raises(HTTPException):
        api.detail(1, request)


@pytest.mark.parametrize('parent_status', ['paused', 'running', 'waiting_input'])
def test_delegation_idempotency_and_result_returns_once_without_resuming_pause(setup, parent_status):
    factory, request = setup
    body = api.Delegate(goal='check evidence', expected_state_version=1, request_key='one')
    result = api.delegate(1, body, request)
    assert api.delegate(1, body, request)['id'] == result['id']
    child_id = result['data']['child_group_id']
    with factory.begin() as s:
        s.get(Task, 1).status = parent_status
        s.get(Task, child_id).status = 'review_ready'
        s.add(Artifact(task_id=child_id, revision=1, kind='summary', content='evidence'))
    with factory.begin() as s:
        collect_collaboration_results(s)
    with factory.begin() as s:
        collect_collaboration_results(s)
        assert s.get(Task, 1).status == ('queued' if parent_status == 'waiting_input' else parent_status)
        assert len(list(s.scalars(select(Event).where(Event.event_type == 'collaboration_result')))) == (0 if parent_status == 'running' else 1)


def test_worker_requests_are_bounded_readonly_and_do_not_recurse(setup):
    factory, _ = setup
    with factory.begin() as s:
        s.get(Task, 1).status = 'waiting_input'
        s.add(Artifact(task_id=1, revision=1, kind='summary', content=json.dumps({
            'collaboration_requests': [{'goal': f'check {i}', 'kind': 'repair'} for i in range(5)]})))
    with factory.begin() as s:
        collect_worker_requests(s)
    with factory.begin() as s:
        collect_worker_requests(s)
        children = list(s.scalars(select(Task).where(Task.id > 2)))
        assert len(children) == 3 and all(t.kind == 'analysis' for t in children)
        for child in children:
            child.status = 'waiting_input'
            s.add(Artifact(task_id=child.id, revision=1, kind='summary', content='{"collaboration_requests":[{"goal":"recurse"}]}'))
    with factory.begin() as s:
        collect_worker_requests(s)
        assert len(list(s.scalars(select(Task)))) == 5


def test_http_contract_and_validation(setup):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    _, request = setup
    app = FastAPI()
    @app.middleware('http')
    async def principal(req, call_next):
        req.state.principal = request.state.principal
        return await call_next(req)
    app.include_router(api.router)
    with TestClient(app) as client:
        assert len(client.get('/api/v1/event-groups').json()) == 2
        assert client.get('/api/v1/event-groups/1').json()['events'][0]['processing']['status'] == 'pending'
        body = {'status': 'resolved', 'evidence': 'checked', 'expected_state_version': 1}
        assert client.post('/api/v1/event-groups/1/events/1/resolution', json=body).status_code == 200
        assert client.post('/api/v1/event-groups/1/events/1/resolution', json=body).status_code == 409
        assert client.post('/api/v1/event-groups/1/events/1/resolution', json={**body, 'status': 'invented'}).status_code == 422

def test_index_search_and_rename_preserve_execution(setup):
    factory, request = setup
    assert len(api.event_index(request, q='evidence')['items']) == 2
    with factory.begin() as s:
        s.add(Event(task_id=1, source='web', event_type='message', content='unique supplement'))
    index = api.event_index(request, q='unique supplement')
    assert len(index['items']) == 1
    assert len(index['items'][0]['messages']) == 2
    renamed = api.rename(1, api.Rename(title='新的事件名称', expected_state_version=1), request)
    assert renamed['title'] == '新的事件名称'
    assert renamed['goal'] == 'investigate'
    assert renamed['revision'] == 1
    assert len(api.event_index(request, q='新的事件名称')['items']) == 1
    with pytest.raises(HTTPException) as stale:
        api.rename(1, api.Rename(title='过期名称', expected_state_version=1), request)
    assert stale.value.status_code == 409
    request.state.principal = Principal('other', 'member')
    assert api.event_index(request)['items'] == []


@pytest.mark.parametrize(('status', 'notes', 'extra', 'expected'), [
    ({'id': 3, 'is_closed': True}, '', [{'property': 'cf', 'name': '7'}], 'closed'),
    ({'id': 3, 'is_closed': False}, '', [], 'triage'),
    ({'id': 3}, '', [], 'triage'),
    ({'id': 3, 'is_closed': True}, '请再核对新问题', [], 'triage'),
    ({'id': 3, 'is_closed': True}, '', [{'property': 'attr', 'name': 'assigned_to_id'}], 'triage'),
    ({'id': 3, 'is_closed': True}, '', [{'property': 'attachment', 'name': '1'}], 'triage'),
])
def test_redmine_closed_status_notice_is_recorded_without_project_or_review(setup, status, notes, extra, expected):
    from superagent.connectors.redmine import RedmineClient, RedminePoller
    from superagent.core.ingestion import ingest_event
    from superagent.core.semantic_routing import SemanticRoutingJob

    factory, request = setup
    request.state.principal = Principal('admin', 'admin')
    poller = RedminePoller(RedmineClient('https://redmine.invalid', 'fake'), None, None, [344], 158)
    recorded = []
    changes = [{'property': 'attr', 'name': 'status_id', 'old_value': '9', 'new_value': '3'}, *extra]
    journals = [{'id': 1, 'created_on': '2026-11-17T05:32:04Z', 'user': {'id': 158},
                 'notes': notes, 'details': changes}]
    if expected == 'closed':
        journals.insert(0, {'id': 2, 'created_on': '2026-11-17T05:31:54Z', 'user': {'id': 158},
                            'notes': ' ', 'details': [{'property': 'attr', 'name': 'status_id',
                                                       'old_value': '8', 'new_value': '9'}]})
    issue = {'id': 24701, 'project': {'id': 344}, 'status': status, 'assigned_to': {'id': 158},
             'updated_on': '2026-11-17T05:32:04Z', 'journals': journals, 'attachments': [{'id': 1}]}
    for payload in poller._events(issue, None):
        if payload['event_type'] == 'issue.updated':
            continue  # An existing, unchanged issue snapshot is not re-emitted by the poller.
        receipt = ingest_event(payload, session_factory=factory,
                               actor_resolver=lambda *_: {'user_id': 'admin', 'role': 'admin'})
        assert receipt['task_id'] is None
        recorded.append(receipt['id'])

    items = api.event_index(request, status=expected, source='redmine')['items']
    assert len(items) == 1 and items[0]['group'] is None
    assert [m['id'] for m in items[0]['messages']] == recorded
    reason = ('redmine_closed_status_notice' if expected == 'closed'
              else 'project_binding_missing_ambiguous_or_disabled')
    assert all(m['data']['routing_reason'] == reason for m in items[0]['messages'])
    if expected == 'closed':
        assert len(recorded) == 2
        assert api.event_index(request, status='triage', source='redmine')['items'] == []
        with factory() as s:
            assert not s.scalars(select(SemanticRoutingJob).where(SemanticRoutingJob.event_id.in_(recorded))).all()
            assert not s.scalars(select(EventTarget).where(EventTarget.event_id.in_(recorded))).all()


def test_timeline_counts_and_manual_close_link_preserve_messages(setup):
    from superagent.core.delivery import reply_source_allowed
    from superagent.core.ingestion import ingest_event, retry_routing
    from superagent.core.semantic_routing import SemanticRoutingJob, SemanticRoutingService

    factory, request = setup
    request.state.principal = Principal('admin', 'admin')

    def receive(mid, text, quote=None, thread='chat', profile='corp', sender='测试人员'):
        metadata = {'profile': profile, 'message_id': mid, 'sender_name': sender}
        if quote:
            metadata['reply_to_message_id'] = quote
        return ingest_event({'source': 'dingtalk', 'external_id': f'{profile}:{thread}:{mid}',
            'event_type': 'message.received', 'actor_id': 'sender', 'thread_id': thread,
            'content': text, 'metadata': metadata}, session_factory=factory, actor_resolver=lambda *_: None)['id']

    first = receive('1', '测试体检号我们有吗')
    follow = receive('2', '需现场处理吗', '1')
    other = receive('3', '新项目的报告哪里看')
    different_chat = receive('4', '另一会话消息', '1', thread='another')
    different_profile = receive('5', '另一组织消息', '1', profile='another')
    ack = receive('6', '好')
    notice = receive('7', '请查收你的上周考勤统计 11 月 9 日至 15 日', sender='考勤小助手')

    index = api.event_index(request, source='dingtalk', limit=1)
    assert index['total'] == 6 and index['counts'] == {'triage': 4, 'closed': 2}
    assert index['has_more']
    assert index['items'][0]['state'] == 'triage'
    matched = api.event_index(request, q='现场处理')['items'][0]
    assert [m['id'] for m in matched['messages']] == [first, follow]
    closed = api.event_index(request, source='dingtalk', status='closed')['items']
    assert {e['messages'][0]['id']: e['messages'][0]['triage_reason'] for e in closed} == {
        ack: 'acknowledgement_only', notice: 'attendance_notice'}

    with factory.begin() as s:
        s.add(SemanticRoutingJob(event_id=first, project_id=1, status='queued', context={}))
        s.get(Event, first).data = {**s.get(Event, first).data, 'routing_status': 'semantic_pending'}
    api.triage(api.Triage(action='close', event_ids=[first, follow]), request)
    with pytest.raises(ValueError, match='待确认'):
        retry_routing(follow, session_factory=factory)
    assert SemanticRoutingService(session_factory=factory).schedule_pending(follow)['checked'] == 0
    remaining = api.event_index(request, source='dingtalk', status='triage')['items']
    assert {e['messages'][0]['id'] for e in remaining} == {other, different_chat, different_profile}

    with pytest.raises(HTTPException) as stale:
        api.triage(api.Triage(action='link', event_ids=[first, follow], group_id=1, expected_state_version=0), request)
    assert stale.value.status_code == 409
    linked = api.triage(api.Triage(action='link', event_ids=[first, follow], group_id=1, expected_state_version=1), request)
    assert {m['id'] for m in linked['messages']} == {1, first, follow}
    assert linked['group']['revision'] == 2
    with factory() as s:
        assert s.get(SemanticRoutingJob, first).status == 'closed'
        row = s.get(Event, first)
        assert row.content == '测试体检号我们有吗'
        assert row.data['metadata']['message_id'] == '1'
        assert row.event_type == 'message.received'
        target = s.scalar(select(EventTarget).where(EventTarget.event_id == first))
        worker_message = s.get(Event, target.message_event_id)
        assert worker_message.id > notice and worker_message.event_type == 'message'
        assert worker_message.content == row.content and not reply_source_allowed(s, worker_message, 1)
        assert not reply_source_allowed(s, row, 1)
    with pytest.raises(HTTPException) as duplicate:
        api.triage(api.Triage(action='link', event_ids=[first], group_id=2, expected_state_version=1), request)
    assert duplicate.value.status_code == 409

    with factory.begin() as s:
        s.get(Project, 1).dingtalk_chat_ids = ['chat']
    incoming = ingest_event({'source': 'dingtalk', 'external_id': 'authorized-follow-up',
        'event_type': 'message.received', 'actor_id': 'sender', 'thread_id': 'chat', 'project_external_id': 'chat',
        'content': '再补充一个测试条件', 'metadata': {'profile': 'corp', 'message_id': '8', 'reply_to_message_id': '1'}},
        session_factory=factory, actor_resolver=lambda *_: {
            'user_id': 'admin', 'role': 'admin', 'project_ids': [1], 'permissions': ['request']})
    assert incoming['task_id'] == 1


def test_closed_receipt_can_seed_new_event_and_active_model_cannot_be_reassigned(setup):
    from superagent.core.semantic_routing import SemanticRoutingJob
    factory, request = setup
    with factory.begin() as s:
        s.add(Event(id=5, source='dingtalk', external_id='closed', event_type='message.received',
                    content='之前关闭的消息', data={'routing_status': 'dismissed'}))
        s.add(Event(id=6, source='dingtalk', external_id='working', event_type='message.received',
                    content='正在识别的消息', data={'routing_status': 'semantic_pending'}))
        s.add(SemanticRoutingJob(event_id=6, project_id=1, status='running', context={}))
    body = api.Triage(action='create', event_ids=[5], title='新事件', goal='核对此消息', project_id=1)
    with pytest.raises(HTTPException) as forbidden:
        api.triage(body, request)
    assert forbidden.value.status_code == 403
    request.state.principal = Principal('admin', 'admin')
    with pytest.raises(HTTPException) as running:
        api.triage(api.Triage(action='close', event_ids=[5, 6]), request)
    assert running.value.status_code == 409
    result = api.triage(body, request)
    assert result['group']['title'] == '新事件' and result['state'] == 'active'
    assert result['messages'][0]['data']['routing_status'] == 'manually_linked'
