import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from superagent.core.db import Base, Event, Project, Task
from superagent.core.governance import TaskOwner
from superagent.core.ingestion import ingest_event
from superagent.core.subscriptions import WorkerSubscription, EventTarget, subscribe


@pytest.mark.parametrize('invalid', ['none', 'terminal', 'foreign', 'unowned', 'unknown', 'cancelled', 'profile'])
def test_many_to_many_fanout_is_authorized_and_once(tmp_path, invalid):
    engine = create_engine('sqlite:///' + str(tmp_path / 'subscriptions.db'))
    Base.metadata.create_all(engine)
    sessions = sessionmaker(engine, expire_on_commit=False)
    actor = {'user_id': 'u', 'role': 'member', 'permissions': ['request'], 'project_ids': [1]}
    with sessions.begin() as s:
        s.add(Project(id=1, name='p', repo_path=str(tmp_path), dingtalk_chat_ids=['chat']))
        for task_id in range(1, 4):
            s.add(Task(id=task_id, project_id=1, title='t', goal='g'))
            s.add(TaskOwner(task_id=task_id, user_id='u'))
        s.flush()
        for task_id in range(1, 4):
            subscribe(s, project_id=1, source='dingtalk', thread_id='chat', task_id=task_id, actor=actor)
        task = s.get(Task, 3)
        if invalid == 'terminal': task.status = 'completed'
        if invalid == 'foreign': task.project_id = 2
        if invalid == 'unowned': s.get(TaskOwner, 3).user_id = 'other'
        if invalid == 'unknown': task.outcome_unknown = True
        row = s.scalar(select(WorkerSubscription).where(WorkerSubscription.task_id == 3))
        if invalid == 'cancelled': row.enabled = False
        if invalid == 'profile':
            from superagent.core.subscriptions import thread_key
            row.thread_key = thread_key('dingtalk', 'chat', 'another-account')
    payload = dict(source='dingtalk', external_id='e1', event_type='message.received', actor_id='a',
                   project_external_id='chat', thread_id='chat', content='这里还有一个截图', metadata={})
    first = ingest_event(payload, session_factory=sessions, actor_resolver=lambda *_: actor)
    duplicate = ingest_event(payload, session_factory=sessions, actor_resolver=lambda *_: actor)
    assert duplicate['duplicate']
    expected = 3 if invalid == 'none' else 2
    assert len(first['data']['target_task_ids']) == expected
    with sessions() as s:
        targets = s.scalars(select(EventTarget)).all()
        assert len(targets) == expected
        assert len(s.scalars(select(Event).where(Event.external_id.is_(None))).all()) == expected
        assert all(s.get(Event, target.message_event_id).task_id == target.task_id for target in targets)
        assert s.get(Task, 1).revision == s.get(Task, 2).revision == 2
    engine.dispose()

@pytest.mark.parametrize('status', ['running', 'waiting_approval', 'review_ready', 'paused'])
def test_fanout_preserves_interrupt_and_attachment_delivery(tmp_path, status):
    from superagent.core.ingestion import EventAttachmentJob, list_inbox
    engine = create_engine('sqlite:///' + str(tmp_path / 'interrupt.db'))
    Base.metadata.create_all(engine)
    sessions = sessionmaker(engine, expire_on_commit=False)
    actor = {'user_id': 'u', 'role': 'admin', 'permissions': ['request'], 'project_ids': [1]}
    with sessions.begin() as s:
        s.add(Project(id=1, name='p', repo_path=str(tmp_path), dingtalk_chat_ids=['chat']))
        s.add(Task(id=1, project_id=1, title='t', goal='g', status=status))
        s.flush()
        subscribe(s, project_id=1, source='dingtalk', thread_id='chat', task_id=1, actor=actor)
    payload = dict(source='dingtalk', external_id='e1', event_type='message.received', actor_id='a',
                   project_external_id='chat', thread_id='chat', content='这里是截图', metadata={},
                   attachments=[{'id': 'image'}])
    first = ingest_event(payload, session_factory=sessions, actor_resolver=lambda *_: actor)
    with sessions() as s:
        target = s.scalar(select(EventTarget))
        canonical = s.get(Event, target.message_event_id)
        assert canonical.source == 'dingtalk' and canonical.external_id is None
        assert canonical.data['requires_interrupt'] == (status in {'running', 'waiting_approval'})
        assert s.get(EventAttachmentJob, canonical.id).task_id == 1
        assert canonical.data['attachments_status'] == 'pending'
    assert len(list_inbox(routing_status='all', session_factory=sessions)['items']) == 1
    engine.dispose()

@pytest.mark.parametrize('change', [{'project_id': 2}, {'source': 'web'}, {'thread_id': 'foreign'}, {'task_id': 999}])
def test_subscription_creation_rejects_invalid_scope(tmp_path, change):
    engine = create_engine('sqlite:///' + str(tmp_path / 'scope.db'))
    Base.metadata.create_all(engine)
    sessions = sessionmaker(engine, expire_on_commit=False)
    actor = {'user_id': 'u', 'role': 'admin', 'permissions': ['request'], 'project_ids': [1]}
    with sessions.begin() as s:
        s.add(Project(id=1, name='p', repo_path=str(tmp_path), dingtalk_chat_ids=['chat', 'chat2']))
        s.add(Task(id=1, project_id=1, title='t', goal='g'))
        s.flush()
        values = dict(project_id=1, source='dingtalk', thread_id='chat', task_id=1, actor=actor)
        with pytest.raises(ValueError):
            subscribe(s, **(values | change))
    engine.dispose()


def test_worker_can_subscribe_multiple_threads_and_cancel_reenable(tmp_path):
    engine = create_engine('sqlite:///' + str(tmp_path / 'threads.db'))
    Base.metadata.create_all(engine)
    sessions = sessionmaker(engine, expire_on_commit=False)
    actor = {'user_id': 'u', 'role': 'admin', 'permissions': ['request'], 'project_ids': [1]}
    with sessions.begin() as s:
        s.add(Project(id=1, name='p', repo_path=str(tmp_path), dingtalk_chat_ids=['chat', 'chat2']))
        s.add(Task(id=1, project_id=1, title='t', goal='g'))
        s.flush()
        first = subscribe(s, project_id=1, source='dingtalk', thread_id='chat', task_id=1, actor=actor)
        s.get(WorkerSubscription, first['id']).enabled = False
        same = subscribe(s, project_id=1, source='dingtalk', thread_id='chat', task_id=1, actor=actor)
        assert same['id'] == first['id'] and same['enabled']
        subscribe(s, project_id=1, source='dingtalk', thread_id='chat2', task_id=1, actor=actor)
    for index, chat in enumerate(['chat', 'chat2']):
        ingest_event(dict(source='dingtalk', external_id=f'e{index}', event_type='message.received', actor_id='a',
                   project_external_id=chat, thread_id=chat, content='这是补充', metadata={}),
                   session_factory=sessions, actor_resolver=lambda *_: actor)
    with sessions() as s:
        assert len(s.scalars(select(WorkerSubscription)).all()) == 2
        assert len(s.scalars(select(EventTarget)).all()) == 2
        assert s.get(Task, 1).revision == 3
    engine.dispose()
