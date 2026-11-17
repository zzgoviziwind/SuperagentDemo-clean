import asyncio
import json
from collections import defaultdict

from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from superagent.core import feishu_decisions as feishu
from superagent.core.db import Approval, Base, Project, Task


def test_only_current_live_owner_approval_is_sent_once(tmp_path):
    sessions = sessionmaker(create_engine(f'sqlite:///{tmp_path / "notices.db"}'))
    Base.metadata.create_all(sessions.kw['bind'])
    config = feishu.Config('cli_test', 'secret', 'ou_test', 'owner', 'https://workbench.example')

    class Scheduler:
        clients = {i: object() for i in range(1, 7)}
        lock = defaultdict(asyncio.Lock).__getitem__

    with sessions.begin() as session:
        session.add(Project(id=1, name='example', repo_path='unused'))
        for i in range(1, 8):
            session.add(Task(id=i, title='private title', goal='private goal', project_id=1,
                             status='running' if i == 2 else 'waiting_approval',
                             owner_id='other' if i == 3 else 'owner', outcome_unknown=i == 6))
            session.add(Approval(id=i, task_id=i, revision=2 if i == 4 else 1, control_version=1,
                                 action_hash='test', action={'method': 'reply' if i == 5 else feishu.WRITE}))
    sent = []

    def send(*args):
        sent.append(args[2:])
        return {'code': 0, 'data': {'message_id': 'om_test'}}

    async def run_twice():
        for _ in range(2):
            await feishu.notify_pending(sessions, Scheduler(), config, get_token=lambda _: 'test', send=send)

    asyncio.run(run_twice())
    assert sent == [(1, 1, feishu.WRITE)]
    with sessions() as session:
        notices = session.scalars(select(feishu.FeishuDecisionNotice)).all()
        assert [(n.approval_id, n.status, n.message_id) for n in notices] == [(1, 'sent', 'om_test')]


def test_message_is_direct_and_contains_only_ids_and_review_link(monkeypatch):
    config = feishu.Config('cli_test', 'secret', 'ou_test', 'owner', 'https://workbench.example')
    requests = []

    def post(url, payload, token=None):
        requests.append((url, payload, token))
        return {'access_token': 't-test'}

    monkeypatch.setattr(feishu, '_post', post)
    feishu._send(config, feishu._token(config), 123, 456, feishu.COMMAND)
    url, message, token = requests[1]
    assert url.endswith('?receive_id_type=open_id')
    assert token == 't-test'
    assert message['receive_id'] == 'ou_test'
    content = json.loads(message['content'])['zh_cn']
    assert content['content'][1][0]['href'] == 'https://workbench.example/?task=123&approval=456'
    assert 'secret' not in message['content']


def test_preview_cannot_enable_real_feishu(monkeypatch):
    monkeypatch.setenv('SUPERAGENT_FEISHU_ENABLED', '1')
    monkeypatch.setenv('SUPERAGENT_SERVICE_MODE', 'preview')
    monkeypatch.setattr(feishu.log, 'error', lambda *_: (_ for _ in ()).throw(AssertionError()))
    assert feishu.Config.load() is None
