import io
import json
import os
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from superagent.api import conversation_providers as api, sessions
from superagent.core import conversation_providers as providers, db, governance as gov
from superagent.runtime import chatgpt_bridge as mcp


@pytest.fixture
def bridge(tmp_path, monkeypatch):
    from superagent import main
    engine = create_engine('sqlite:///' + str(tmp_path / 'bridge.db'),
                           connect_args={'check_same_thread': False})
    db.Base.metadata.create_all(engine)
    factory = sessionmaker(engine, expire_on_commit=False)
    for module in (db, main, sessions):
        monkeypatch.setattr(module, 'Session', factory)
    monkeypatch.delenv('SUPERAGENT_API_TOKEN', raising=False)
    monkeypatch.setenv('SUPERAGENT_USERS_JSON', json.dumps([
        {'user_id': 'alice', 'role': 'member', 'token': 'offline-alice-token'},
        {'user_id': 'bob', 'role': 'member', 'token': 'offline-bob-token'},
        {'user_id': 'view', 'role': 'viewer', 'token': 'offline-view-token'},
        {'user_id': 'root', 'role': 'admin', 'token': 'offline-root-token'},
    ]))
    with factory.begin() as session:
        session.add(db.Project(id=1, name='离线项目', repo_path=str(tmp_path)))
        session.add(db.Task(id=1, title='本地任务', goal='初始目标', project_id=1, owner_id='alice'))
    app = FastAPI()
    app.include_router(api.router)
    with TestClient(app) as client:
        yield client, factory, app
    engine.dispose()


PREFIX = '/api/v1/conversation-providers/bridge/'


def headers(user='alice'):
    return {'Authorization': f'Bearer offline-{user}-token'}


def post(client, payload, user='alice'):
    return client.post(PREFIX + 'operations', json=payload, headers=headers(user))


def message(key='message-1', **changes):
    return dict(request_key=key, action='message', session_id='worker:1',
                content='中文补充', expected_state_version=1, **changes)


def test_capabilities_and_authentication(bridge):
    client, _, _ = bridge
    assert client.get(PREFIX + 'status').status_code == 401
    assert client.get(PREFIX + 'status', headers={'Authorization': 'Bearer invalid'}).status_code == 401
    result = client.get(PREFIX + 'status', headers=headers()).json()
    assert result['principal']['user_id'] == 'alice'
    items = {item['id']: item for item in result['items']}
    assert items['chatgpt_project']['status'] == 'blocked'
    assert items['chatgpt_project']['external_url'] is None
    assert items['chatgpt_mcp_bridge']['automatic_history_sync'] is False


def test_write_replay_version_and_control(bridge):
    client, factory, _ = bridge
    payload = message()
    first = post(client, payload)
    assert first.status_code == 200, first.text
    assert post(client, payload).json()['duplicate'] is True
    changed = {**payload, 'content': '不同内容'}
    assert post(client, changed).status_code == 409
    assert post(client, {**payload, 'request_key': 'stale'}).status_code == 409
    receipt = client.get(PREFIX + 'operations/message-1', headers=headers()).json()
    assert receipt['status'] == 'completed'
    pause = dict(request_key='pause-1', action='control', session_id='worker:1',
                 control='pause', expected_state_version=2)
    assert post(client, pause).json()['result']['status'] == 'paused'
    assert post(client, pause).json()['duplicate'] is True
    with factory() as session:
        assert len(session.scalars(select(db.Event).where(db.Event.event_type == 'message')).all()) == 1
        assert session.get(db.Task, 1).state_version == 3


def test_create_is_durable_and_idempotent(bridge):
    client, _, _ = bridge
    payload = dict(request_key='create-1', action='create', project_id=1, title='新会话', content='分析项目')
    first = post(client, payload)
    assert first.status_code == 200, first.text
    assert first.json()['session_id'] == 'worker:2'
    assert first.json()['result']['kind'] == 'analysis'
    assert post(client, payload).json()['duplicate'] is True
    assert {item['id'] for item in client.get(PREFIX + 'sessions', headers=headers()).json()} == {'worker:1', 'worker:2'}


def test_ownership_and_receipt_isolation(bridge):
    client, _, _ = bridge
    assert post(client, message(), user='bob').status_code == 404
    assert client.get(PREFIX + 'sessions/worker:1', headers=headers('bob')).status_code == 404
    assert post(client, message()).status_code == 200
    assert client.get(PREFIX + 'operations/message-1', headers=headers('bob')).status_code == 404
    assert post(client, message(), user='view').status_code == 404
    assert post(client, dict(request_key='new', action='create', project_id=1,
                             title='x', content='x'), user='view').status_code == 403


def test_unknown_write_never_replayed(bridge, monkeypatch):
    from superagent import main
    client, factory, _ = bridge
    calls = []
    original = main.create_task

    def partial(body, request):
        calls.append(1)
        original(body, request)
        raise HTTPException(503, '模拟写入完成后连接中断')

    monkeypatch.setattr(main, 'create_task', partial)
    payload = dict(request_key='unknown', action='create', project_id=1, title='新会话', content='分析')
    assert post(client, payload).status_code == 503
    assert post(client, payload).status_code == 409
    assert len(calls) == 1
    with factory() as session:
        assert len(session.scalars(select(db.Task)).all()) == 2
    assert client.get(PREFIX + 'operations/unknown', headers=headers()).json()['status'] == 'unknown'


def test_pending_survives_process_restart_and_concurrent_reservations(bridge):
    _, _, _ = bridge
    payload = {'action': 'create'}
    def reserve(_):
        try:
            return providers.reserve_operation('alice', 'concurrent', payload)
        except HTTPException as exc:
            return exc.status_code
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(reserve, range(4)))
    assert sum(isinstance(item, tuple) for item in results) == 1
    assert results.count(409) == 3
    assert providers.operation_receipt('alice', 'concurrent')['status'] == 'pending'
    # No process-local mutex or cache participates in the replay protection.
    with pytest.raises(HTTPException) as exc:
        providers.reserve_operation('alice', 'concurrent', payload)
    assert exc.value.status_code == 409


def test_cursor_snapshot_and_validation(bridge):
    client, _, _ = bridge
    first = client.get(PREFIX + 'sessions/worker:1?limit=1', headers=headers()).json()
    assert first['next_after'] == 1
    assert post(client, message()).status_code == 200
    second = client.get(PREFIX + 'sessions/worker:1?limit=1&after=1', headers=headers()).json()
    assert second['snapshot'] != first['snapshot']
    assert second['messages'][0]['content'] == '中文补充'
    assert client.get(PREFIX + 'sessions/worker:1?after=-1', headers=headers()).status_code == 422
    assert post(client, {**message(), 'expected_state_version': None}).status_code == 422
    assert post(client, {**message(), 'private_token': 'unused'}).status_code == 422


def test_auth_conflicts_are_closed(bridge, monkeypatch):
    client, _, _ = bridge
    monkeypatch.setenv('SUPERAGENT_API_TOKEN', 'offline-alice-token')
    assert client.get(PREFIX + 'status', headers=headers()).status_code == 503


def test_receipt_visibility_after_owner_changes(bridge):
    client, factory, _ = bridge
    assert post(client, message()).status_code == 200
    with factory.begin() as session:
        session.get(db.Task, 1).owner_id = 'bob'
    assert client.get(PREFIX + 'operations/message-1', headers=headers()).status_code == 404
    assert post(client, message()).status_code == 404


def test_streamable_http_handshake_tools_and_authentication(bridge):
    client, _, _ = bridge
    endpoint = '/api/v1/conversation-providers/mcp'
    def rpc(method, params=None, ident=1):
        return {'jsonrpc': '2.0', 'id': ident, 'method': method, 'params': params or {}}
    assert client.post(endpoint, json=rpc('initialize')).status_code == 401
    init = client.post(endpoint, json=rpc('initialize', {'protocolVersion': '2025-03-26'}), headers=headers())
    assert init.json()['result']['protocolVersion'] == '2025-03-26'
    assert 'mcp-session-id' not in init.headers
    initialized = client.post(endpoint, json={'jsonrpc': '2.0', 'method': 'notifications/initialized'}, headers=headers())
    assert initialized.status_code == 202
    listed = client.post(endpoint, json=rpc('tools/list'), headers=headers()).json()
    assert len(listed['result']['tools']) == 5
    call = rpc('tools/call', {'name': 'superagent_operation', 'arguments': message()})
    assert client.post(endpoint, json=call, headers=headers()).json()['result']['isError'] is False
    replay = client.post(endpoint, json=call, headers=headers()).json()
    assert json.loads(replay['result']['content'][0]['text'])['duplicate'] is True
    unauthorized = rpc('tools/call', {'name': 'superagent_read', 'arguments': {'session_id': 'worker:1'}})
    assert client.post(endpoint, json=unauthorized, headers=headers('bob')).json()['result']['isError'] is True
    assert client.post(endpoint, content='invalid-json', headers=headers()).json()['error']['code'] == -32700
    assert client.post(endpoint, json=rpc('unknown'), headers=headers()).json()['error']['code'] == -32601
    assert client.post(endpoint, json=rpc('ping'), headers={**headers(), 'MCP-Protocol-Version': 'unknown'}).status_code == 400
    assert client.get(endpoint, headers=headers()).status_code == 405
    assert client.delete(endpoint, headers=headers()).status_code == 405
    assert client.post(endpoint, json=rpc('ping'), headers={**headers(), 'Origin': 'https://other.example'}).status_code == 403


def test_stdio_protocol_and_errors():
    class Client:
        def call(self, name, args):
            if name == 'failure':
                raise ValueError('sensitive-value')
            return {'content': '中文', 'args': args}
    source = io.StringIO('\n'.join(json.dumps(item) for item in [
        {'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {'protocolVersion': '2025-03-26'}},
        {'jsonrpc': '2.0', 'method': 'notifications/initialized'},
        {'jsonrpc': '2.0', 'id': 2, 'method': 'tools/list'},
        {'jsonrpc': '2.0', 'id': 3, 'method': 'tools/call', 'params': {'name': 'failure'}},
    ]) + '\n')
    sink = io.StringIO()
    mcp.serve(Client(), source, sink)
    responses = [json.loads(line) for line in sink.getvalue().splitlines()]
    assert len(responses) == 3
    assert responses[0]['result']['protocolVersion'] == '2025-03-26'
    assert len(responses[1]['result']['tools']) == 5
    assert responses[2]['result']['isError'] is True
    assert 'sensitive-value' not in sink.getvalue()


@pytest.mark.parametrize('url', ['http://example.com', 'https://user:password@example.com',
                                 'http://127.0.0.1/api', 'https://example.com?key=1'])
def test_bridge_rejects_unsafe_origins(url):
    with pytest.raises(ValueError):
        mcp.BridgeClient(url, 'offline-token')


def test_real_stdio_process_to_http_bridge(bridge):
    """Real local sockets, independent Python process, actual durable backend."""
    import socket
    import threading
    import time
    import uvicorn
    client, _, app = bridge
    listener = socket.socket()
    listener.bind(('127.0.0.1', 0))
    port = listener.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(app, log_level='error'))
    thread = threading.Thread(target=server.run, kwargs={'sockets': [listener]}, daemon=True)
    thread.start()
    try:
        deadline = time.monotonic() + 10
        while not server.started and time.monotonic() < deadline:
            time.sleep(0.02)
        assert server.started
        from urllib.request import Request, urlopen
        from urllib.error import HTTPError
        endpoint = f'http://127.0.0.1:{port}/api/v1/conversation-providers/mcp'
        def http_rpc(method, params=None):
            payload = {'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': params or {}}
            request = Request(endpoint, data=json.dumps(payload).encode(),
                              headers={**headers(), 'Content-Type': 'application/json',
                                       'Accept': 'application/json, text/event-stream'})
            with urlopen(request, timeout=5) as response:
                return json.load(response)
        assert http_rpc('initialize', {'protocolVersion': '2025-06-18'})['result']['serverInfo']['name'] == 'superagent-local-bridge'
        assert len(http_rpc('tools/list')['result']['tools']) == 5
        assert http_rpc('tools/call', {'name': 'superagent_status'})['result']['isError'] is False
        assert http_rpc('tools/call', {'name': 'unrecognized'})['result']['isError'] is True
        with pytest.raises(HTTPError) as denied:
            urlopen(Request(endpoint, data=b'{}', headers={'Content-Type': 'application/json'}), timeout=5)
        assert denied.value.code == 401
        requests = [
            {'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {'protocolVersion': '2025-06-18'}},
            {'jsonrpc': '2.0', 'method': 'notifications/initialized'},
            {'jsonrpc': '2.0', 'id': 2, 'method': 'tools/call', 'params': {
                'name': 'superagent_operation', 'arguments': message()}},
            {'jsonrpc': '2.0', 'id': 3, 'method': 'tools/call', 'params': {
                'name': 'superagent_read', 'arguments': {'session_id': 'worker:1'}}},
            {'jsonrpc': '2.0', 'id': 4, 'method': 'tools/call', 'params': {
                'name': 'superagent_operation', 'arguments': message()}},
        ]
        env = {**os.environ, 'SUPERAGENT_BRIDGE_URL': f'http://127.0.0.1:{port}',
               'SUPERAGENT_BRIDGE_TOKEN': 'offline-alice-token'}
        result = subprocess.run([sys.executable, '-m', 'superagent.runtime.chatgpt_bridge'],
            input='\n'.join(json.dumps(item, ensure_ascii=False) for item in requests) + '\n',
            capture_output=True, encoding='utf-8', env=env, timeout=30)
        assert result.returncode == 0, result.stderr
        responses = [json.loads(line) for line in result.stdout.splitlines()]
        assert len(responses) == 4
        assert all(not response['result'].get('isError') for response in responses)
        history = json.loads(responses[2]['result']['content'][0]['text'])
        assert any(item['content'] == '中文补充' for item in history['messages'])
        assert json.loads(responses[3]['result']['content'][0]['text'])['duplicate'] is True
        assert client.get(PREFIX + 'operations/message-1', headers=headers()).json()['status'] == 'completed'
    finally:
        server.should_exit = True
        thread.join(timeout=10)
        listener.close()
        assert not thread.is_alive()
