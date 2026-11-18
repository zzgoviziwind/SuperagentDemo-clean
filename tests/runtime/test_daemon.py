import asyncio
import importlib.util
import json
import os
import socket
import subprocess
import sys
import time
import types
import uuid
from pathlib import Path
from urllib.request import urlopen

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from superagent.core import db
from superagent.runtime.daemon import Daemon
from superagent.runtime.remote import RemoteCodexAppServer


def test_daemon_rejects_network_http_and_path_escape(tmp_path):
    with pytest.raises(ValueError):
        Daemon('http://192.0.2.1', 'node', 'test', [tmp_path], 'fixed')
    daemon = Daemon('http://127.0.0.1', 'node', 'test', [tmp_path], 'fixed')
    assert daemon.path(str(tmp_path)) == str(tmp_path.resolve())
    with pytest.raises(ValueError):
        daemon.path(str(tmp_path.parent))
    with pytest.raises(ValueError):
        daemon.path('relative')


def test_daemon_rejects_arbitrary_method_and_replay(tmp_path):
    daemon = Daemon('http://127.0.0.1', 'node', 'test', [tmp_path], 'fixed')
    operation = {'id': 'one', 'session_id': 'session', 'method': 'shell', 'payload': {}, 'deadline': time.time() + 10}
    with pytest.raises(ValueError, match='不支持'):
        asyncio.run(daemon.dispatch(operation))
    with pytest.raises(ValueError, match='已执行'):
        asyncio.run(daemon.dispatch(operation))


def test_two_process_loopback_codex_protocol(tmp_path, monkeypatch):
    """Real controller + outbound daemon processes, fake Codex child, no live service."""
    root = Path(__file__).resolve().parents[2]
    fake = tmp_path / 'fake_engine.py'
    fake.write_text('''import json, sys
def emit(value):
    print(json.dumps(value), flush=True)
for line in sys.stdin:
    message = json.loads(line)
    method = message.get('method')
    if method == 'initialized':
        continue
    if method is None:
        if message.get('id') == 99:
            emit({'method': 'turn/completed', 'params': {'threadId': 'thread', 'turn': {'id': 'turn', 'status': 'completed'}}})
        continue
    result = {}
    if method in ('thread/start', 'thread/resume'):
        result = {'thread': {'id': 'thread'}}
    if method == 'turn/start':
        result = {'turn': {'id': 'turn'}}
        emit({'id': 99, 'method': 'item/commandExecution/requestApproval', 'params': {'threadId': 'thread', 'turnId': 'turn'}})
    emit({'id': message['id'], 'result': result})
''', encoding='utf-8')
    database = 'sqlite:///' + str(tmp_path / 'loopback.db')
    engine = create_engine(database, connect_args={'check_same_thread': False})
    db.Base.metadata.create_all(engine)
    monkeypatch.setattr(db, 'Session', sessionmaker(engine, expire_on_commit=False))
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    env = os.environ.copy()
    env.update({'SUPERAGENT_DATABASE_URL': database,
                'SUPERAGENT_EXECUTION_NODES': json.dumps([{'id': 'loopback', 'token_env': 'SUPERAGENT_NODE_TOKEN', 'roots': [str(tmp_path)], 'project_ids': [1]}]),
                'SUPERAGENT_NODE_ID': 'loopback', 'SUPERAGENT_NODE_TOKEN': uuid.uuid4().hex,
                'SUPERAGENT_CONTROL_URL': f'http://127.0.0.1:{port}',
                'SUPERAGENT_DAEMON_ROOTS': json.dumps([str(tmp_path)]),
                'SUPERAGENT_CODEX_HOME': str(tmp_path / 'codex-home'),
                'SUPERAGENT_CODEX_EXECUTABLE': json.dumps([sys.executable, str(fake)])})
    code = "from fastapi import FastAPI; from superagent.api.operations import router; from superagent.core import db, execution_nodes; db.init_db(); execution_nodes.initialize(); app=FastAPI(); app.include_router(router); import uvicorn; uvicorn.run(app, host='127.0.0.1', port=" + str(port) + ", log_level='error')"
    controller = subprocess.Popen([sys.executable, '-c', code], cwd=root, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    daemon = None
    try:
        for _ in range(100):
            if controller.poll() is not None:
                pytest.fail('loopback controller exited')
            try:
                urlopen(env['SUPERAGENT_CONTROL_URL'] + '/openapi.json', timeout=.2).close()
                break
            except OSError:
                time.sleep(.1)
        else:
            pytest.fail('loopback controller did not start')
        daemon = subprocess.Popen([sys.executable, '-m', 'superagent.runtime.daemon'], cwd=root, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        async def roundtrip():
            client = RemoteCodexAppServer('loopback', str(tmp_path), project_id=1, timeout=12)
            try:
                await client.start()
                assert (await client.start_thread(str(tmp_path)))['id'] == 'thread'
                assert (await client.start_turn('thread', 'loopback test'))['id'] == 'turn'
                iterator = client.events().__aiter__()
                approval = await asyncio.wait_for(anext(iterator), 5)
                assert approval['id'] == 99
                await client.respond_approval(99, 'reject')
                await client.interrupt_turn('thread', 'turn')
                completed = await asyncio.wait_for(anext(iterator), 5)
                assert completed['method'] == 'turn/completed'
                await iterator.aclose()
            finally:
                await client.close()
        asyncio.run(roundtrip())
        assert controller.poll() is None and daemon.poll() is None
    finally:
        for process in (daemon, controller):
            if process is not None:
                process.terminate()
                process.wait(timeout=15)
        engine.dispose()


def test_scheduler_executes_analysis_on_selected_loopback_node():
    root = Path(__file__).resolve().parents[2]
    spec = importlib.util.spec_from_file_location('operations_blackbox_fixture', root / 'tests/e2e/test_blackbox.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    case = module.BlackBoxAcceptance(methodName='test_full_delivery_and_persistence')
    original_start = case.start
    def start(self):
        self.environment.update({
            'SUPERAGENT_EXECUTION_NODES': json.dumps([{'id': 'selected-daemon', 'token_env': 'ISOLATED_NODE_SECRET', 'roots': [str(self.root)], 'project_ids': [1]}]),
            'ISOLATED_NODE_SECRET': uuid.uuid4().hex,
            'SUPERAGENT_CODEX_HOME': str(self.root / 'codex-home'),
            'SUPERAGENT_CODEX_EXECUTABLE': json.dumps([sys.executable, str(root / 'tests/core/fake_analysis_codex.py')])})
        return original_start()
    case.start = types.MethodType(start, case)
    daemon = None
    try:
        case.setUp()
        env = case.environment | {'SUPERAGENT_CONTROL_URL': case.base, 'SUPERAGENT_NODE_ID': 'selected-daemon',
                                  'SUPERAGENT_NODE_TOKEN': case.environment['ISOLATED_NODE_SECRET'],
                                  'SUPERAGENT_DAEMON_ROOTS': json.dumps([str(case.root)])}
        daemon = subprocess.Popen([sys.executable, '-m', 'superagent.runtime.daemon'], cwd=root, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(100):
            if case.request('GET', '/api/v1/operations/nodes')['items'][0]['online']:
                break
            time.sleep(.1)
        else:
            pytest.fail('selected daemon did not register')
        case.request('PATCH', f"/api/v1/operations/projects/{case.project['id']}/execution-node", {'node_id': 'selected-daemon'})
        task = case.request('POST', '/api/v1/tasks', {'title': '节点分析', 'goal': '分析仓库', 'kind': 'analysis', 'project_id': case.project['id']})
        detail = case.wait_status(task, {'review_ready'})
        assert any(event['event_type'] == 'execution_node_selected' and event['data']['node_id'] == 'selected-daemon' for event in detail['events'])
        verification = json.loads(next(item for item in detail['artifacts'] if item['kind'] == 'verification')['content'])
        assert verification['analysis_read_evidence']['evidence_calls'] == 1
        assert not detail['task']['outcome_unknown']
    finally:
        if daemon is not None:
            daemon.terminate()
            daemon.wait(timeout=15)
        case.doCleanups()
