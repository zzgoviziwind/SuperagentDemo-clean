"""Budget and watchdog behavior against offline app-server processes."""
import importlib.util
import json
from pathlib import Path
import sys
import types

ROOT = Path(__file__).resolve().parents[2]


def fixture_case():
    spec = importlib.util.spec_from_file_location('offline_acceptance_fixture', ROOT / 'tests/e2e/test_blackbox.py')
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.BlackBoxAcceptance(methodName='test_full_delivery_and_persistence')


def test_zero_budget_blocks_codex():
    case=fixture_case()
    try:
        case.setUp()
        case.request('PATCH', '/api/v1/budgets/global', {'hard_limit_micros':0,'currency':'USD'})
        task=case.create_task()
        detail=case.wait_status(task, {'waiting_resource'})
        assert detail['task']['codex_turn_id'] is None
        assert '预算' in detail['task']['last_error']
    finally:
        case.doCleanups()


def test_idle_turn_requires_reconciliation():
    case=fixture_case()
    original_start=case.start
    def start_idle(self):
        self.environment['SUPERAGENT_CODEX_EXECUTABLE']=json.dumps([sys.executable,str(ROOT / 'tests/core/fake_idle_codex.py')])
        self.environment['SUPERAGENT_RUN_IDLE_TIMEOUT_SECONDS']='1'
        return original_start()
    case.start=types.MethodType(start_idle,case)
    try:
        case.setUp()
        task=case.create_task()
        detail=case.wait_status(task, {'waiting_resource'})
        assert detail['task']['outcome_unknown'] is True
        assert detail['task']['codex_turn_id']=='idle-turn'
        case.request('POST',f"/api/v1/tasks/{task['id']}/controls",{'action':'retry'},expected=409)
    finally:
        case.doCleanups()


def test_approval_with_broader_scope_is_rejected():
    case=fixture_case()
    try:
        case.setUp()
        case.request('PATCH', f"/api/v1/projects/{case.project['id']}", {'allowed_paths':['limited']})
        task=case.create_task()
        detail=case.wait_status(task, {'waiting_input'})
        assert '审批范围' in detail['task']['last_error']
        assert not any(x['status']=='pending' for x in detail['approvals'])
        assert not (case.repo / 'result.txt').exists()
    finally:
        case.doCleanups()


def test_approval_wait_is_not_treated_as_stalled():
    import time
    case=fixture_case()
    original_start=case.start
    def short_watchdog(self):
        self.environment['SUPERAGENT_RUN_IDLE_TIMEOUT_SECONDS']='1'
        return original_start()
    case.start=types.MethodType(short_watchdog,case)
    try:
        case.setUp()
        task=case.create_task()
        case.wait_status(task, {'waiting_approval'})
        time.sleep(2.2)
        detail=case.detail(task)
        assert detail['task']['status']=='waiting_approval'
        assert detail['task']['outcome_unknown'] is False
        case.request('POST',f"/api/v1/tasks/{task['id']}/controls",{'action':'cancel'})
        case.wait_status(task, {'cancelled'})
    finally:
        case.doCleanups()
