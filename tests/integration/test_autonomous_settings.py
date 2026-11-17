import asyncio
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from superagent.core import db
from superagent.connectors.common import digest
from superagent.core.delivery import DeliveryRecord, create_draft, deliver_automatically
from superagent.core.governance import Setting
from superagent.core.message_policy import DEFAULT_POLICY


@pytest.fixture
def delivery_store(tmp_path):
    engine = create_engine('sqlite:///' + str(tmp_path / 'auto.db'))
    db.Base.metadata.create_all(engine)
    factory = sessionmaker(engine, expire_on_commit=False)
    with factory.begin() as session:
        session.add(db.Project(id=1, name='项目', repo_path=str(tmp_path), enabled=True))
        session.add(db.Task(id=1, project_id=1, title='问题', goal='答复', kind='reply', status='review_ready'))
        session.add(db.Event(id=1, task_id=1, source='dingtalk', external_id='m1', content='你好',
            event_type='message.received', data={'routing_status': 'routed', 'thread_id': 'chat',
                'metadata': {'profile': 'offline', 'message_id': 'm1'}}))
        session.add(db.Artifact(task_id=1, revision=1, kind='summary', content='答复结果'))
    with factory.begin() as session:
        draft = create_draft(1, 1, '答复结果', settings=config(), db_session=session)
        task = session.get(db.Task, 1)
        session.add(db.Event(task_id=1, source='runtime', event_type='reply_decision', content='尚未得到答复',
            data={'decision': 'send', 'draft_id': draft['id'], 'source_event_id': 1,
                  'revision': task.revision, 'control_version': task.control_version, 'guidance_hash': digest('')}))
    yield factory
    engine.dispose()


class Client:
    calls = 0

    async def reply(self, chat, message, content, *, authorization, ledger, **kwargs):
        assert (chat, message, content) == ('chat', 'm1', '答复结果')
        if await ledger.claim(authorization.action_id, authorization.action_hash):
            self.calls += 1
            await ledger.finish(authorization.action_id, {'write_status': 'succeeded'})


def config(mode='auto_send'):
    values = {'external_delivery_enabled': True,
        'dingtalk_response_policy': DEFAULT_POLICY | {'delivery': mode},
        'connectors.dingtalk': {'enabled': True, 'profile': 'offline'}}
    return lambda key, default=None: values.get(key, default)


def test_automatic_reply_is_persisted_and_sent_once(delivery_store):
    client = Client()
    for _ in range(2):
        asyncio.run(deliver_automatically(session_factory=delivery_store, settings=config(), client=client))
    assert client.calls == 1
    with delivery_store() as session:
        assert session.scalars(select(DeliveryRecord)).one().result['write_status'] == 'succeeded'
        assert session.scalars(select(db.Event).where(db.Event.event_type == 'delivery.auto_authorized')).one()
        from superagent.core.event_groups import group_view
        assert group_view(session, session.get(db.Task, 1))['processing_status'] == 'reply_sent'


@pytest.mark.parametrize('mode', ['draft', 'approved_send'])
def test_manual_modes_do_not_auto_send(delivery_store, mode):
    client = Client()
    asyncio.run(deliver_automatically(session_factory=delivery_store, settings=config(mode), client=client))
    assert client.calls == 0


def test_review_rule_overrides_automatic_reply(delivery_store):
    with delivery_store.begin() as session:
        session.add(Setting(key='private_event_rules', value=[{'name': '人工确认', 'action': 'review'}]))
    client = Client()
    asyncio.run(deliver_automatically(session_factory=delivery_store, settings=config(), client=client))
    assert client.calls == 0


def test_old_revision_result_does_not_send(delivery_store):
    with delivery_store.begin() as session:
        session.get(db.Task, 1).revision = 2
    client = Client()
    asyncio.run(deliver_automatically(session_factory=delivery_store, settings=config(), client=client))
    assert client.calls == 0


@pytest.mark.parametrize('case', ['skip', 'review', 'old_message', 'manual_followup', 'new_message', 'reply_quiet', 'no_decision'])
def test_automatic_reply_respects_context_at_send_time(delivery_store, case):
    with delivery_store.begin() as session:
        decision = session.scalars(select(db.Event).where(db.Event.event_type == 'reply_decision')).one()
        source = session.get(db.Event, 1)
        if case in {'skip', 'review'}:
            decision.data = {**decision.data, 'decision': case}
        elif case == 'old_message':
            source.data = {**source.data, 'occurred_at': (datetime.now(timezone.utc) - timedelta(hours=4)).isoformat()}
        elif case == 'manual_followup':
            session.add(db.Event(task_id=1, source='dingtalk', external_id='own', event_type='message.received',
                content='我已经回答了', data={**source.data, 'routing_status': 'self_context',
                      'metadata': {'profile': 'offline', 'self_authored': True, 'reply_to_message_id': 'm1'}}))
        elif case == 'new_message':
            session.add(db.Event(task_id=1, source='dingtalk', external_id='new', event_type='message.received',
                content='新的问题', data=source.data))
        elif case == 'reply_quiet':
            hour = datetime.now(timezone(timedelta(hours=8))).hour
            session.add(Setting(key='private_event_rules', value=[
                {'name': '临时静默', 'action': 'reply_quiet', 'start_hour': hour, 'end_hour': (hour + 2) % 24}]))
        elif case == 'no_decision':
            session.delete(decision)
    client = Client()
    asyncio.run(deliver_automatically(session_factory=delivery_store, settings=config(), client=client))
    assert client.calls == 0
    with delivery_store() as session:
        assert session.scalars(select(DeliveryRecord)).first() is None
        if case in {'old_message', 'manual_followup'}:
            from superagent.core.event_groups import group_view
            assert group_view(session, session.get(db.Task, 1))['processing_status'] == 'reply_skipped'
            assert session.scalars(select(db.Approval)).one().status == 'expired'


def test_auto_send_does_not_pick_an_operator_created_draft(delivery_store):
    create_draft(1, 1, '人工另写的回复', session_factory=delivery_store, settings=config())
    client = Client()
    asyncio.run(deliver_automatically(session_factory=delivery_store, settings=config(), client=client))
    assert client.calls == 1
