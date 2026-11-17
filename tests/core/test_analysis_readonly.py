"""Read-only analysis behavior through the real HTTP scheduler and offline peer."""
import importlib.util
import json
from pathlib import Path
import sys
import types
import pytest

ROOT=Path(__file__).resolve().parents[2]


def build_case():
    spec=importlib.util.spec_from_file_location('analysis_fixture',ROOT/'tests/e2e/test_blackbox.py')
    mod=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    case=mod.BlackBoxAcceptance(methodName='test_full_delivery_and_persistence')
    original=case.start
    def start_peer(self):
        self.environment['SUPERAGENT_CODEX_EXECUTABLE']=json.dumps([sys.executable,str(ROOT/'tests/core/fake_analysis_codex.py')])
        self.environment['SUPERAGENT_CODEX_HOME']=str(self.root/'codex-home')
        return original()
    case.start=types.MethodType(start_peer,case)
    return case


def create(case, goal):
    return case.request('POST','/api/v1/tasks',{'title':'分析','goal':goal,'kind':'analysis','project_id':case.project['id']})


def test_analysis_is_read_only_and_omits_test_command():
    case=build_case()
    try:
        case.setUp()
        case.request('PATCH', '/api/v1/settings', {
            'codex_model': 'global-model', 'codex_effort': 'medium',
            'codex_task_profiles': {'analysis': {'model': 'analysis-model', 'effort': 'high'}},
        })
        detail=case.wait_status(create(case,'[model-override] 分析仓库'),{'review_ready'})
        assert detail['task']['kind']=='analysis'
        verification=json.loads([a for a in detail['artifacts'] if a['kind']=='verification'][-1]['content'])
        assert verification['analysis_read_evidence']['evidence_calls'] == 1
        assert verification['analysis_read_evidence']['tools'] == ['list_files','read_file']
        assert not (Path(detail['task']['workspace_path'])/'illicit.txt').exists()
    finally: case.doCleanups()


def test_analysis_modified_workspace_cannot_be_ready():
    case=build_case()
    try:
        case.setUp()
        detail=case.wait_status(create(case,'[change] 分析仓库'),{'waiting_input'})
        assert detail['task']['status']=='waiting_input'
        assert detail['task']['status']!='review_ready'
    finally: case.doCleanups()


@pytest.mark.parametrize('modified', [False, True])
def test_channel_reply_is_staged_only_after_analysis_verification(modified):
    case = build_case()
    try:
        case.setUp()
        case.request('PATCH', '/api/v1/settings', {'connectors.dingtalk': {'enabled': False, 'profile': 'offline'}})
        case.request('POST', '/api/v1/identities', {'source': 'dingtalk', 'actor_id': 'trusted',
            'user_id': 'admin', 'project_ids': [case.project['id']], 'permissions': ['request']})
        receipt = case.request('POST', '/api/v1/events', {
            'source': 'dingtalk', 'external_id': 'analysis-for-channel', 'event_type': 'message.received',
            'actor_id': 'trusted', 'thread_id': 'offline-chat', 'project_external_id': 'offline-chat',
            'content': '[channel-reply] 请只读分析 README 代码逻辑' + (' [change]' if modified else ''),
            'metadata': {'profile': 'offline', 'message_id': 'analysis-for-channel', 'at_me': True,
                         'dws_event_type': 'user_im_message_receive_group'},
        })
        ident = receipt['task_id']
        detail = case.wait_status({'id': ident}, {'waiting_input'} if modified else {'review_ready'})
        assert detail['task']['kind'] == 'analysis'
        decisions = [e for e in detail['events'] if e['event_type'] == 'reply_decision']
        drafts = case.request('GET', f'/api/v1/tasks/{ident}/deliveries')
        if modified:
            assert not decisions and not drafts
        else:
            assert decisions[0]['data']['decision'] == 'send'
            assert drafts[0]['content'] == '已核实 README 第 1 行为 baseline。'
            assert not drafts[0].get('delivery')
    finally:
        case.doCleanups()


def test_analysis_denies_approval_and_resumes_read_only():
    case=build_case()
    try:
        case.setUp()
        task=create(case,'[approval] 分析仓库')
        detail=case.wait_status(task,{'waiting_input'})
        assert not any(a['status']=='pending' for a in detail['approvals'])
        case.request('POST',f"/api/v1/tasks/{task['id']}/controls",{'action':'resume'})
        resumed=case.wait_status(task,{'review_ready'})
        assert len([x for x in resumed['events'] if x['event_type']=='run_started'])==2
    finally: case.doCleanups()


def test_repair_retains_existing_delivery_path():
    spec=importlib.util.spec_from_file_location('repair_fixture',ROOT/'tests/e2e/test_blackbox.py')
    mod=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    case=mod.BlackBoxAcceptance(methodName='test_full_delivery_and_persistence')
    original=case.start
    def isolated_home(self):
        self.environment['SUPERAGENT_CODEX_HOME']=str(self.root/'codex-home')
        return original()
    case.start=types.MethodType(isolated_home,case)
    try:
        case.setUp()
        case.test_full_delivery_and_persistence()
    finally: case.doCleanups()


def test_sensitive_denial_cannot_be_hidden_by_later_success():
    case=build_case()
    try:
        case.setUp()
        detail=case.wait_status(create(case,'[denied] 分析仓库'),{'waiting_input'})
        verification=json.loads([a for a in detail['artifacts'] if a['kind']=='verification'][-1]['content'])
        assert verification['analysis_read_evidence']['denied_access'] is True
        assert verification['analysis_read_evidence']['evidence_calls']==1
        assert any(e['event_type']=='readonly_tool' and e['data']['denied'] for e in detail['events'])
    finally: case.doCleanups()


def test_event_collaboration_returns_to_primary_worker():
    """Real HTTP + scheduler + isolated fake peers, no external model or channels."""
    import time
    case = build_case()
    try:
        case.setUp()
        task = create(case, '[collaborate] 分析仓库并请求协作')
        deadline = time.monotonic() + 45
        while time.monotonic() < deadline:
            detail = case.request('GET', f"/api/v1/event-groups/{task['id']}")
            results = [e for e in detail['events'] if e['event_type'] == 'collaboration_result']
            if results and detail['group']['status'] == 'review_ready':
                break
            time.sleep(.2)
        else:
            raise AssertionError(detail)
        assert len(results) == 1
        child = case.request('GET', f"/api/v1/tasks/{results[0]['data']['child_group_id']}")
        assert child['task']['kind'] == 'analysis'
        assert child['task']['workspace_path'] != detail['group']['workspace_path']
        assert detail['group']['pending_event_count'] >= 2
        transcript = case.request('GET', f"/api/v1/sessions/worker:{task['id']}")
        assert any('协作 Worker' in message['content'] for message in transcript['messages'])
    finally:
        case.doCleanups()
