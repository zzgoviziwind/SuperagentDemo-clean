"""Exercise new capabilities through the assembled application and its auth boundary."""
import json
import time
import uuid

from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

import superagent.main as main
from superagent.api import lifecycle, routing, sessions
from superagent.core import db, ingestion, scheduler, router_agent, execution_nodes, connections


def test_subscription_routing_bridge_and_operations_share_canonical_state(tmp_path, monkeypatch):
    engine = create_engine('sqlite:///' + (tmp_path / 'acceptance.db').as_posix(),
                           connect_args={'check_same_thread': False})
    factory = sessionmaker(engine, expire_on_commit=False)
    monkeypatch.setattr(db, 'engine', engine)
    for module in (db, main, ingestion, scheduler, router_agent, sessions, lifecycle, routing, connections):
        monkeypatch.setattr(module, 'Session', factory)
    monkeypatch.setattr(main.manager, 'sessions', factory)
    monkeypatch.setattr(main.manager.store, 'sessions', factory)
    monkeypatch.setattr(main.semantic_routing_service, 'sessions', factory)
    # Keep semantic jobs queued for explicit HTTP human-correction acceptance.
    async def no_background():
        pass
    monkeypatch.setattr(main.semantic_routing_service, 'start', no_background)
    monkeypatch.setattr(main.semantic_routing_service, 'background', None)
    actor = lambda *_: {'user_id': 'owner', 'role': 'admin',
                         'project_ids': [1], 'permissions': ['request']}
    monkeypatch.setattr(ingestion, 'trusted_actor', actor)
    monkeypatch.setattr(main.semantic_routing_service, 'resolver', actor)
    monkeypatch.delenv('SUPERAGENT_API_TOKEN', raising=False)
    monkeypatch.setenv('SUPERAGENT_USERS_JSON', json.dumps([
        {'user_id': 'owner', 'role': 'admin', 'token': 'acceptance-admin'},
        {'user_id': 'viewer', 'role': 'viewer', 'token': 'acceptance-viewer'}]))
    monkeypatch.setenv('SUPERAGENT_EXECUTION_NODES', json.dumps([
        {'id': 'acceptance-node', 'token_env': 'ACCEPTANCE_NODE_TOKEN',
         'project_ids': [1], 'roots': [str(tmp_path)]}]))
    monkeypatch.setenv('ACCEPTANCE_NODE_TOKEN', 'isolated-test-secret')

    class Reviewer:
        async def review(self, run_id, evidence, save_session):
            save_session('test-watchdog-thread', 'test-watchdog-turn')
            return {'action': 'observe', 'reason': '人工暂停状态，无需自动恢复'}
    monkeypatch.setattr(main.operations.watchdog, 'model', Reviewer())

    with TestClient(main.app, headers={'Authorization': 'Bearer acceptance-admin'}) as client:
        def ok(response):
            assert response.status_code == 200, response.text
            return response.json()

        ok(client.post('/api/v1/projects', json={'name': '集成验收项目',
            'repo_path': str(tmp_path), 'dingtalk_chat_ids': ['acceptance-chat']}))
        tasks = [ok(client.post('/api/v1/tasks', json={'project_id': 1, 'kind': 'analysis',
            'title': title, 'goal': title})) for title in ('分析来源', '分析订阅')]
        for task in tasks:
            ok(client.post('/api/v1/subscriptions', json={'project_id': 1,
                'task_id': task['id'], 'source': 'dingtalk', 'thread_id': 'acceptance-chat'}))
        payload = {'source': 'dingtalk', 'external_id': 'fanout-acceptance',
            'event_type': 'message.received', 'actor_id': 'tester',
            'project_external_id': 'acceptance-chat', 'thread_id': 'acceptance-chat',
            'content': '补充：请注意消息来源与授权关系', 'metadata': {}}
        received = ok(client.post('/api/v1/events', json=payload))
        assert received['task_id'] is None
        trace = ok(client.get(f"/api/v1/events/{received['id']}/trace"))
        assert sorted(t['id'] for t in trace['target_tasks']) == [1, 2]
        assert len(trace['targets']) == 2
        assert ok(client.post('/api/v1/events', json=payload))['duplicate'] is True
        for task in tasks:
            messages = ok(client.get(f"/api/v1/sessions/worker:{task['id']}"))['messages']
            assert sum(m['content'] == payload['content'] for m in messages) == 1

        # A separate thread queues semantic work; correction applies exactly once.
        ok(client.patch('/api/v1/settings', json={'semantic_routing_enabled': True}))
        semantic_event = ok(client.post('/api/v1/events', json={**payload,
            'external_id': 'semantic-acceptance', 'thread_id': 'separate-thread',
            'content': '请只读分析产品说明'}))
        jobs = ok(client.get('/api/v1/routing/jobs'))['items']
        assert jobs[0]['event_id'] == semantic_event['id']
        correction = {'evidence': '人工核对原消息是独立只读分析', 'decision': {
            'action': 'create', 'kind': 'analysis', 'task_id': None,
            'state_version': None, 'reason': '独立分析任务'}}
        corrected = ok(client.post(f"/api/v1/routing/jobs/{semantic_event['id']}/correction", json=correction))
        assert corrected['newly_applied'] is True
        assert ok(client.post(f"/api/v1/routing/jobs/{semantic_event['id']}/correction", json=correction))['newly_applied'] is False

        # MCP/HTTP bridge and native workbench operate on the same Worker history.
        prefix = '/api/v1/conversation-providers/bridge/'
        detail = ok(client.get(prefix + 'sessions/worker:1'))
        message = {'request_key': 'correction-via-bridge', 'action': 'message',
            'session_id': 'worker:1', 'expected_state_version': detail['session']['state_version'],
            'content': '人工纠正：仅核对来源'}
        assert ok(client.post(prefix + 'operations', json=message))['duplicate'] is False
        assert ok(client.post(prefix + 'operations', json=message))['duplicate'] is True
        assert any(m['content'] == message['content'] for m in ok(client.get('/api/v1/sessions/worker:1'))['messages'])

        ok(client.patch('/api/v1/operations/projects/1/execution-node', json={'node_id': 'acceptance-node'}))
        path = '/api/v1/operations/daemon/poll'
        raw = json.dumps({'boot_id': uuid.uuid4().hex}).encode()
        stamp, nonce = str(time.time()), uuid.uuid4().hex
        headers = {'X-Node-Id': 'acceptance-node', 'X-Node-Time': stamp, 'X-Node-Nonce': nonce,
            'X-Node-Signature': execution_nodes.signature('isolated-test-secret', stamp, nonce, path, raw),
            'Content-Type': 'application/json', 'Authorization': ''}
        ok(client.post(path, content=raw, headers=headers))
        assert client.post(path, content=raw, headers=headers).status_code == 401
        assert ok(client.get('/api/v1/operations/nodes'))['items'][0]['online'] is True
        run_id = ok(client.post('/api/v1/operations/watchdog/tasks/1/run'))['run_id']
        runs = ok(client.get('/api/v1/operations/watchdog?task_id=1'))['items']
        assert runs[0]['status'] == 'completed'
        assert runs[0]['thread_id'] == 'test-watchdog-thread'
        ok(client.post(f'/api/v1/operations/watchdog/{run_id}/messages',
                       json={'content': '下次重点检查订阅目标'}))
        viewer = {'Authorization': 'Bearer acceptance-viewer'}
        for path in ('/api/v1/routing/jobs', '/api/v1/operations/nodes', '/api/v1/operations/watchdog'):
            assert client.get(path, headers=viewer).status_code == 403
        assert client.post('/api/v1/conversation-providers/mcp', json={
            'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {}},
            headers={'Authorization': ''}).status_code == 401
    engine.dispose()
