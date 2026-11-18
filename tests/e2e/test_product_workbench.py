import json

from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

import superagent.main as main
from superagent.core import db, ingestion, scheduler, router_agent
from superagent.api import sessions, lifecycle


def test_http_event_session_and_role_boundaries(tmp_path, monkeypatch):
    engine = create_engine('sqlite:///' + (tmp_path / 'product.db').as_posix(),
                           connect_args={'check_same_thread': False})
    factory = sessionmaker(engine, expire_on_commit=False)
    monkeypatch.setattr(db, 'engine', engine)
    for module in (db, main, ingestion, scheduler, router_agent, sessions, lifecycle):
        monkeypatch.setattr(module, 'Session', factory)
    monkeypatch.setattr(main.manager, 'sessions', factory)
    monkeypatch.setattr(main.manager.store, 'sessions', factory)
    monkeypatch.setenv('SUPERAGENT_USERS_JSON', json.dumps([
        {'user_id': 'owner', 'role': 'admin', 'token': 'preview-admin-token'},
        {'user_id': 'observer', 'role': 'viewer', 'token': 'preview-viewer-token'}]))
    monkeypatch.delenv('SUPERAGENT_API_TOKEN', raising=False)
    monkeypatch.setattr(ingestion, 'trusted_actor', lambda *_: {
        'user_id': 'owner', 'role': 'admin', 'project_ids': [1], 'permissions': ['request']})
    with TestClient(main.app, headers={'Authorization': 'Bearer preview-admin-token'}) as client:
        project = client.post('/api/v1/projects', json={
            'name': '隔离 HTTP 验收', 'repo_path': str(tmp_path), 'dingtalk_chat_ids': ['preview']})
        assert project.status_code == 200
        payload = {'source': 'dingtalk', 'external_id': 'http-1', 'event_type': 'message.received',
                   'actor_id': 'tester', 'project_external_id': 'preview', 'content': '请只读分析 #42',
                   'metadata': {}}
        received = client.post('/api/v1/events', json=payload)
        assert received.status_code == 200
        event = received.json()
        task_id = event['task_id']
        trace = client.get(f"/api/v1/events/{event['id']}/trace").json()
        assert trace['attempts'][0]['steps'][0]['stage'] == 'trigger'
        assert trace['task']['id'] == task_id
        assert client.get('/api/v1/architecture').json()['counts']['events'] == 1
        assert client.get('/api/v1/subscriptions').json()['items'][0]['task_id'] == task_id
        detail = client.get(f'/api/v1/sessions/worker:{task_id}').json()
        assert detail['messages'][0]['content'] == payload['content']
        version = detail['session']['state_version']
        body = {'content': '只查看事件来源', 'expected_state_version': version}
        assert client.post(f'/api/v1/sessions/worker:{task_id}/messages', json=body).status_code == 200
        assert client.post(f'/api/v1/sessions/worker:{task_id}/messages', json=body).status_code == 409
        assert client.post('/api/v1/sessions/router:1/messages', json={'content': '保留项目备注'}).status_code == 200
        assert client.get('/api/v1/sessions/router:1').json()['messages'][0]['content'] == '保留项目备注'
        viewer = {'Authorization': 'Bearer preview-viewer-token'}
        assert client.get('/api/v1/architecture', headers=viewer).status_code == 403
        assert client.get(f'/api/v1/events/{event["id"]}/trace', headers=viewer).status_code == 403
        assert client.get('/api/v1/sessions', headers=viewer).json() == []
        assert client.post('/api/v1/sessions/router:1/messages', json={'content': '越权'}, headers=viewer).status_code == 404
        assert client.get('/api/v1/sessions', headers={'Authorization': 'Bearer invalid'}).status_code == 401
    engine.dispose()
