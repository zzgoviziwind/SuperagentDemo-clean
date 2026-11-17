import asyncio
import base64
import importlib
import json
from collections import defaultdict

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from superagent.core import feishu_decisions as notices
from superagent.core.db import Approval, Base, Project, Task
from superagent.core.feishu_cards import CardApprovals


def test_card_mode_sends_private_buttons_without_workbench_url(monkeypatch):
    monkeypatch.delenv('SUPERAGENT_SERVICE_MODE', raising=False)
    monkeypatch.delenv('SUPERAGENT_FEISHU_WORKBENCH_URL', raising=False)
    for name, value in {'ENABLED': '1', 'MODE': 'card', 'APP_ID': 'cli_test',
                        'APP_SECRET': 'secret', 'OPEN_ID': 'ou_owner', 'OWNER_ID': 'admin'}.items():
        monkeypatch.setenv('SUPERAGENT_FEISHU_' + name, value)
    config = notices.Config.load()
    cards = CardApprovals(None, None, config, None)
    sent = []
    monkeypatch.setattr(notices, '_post', lambda *args: sent.append(args))
    cards._send(config, 'tenant_token', 2, 4, notices.COMMAND)
    url, payload, _ = sent[0]
    assert url.endswith('receive_id_type=open_id') and payload['receive_id'] == 'ou_owner'
    assert payload['msg_type'] == 'interactive'
    buttons = json.loads(payload['content'])['body']['elements'][1:]
    assert [button['behaviors'] for button in buttons] == [
        [{'type': 'callback', 'value': {'approval_id': 4, 'decision': choice}}]
        for choice in ('approve', 'reject')
    ]


@pytest.mark.parametrize(('decision', 'verdict'), [('approve', 'approved'), ('reject', 'rejected')])
def test_private_card_decision_reaches_existing_worker_and_updates_card(tmp_path, monkeypatch, decision, verdict):
    from superagent import main

    sessions = sessionmaker(create_engine(f'sqlite:///{tmp_path / "test.db"}'))
    Base.metadata.create_all(sessions.kw['bind'])
    monkeypatch.setattr(main, 'Session', sessions)
    monkeypatch.delenv('SUPERAGENT_API_TOKEN', raising=False)
    monkeypatch.delenv('SUPERAGENT_USERS_JSON', raising=False)
    config = notices.Config('cli_test', 'secret', 'ou_owner', 'admin', '', 'card')
    responses, updates = [], []

    class Worker:
        async def respond_approval(self, request_id, choice):
            responses.append((request_id, choice))
            await asyncio.sleep(0)

    fake_scheduler = type('Scheduler', (), {
        'clients': {1: Worker()}, 'lock': defaultdict(asyncio.Lock).__getitem__,
    })()
    monkeypatch.setattr(main, 'scheduler', fake_scheduler)
    cards = CardApprovals(sessions, fake_scheduler, config, main._decide_worker_approval)
    monkeypatch.setattr(cards, '_update', lambda *args: updates.append(args))

    with sessions.begin() as session:
        session.add(Project(id=1, name='test', repo_path=str(tmp_path), allowed_paths=['.']))
        session.add(Task(id=1, project_id=1, owner_id='admin', status='waiting_approval',
                         title='private', goal='private', workspace_path=str(tmp_path)))
        session.add(Approval(id=1, task_id=1, revision=1, control_version=1, action_hash='test',
                             action={'method': notices.WRITE, 'request_id': 100, 'params': {'grantRoot': str(tmp_path)}}))
        session.add(notices.FeishuDecisionNotice(approval_id=1, status='sent', message_id='om_valid'))

    async def click():
        value = {'approval_id': 1, 'decision': decision}
        for app, person, message in [('cli_wrong', 'ou_owner', 'om_valid'),
                                      ('cli_test', 'ou_wrong', 'om_valid'),
                                      ('cli_test', 'ou_owner', 'om_wrong')]:
            assert (await cards.receive(app, person, message, value))[0] == 'error'
        assert not responses
        assert (await cards.receive('cli_test', 'ou_owner', 'om_valid', value))[0] == 'info'
        assert '正在提交' in (await cards.receive('cli_test', 'ou_owner', 'om_valid', value))[1]
        await cards.pending[1]
        await cards.receive('cli_test', 'ou_owner', 'om_valid', value)
        assert not cards.pending

    asyncio.run(click())
    assert responses == [(100, decision)]
    assert len(updates) == 1 and updates[0][-1] is False
    with sessions() as session:
        assert session.get(Approval, 1).status == verdict
        assert session.get(Task, 1).status == 'running'


def test_outdated_card_cannot_start_approval(tmp_path):
    sessions = sessionmaker(create_engine(f'sqlite:///{tmp_path / "stale.db"}'))
    Base.metadata.create_all(sessions.kw['bind'])
    with sessions.begin() as session:
        session.add(Task(id=1, project_id=1, owner_id='admin', revision=2,
                         status='waiting_approval', title='test', goal='test'))
        session.add(Approval(id=1, task_id=1, revision=1, control_version=1,
                             action_hash='test', action={'method': notices.COMMAND}))
        session.add(notices.FeishuDecisionNotice(approval_id=1, status='sent', message_id='om_valid'))
    cards = CardApprovals(sessions, object(), notices.Config('cli_test', 'secret', 'ou_owner', 'admin', '', 'card'), None)
    result = asyncio.run(cards.receive('cli_test', 'ou_owner', 'om_valid', {'approval_id': 1, 'decision': 'approve'}))
    assert result[0] == 'error' and not cards.pending


def test_pinned_sdk_dispatches_and_acknowledges_card_frame(monkeypatch):
    lark = pytest.importorskip('lark_oapi')
    from lark_oapi.event.callback.model.p2_card_action_trigger import P2CardActionTriggerResponse
    from superagent.connectors.feishu_callback import card_client_class

    ws = importlib.import_module('lark_oapi.ws.client')
    called, written = [], []

    def callback(event):
        called.append(event.event.operator.open_id)
        return P2CardActionTriggerResponse({'toast': {'type': 'info', 'content': 'accepted'}})

    handler = lark.EventDispatcherHandler.builder('', '').register_p2_card_action_trigger(callback).build()
    frame = ws.Frame(method=1, SeqID=1, LogID=2, service=3)
    for key, val in [(ws.HEADER_TYPE, ws.MessageType.CARD.value), (ws.HEADER_SUM, '1'),
                     (ws.HEADER_SEQ, '0'), (ws.HEADER_MESSAGE_ID, 'transport-id')]:
        header = frame.headers.add()
        header.key, header.value = key, val
    frame.payload = json.dumps({'schema': '2.0', 'header': {'event_type': 'card.action.trigger'},
                                'event': {'operator': {'open_id': 'ou_owner'}}}).encode()

    async def write(payload):
        written.append(payload)

    async def dispatch():
        client = card_client_class(ws)('cli_test', 'secret', event_handler=handler)
        monkeypatch.setattr(client, '_write_message', write)
        await client._handle_data_frame(frame)

    asyncio.run(dispatch())
    assert called == ['ou_owner']
    response = ws.Frame()
    response.ParseFromString(written[0])
    assert ws._get_by_key(response.headers, ws.HEADER_TYPE) == ws.MessageType.CARD.value
    ack = json.loads(response.payload)
    assert ack['code'] == 200
    assert json.loads(base64.b64decode(ack['data']))['toast']['content'] == 'accepted'
