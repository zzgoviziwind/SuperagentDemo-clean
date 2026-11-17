import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from superagent.core import db
from superagent.core.governance import Setting
from superagent.core.ingestion import ingest_event
from superagent.core.message_access import MessageAccess


@pytest.fixture
def store(tmp_path):
    engine = create_engine('sqlite:///' + str(tmp_path / 'access.db'))
    db.Base.metadata.create_all(engine)
    factory = sessionmaker(engine, expire_on_commit=False)
    with factory.begin() as session:
        session.add_all([db.Project(id=i, name=name, repo_path=str(tmp_path))
                         for i, name in [(1, '项目甲'), (2, '项目乙'), (3, '通用问答')]])
        session.add(Setting(key='dingtalk_request_access', value=MessageAccess(
            mode='all', project_ids=[1, 2], default_project_id=3,
            on_unmatched='ask').model_dump()))
    yield factory
    engine.dispose()


def receive(store, ident, content='你好', actor='person', metadata=None):
    return ingest_event({'source': 'dingtalk', 'external_id': ident, 'event_type': 'message.received',
        'actor_id': actor, 'thread_id': 'conversation', 'content': content,
        'metadata': {'profile': 'account', 'dws_event_type': 'user_im_message_receive_o2o_all', **(metadata or {})}},
        session_factory=store, actor_resolver=lambda *_: None)


def configure(store, **values):
    with store.begin() as session:
        row = session.get(Setting, 'dingtalk_request_access')
        row.value = MessageAccess.model_validate(row.value | values).model_dump()


def test_all_selected_off_and_person_denial(store):
    allowed = receive(store, 'one', '项目甲怎么用')
    assert allowed['task_id']
    configure(store, people=[{'actor_id': 'person', 'reply': False}])
    assert receive(store, 'two')['data']['routing_reason'] == 'sender_reply_disabled'
    configure(store, mode='selected', people=[{'actor_id': 'allowed', 'reply': True, 'project_ids': [1]}])
    assert receive(store, 'three')['data']['routing_status'] == 'ignored'
    assert receive(store, 'four', actor='allowed')['task_id']
    configure(store, mode='off')
    assert receive(store, 'five', actor='allowed')['data']['routing_status'] == 'ignored'


def test_asks_and_project_answer_resumes_original_repair(store):
    question = receive(store, 'one', '请修复导出超时')
    with store() as session:
        task = session.get(db.Task, question['task_id'])
        assert task.kind == 'reply' and task.project_id == 3
        assert '项目甲' in task.goal and '项目乙' in task.goal
    answer = receive(store, 'two', '项目甲')
    with store() as session:
        task = session.get(db.Task, answer['task_id'])
        assert task.kind == 'repair' and task.project_id == 1
        assert '请修复导出超时' in task.goal
        assert session.get(db.Event, question['id']).data['clarification_resolved_by'] == answer['id']


def test_person_candidate_scope_and_keyword_selection(store):
    configure(store, people=[{'actor_id': 'person', 'reply': True, 'project_ids': [2]}],
              project_hints=[{'project_id': 1, 'keywords': ['甲医院']}, {'project_id': 2, 'keywords': ['乙医院']}])
    result = receive(store, 'one', '乙医院的报告怎么看')
    with store() as session:
        assert session.get(db.Task, result['task_id']).project_id == 2


def test_history_is_scoped_to_sender_and_explicit_new_project_wins(store):
    receive(store, 'one', '项目甲怎么用')
    followup = receive(store, 'two', '再解释一下')
    other = receive(store, 'three', '再解释一下', actor='other')
    explicit = receive(store, 'four', '项目乙怎么用')
    with store() as session:
        assert session.get(db.Task, followup['task_id']).project_id == 1
        assert session.get(db.Task, other['task_id']).project_id == 3
        assert session.get(db.Task, explicit['task_id']).project_id == 2


def test_default_project_and_pending_are_explicit_choices(store):
    configure(store, on_unmatched='default')
    fallback = receive(store, 'one')
    with store() as session:
        assert session.get(db.Task, fallback['task_id']).project_id == 3
    configure(store, on_unmatched='pending')
    assert receive(store, 'two', actor='new')['data']['routing_reason'] == 'project_binding_missing_ambiguous_or_disabled'


def test_group_title_selects_project_and_disabled_project_cannot_be_chosen(store):
    result = receive(store, 'one', metadata={'conversation_title': '项目乙工作群'})
    with store() as session:
        assert session.get(db.Task, result['task_id']).project_id == 2
    explicit = receive(store, 'explicit', '项目甲怎么用', metadata={'conversation_title': '项目乙工作群'})
    with store() as session:
        assert session.get(db.Task, explicit['task_id']).project_id == 1
    with store.begin() as session:
        session.get(db.Project, 2).enabled = False
    blocked = receive(store, 'two', '项目乙', actor='new')
    with store() as session:
        assert session.get(db.Task, blocked['task_id']).project_id != 2


def test_reply_permission_is_rechecked_after_person_is_excluded(store):
    from superagent.core.delivery import reply_source_allowed
    result = receive(store, 'one', '项目甲怎么用')
    with store() as session:
        assert reply_source_allowed(session, session.get(db.Event, result['id']), result['task_id'])
    configure(store, people=[{'actor_id': 'person', 'reply': False}])
    with store() as session:
        assert not reply_source_allowed(session, session.get(db.Event, result['id']), result['task_id'])


def test_administrator_configuration_validates_owner_projects_and_default(store, monkeypatch):
    from fastapi import HTTPException
    from superagent.core import governance
    monkeypatch.setattr(db, 'Session', store)
    monkeypatch.delenv('SUPERAGENT_USERS_JSON', raising=False)
    monkeypatch.delenv('SUPERAGENT_API_TOKEN', raising=False)
    valid = MessageAccess(mode='all', project_ids=[1, 2], on_unmatched='ask', default_project_id=3).model_dump()
    governance._validate_setting('dingtalk_request_access', valid)
    for invalid in [valid | {'default_project_id': None}, valid | {'owner_user_id': 'missing'},
                    valid | {'project_ids': [99]}, valid | {'people': [{'actor_id': 'same'}, {'actor_id': 'same'}]}]:
        with pytest.raises(HTTPException):
            governance._validate_setting('dingtalk_request_access', invalid)


def test_unmapped_allowed_requester_reaches_semantic_worker_routing(store):
    import asyncio
    from superagent.core.semantic_routing import SemanticRoutingJob, SemanticRoutingService
    with store.begin() as session:
        session.add(Setting(key='semantic_routing_enabled', value=True))
    result = receive(store, 'semantic', '请分析项目甲的问题')
    assert result['data']['routing_status'] == 'semantic_pending'
    async def model(context):
        return {'action': 'create', 'task_id': None, 'state_version': None, 'kind': 'analysis', 'reason': '只读分析'}
    service = SemanticRoutingService(session_factory=store, actor_resolver=lambda *_: None, model_runner=model)
    asyncio.run(service.run_once())
    with store() as session:
        assert session.get(SemanticRoutingJob, result['id']).status == 'applied'
        event = session.get(db.Event, result['id'])
        assert session.get(db.Task, event.task_id).kind == 'analysis'


def test_configured_group_name_is_used_for_project_selection(store):
    from superagent.core.message_policy import DEFAULT_POLICY
    with store.begin() as session:
        session.add(Setting(key='dingtalk_response_policy', value=DEFAULT_POLICY | {
            'group_scope': 'selected', 'group_chat_ids': ['conversation'],
            'group_names': {'conversation': '项目乙协作群'}}))
    result = receive(store, 'named-group', '你好')
    with store() as session:
        assert session.get(db.Task, result['task_id']).project_id == 2
