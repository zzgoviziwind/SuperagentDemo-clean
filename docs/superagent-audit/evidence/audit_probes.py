"""Offline architecture probes. Run with pytest from the isolated source copy."""

import importlib.util
import json
import os
from pathlib import Path
import sys
import time

import pytest


FAKE = r"""
import json, sys, threading, time
from pathlib import Path
sink = Path(sys.argv[1])
mode = sys.argv[2]
sys.stdin.reconfigure(encoding='utf-8')
sys.stdout.reconfigure(encoding='utf-8')
def emit(row):
    print(json.dumps(row), flush=True)
def ticks():
    while True:
        time.sleep(.10)
        emit({'method':'item/agentMessage/delta','params':{
            'threadId':'probe-thread','turnId':'probe-turn','itemId':'same','delta':'same'}})
for line in sys.stdin:
    q = json.loads(line)
    method, params = q.get('method'), q.get('params', {})
    if method in ('turn/start','turn/steer','turn/interrupt'):
        with sink.open('a', encoding='utf-8') as f:
            f.write(json.dumps({'method':method,'params':params})+'\n')
    if 'id' not in q:
        continue
    result = ({'thread':{'id':'probe-thread'}} if method in ('thread/start','thread/resume')
              else {'turn':{'id':'probe-turn'}} if method == 'turn/start' else {})
    emit({'id':q['id'],'result':result})
    if method == 'turn/start' and mode == 'noise':
        threading.Thread(target=ticks, daemon=True).start()
    if method == 'turn/interrupt':
        emit({'method':'turn/completed','params':{'threadId':'probe-thread',
              'turn':{'id':'probe-turn','status':'interrupted'}}})
"""


@pytest.fixture
def service(request):
    root = Path.cwd()
    assert (root / 'tests/e2e/test_blackbox.py').is_file()
    assert 'audit' in root.name.lower()
    assert os.environ.get('SUPERAGENT_DATABASE_URL', '').startswith('sqlite:///')
    spec = importlib.util.spec_from_file_location('audit_blackbox', root / 'tests/e2e/test_blackbox.py')
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    case = mod.BlackBoxAcceptance(methodName='test_full_delivery_and_persistence')
    start = case.start
    mode = getattr(request, 'param', 'idle')

    def start_probe():
        case.sink = case.root / 'runtime-requests.jsonl'
        fake = case.root / 'audit_fake_codex.py'
        fake.write_text(FAKE, encoding='utf-8')
        case.environment.update({
            'SUPERAGENT_CODEX_EXECUTABLE': json.dumps([sys.executable, str(fake), str(case.sink), mode]),
            'SUPERAGENT_RUN_IDLE_TIMEOUT_SECONDS': '1' if mode == 'noise' else '20',
        })
        start()

    case.start = start_probe
    try:
        case.setUp()
        yield case
    finally:
        case.doCleanups()


def wait_turn(case, task):
    for _ in range(120):
        detail = case.detail(task)['task']
        if detail['status'] == 'running' and detail['codex_turn_id'] == 'probe-turn':
            return detail
        time.sleep(.1)
    pytest.fail('No active probe turn appeared')


def records(case, method):
    return [row['params'] for row in map(json.loads, case.sink.read_text('utf-8').splitlines())
            if row['method'] == method]


def test_active_crash_preserves_unknown_without_replay(service):
    task = service.create_task()
    before = wait_turn(service, task)
    assert len(records(service, 'turn/start')) == 1
    service.stop()  # fixture kills only its own PID tree on Windows
    service.start()
    after = service.detail(task)['task']
    assert after['status'] == 'waiting_resource' and after['outcome_unknown']
    assert after['codex_turn_id'] == before['codex_turn_id']
    service.request('POST', f"/api/v1/tasks/{task['id']}/controls", {'action':'retry'}, expected=409)
    time.sleep(.8)
    assert len(records(service, 'turn/start')) == 1
    print('active turn -> waiting_resource / unknown; retry=409; turn/start count=1')


def test_active_message_steers_matching_turn_then_cancel(service):
    task = service.create_task()
    before = wait_turn(service, task)
    result = service.request('POST', f"/api/v1/tasks/{task['id']}/messages", {
        'content':'AUDIT_STEER_MARKER', 'expected_state_version':before['state_version']})
    [steer] = records(service, 'turn/steer')
    assert steer['threadId'] == before['codex_thread_id']
    assert steer['expectedTurnId'] == before['codex_turn_id']
    assert steer['input'][0]['text'] == 'AUDIT_STEER_MARKER'
    assert any(e['id'] == result['id'] for e in service.detail(task)['events'])
    service.request('POST', f"/api/v1/tasks/{task['id']}/controls", {'action':'cancel'})
    service.wait_status(task, {'cancelled'})
    assert records(service, 'turn/interrupt')[-1]['turnId'] == before['codex_turn_id']
    print('persisted message steered exact thread and turn; interrupt confirmed; cancelled')


def test_old_message_is_persisted_but_not_recalled_at_worker_start(service):
    service.request('PATCH', '/api/v1/settings', {'scheduler_enabled':False})
    task = service.create_task()
    for i in range(31):
        text = ('AUDIT_OLDEST_DECISION ' if i == 0 else f'AUDIT_{i:02d} ') + '文' * 4200 + 'AUDIT_TAIL'
        service.request('POST', f"/api/v1/tasks/{task['id']}/messages", {'content':text})
    service.request('PATCH', '/api/v1/settings', {'scheduler_enabled':True})
    wait_turn(service, task)
    [start] = records(service, 'turn/start')
    prompt = start['input'][0]['text']
    events = service.detail(task)['events']
    assert any(e['content'].startswith('AUDIT_OLDEST_DECISION') for e in events)
    assert 'AUDIT_OLDEST_DECISION' not in prompt
    assert 'AUDIT_30 ' in prompt and 'AUDIT_TAIL' not in prompt
    print(f'31 x >4200 chars; prompt_chars={len(prompt)}; oldest decision persisted but absent; recent tail truncated')


@pytest.mark.parametrize('service', ['noise'], indirect=True)
def test_repeated_deltas_evade_idle_timeout_without_progress(service):
    task = service.create_task()
    wait_turn(service, task)
    time.sleep(3.25)  # >3x configured idle timeout; no meaningful progress
    detail = service.detail(task)
    assert detail['task']['status'] == 'running' and not detail['task']['outcome_unknown']
    assert len(records(service, 'turn/start')) == 1
    service.request('POST', f"/api/v1/tasks/{task['id']}/controls", {'action':'cancel'})
    service.wait_status(task, {'cancelled'})
    print('idle limit=1s; >3.25s of identical deltas kept task running (gap reproduced); manually cancelled')
