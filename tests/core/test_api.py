import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from superagent.core import db, scheduler as scheduler_module, ingestion
import superagent.main as main


@pytest.fixture
def api_db(tmp_path, monkeypatch):
    engine=create_engine('sqlite:///'+(tmp_path / 'control.db').as_posix(),connect_args={'check_same_thread':False})
    factory=sessionmaker(engine,expire_on_commit=False)
    monkeypatch.setattr(db,'engine',engine)
    monkeypatch.setattr(db,'Session',factory)
    monkeypatch.setattr(main,'Session',factory)
    monkeypatch.setattr(scheduler_module,'Session',factory)
    monkeypatch.setattr(ingestion,'Session',factory)
    monkeypatch.setattr(main.manager,'sessions',factory)
    monkeypatch.setattr(main.manager.store,'sessions',factory)
    monkeypatch.setenv('SUPERAGENT_API_TOKEN','test-token')
    yield
    engine.dispose()


@pytest.fixture
def api(api_db):
    with TestClient(main.app, headers={'Authorization':'Bearer test-token'}) as client:
        yield client


def test_persistence_controls_and_dedup(api, tmp_path):
    p=api.post('/api/v1/projects',json={'name':'test','repo_path':str(tmp_path)}); assert p.status_code==200
    t=api.post('/api/v1/tasks',json={'title':'Fix','goal':'Fix safely','project_id':p.json()['id']}).json()
    assert api.post(f"/api/v1/tasks/{t['id']}/controls",json={'action':'pause','expected_state_version':t['state_version']}).json()['status']=='paused'
    assert api.post(f"/api/v1/tasks/{t['id']}/controls",json={'action':'resume','expected_state_version':t['state_version']}).status_code==409
    event={'source':'redmine','external_id':'123','content':'hello'}
    assert api.post('/api/v1/events',json=event).status_code==200
    duplicate=api.post('/api/v1/events',json=event)
    assert duplicate.status_code==200 and duplicate.json()['duplicate'] is True
    assert len(api.get(f"/api/v1/tasks/{t['id']}").json()['events'])==2
    assert api.get(f"/api/v1/tasks/{t['id']}").json()['task']['status']=='paused'


def test_authentication_and_unauthorized_source(api, tmp_path):
    assert api.get('/api/v1/tasks',headers={'Authorization':'Bearer invalid'}).status_code==401
    p=api.post('/api/v1/projects',json={'name':'test','repo_path':str(tmp_path)}).json()
    assert api.post('/api/v1/tasks',json={'title':'x','goal':'x','project_id':p['id'],'source':'redmine'}).status_code==403
    assert api.post('/api/v1/projects',json={'name':'x','repo_path':'relative'}).status_code in (403,422)


def test_project_delete_retains_history_and_removes_from_selection(api, tmp_path):
    empty = api.post('/api/v1/projects', json={'name': '空项目', 'repo_path': str(tmp_path)}).json()
    assert api.delete(f"/api/v1/projects/{empty['id']}").json()['deleted']
    project = api.post('/api/v1/projects', json={'name': '历史项目', 'repo_path': str(tmp_path)}).json()
    task = api.post('/api/v1/tasks', json={'title': '保留记录', 'goal': '查看历史', 'project_id': project['id']}).json()
    assert api.delete(f"/api/v1/projects/{project['id']}").json()['archived']
    assert api.get('/api/v1/projects').json() == []
    assert api.get(f"/api/v1/tasks/{task['id']}").status_code == 200


def test_directory_browser_and_scope(api, tmp_path, monkeypatch):
    (tmp_path / 'frontend').mkdir()
    monkeypatch.setenv('SUPERAGENT_ALLOWED_REPO_ROOTS', str(tmp_path))
    response = api.get('/api/v1/project-workspace', params={'path': str(tmp_path)})
    assert response.status_code == 200
    assert response.json()['parent'] is None
    assert any(row['name'] == 'frontend' for row in response.json()['directories'])
    assert api.get('/api/v1/project-workspace', params={'path': str(tmp_path.parent)}).status_code == 422


def test_reply_acceptance_requires_current_real_turn_and_summary(api, tmp_path):
    import json
    p=api.post('/api/v1/projects',json={'name':'reply','repo_path':str(tmp_path)}).json()
    t=api.post('/api/v1/tasks',json={'title':'answer','goal':'answer','kind':'reply','project_id':p['id']}).json()
    with db.Session.begin() as session:
        row=session.get(db.Task,t['id'])
        row.status='review_ready'
        row.codex_thread_id='real-thread'
        row.codex_turn_id='real-turn'
        session.add(db.Artifact(task_id=row.id,revision=1,kind='verification',content='[]'))
    path=f"/api/v1/tasks/{t['id']}/acceptance"
    body={'accepted':True,'revision':1}
    assert api.post(path,json=body).status_code==409
    with db.Session.begin() as session:
        session.add(db.Artifact(task_id=t['id'],revision=1,kind='verification',content=json.dumps({
            'kind':'reply','turn_status':'completed','thread_id':'real-thread','turn_id':'real-turn'})))
    assert api.post(path,json=body).status_code==409
    with db.Session.begin() as session:
        session.add(db.Artifact(task_id=t['id'],revision=1,kind='summary',content='实际答复'))
    assert api.post(path,json=body).json()['status']=='completed'


def test_cancelled_can_resume_and_reply_can_continue_analysis(api, tmp_path):
    project = api.post('/api/v1/projects', json={'name': '恢复测试', 'repo_path': str(tmp_path)}).json()
    task = api.post('/api/v1/tasks', json={'title': '进展', 'goal': '核实项目进展', 'project_id': project['id']}).json()
    ident = task['id']
    cancelled = api.post(f'/api/v1/tasks/{ident}/controls', json={'action': 'cancel', 'expected_state_version': task['state_version']}).json()
    resumed = api.post(f'/api/v1/tasks/{ident}/controls', json={'action': 'resume', 'expected_state_version': cancelled['state_version']})
    assert resumed.status_code == 200
    assert resumed.json()['status'] == 'queued'
    assert resumed.json()['revision'] == cancelled['revision'] + 1
    with db.Session.begin() as session:
        row = session.get(db.Task, ident)
        row.kind, row.status = 'reply', 'cancelled'
        row.codex_thread_id = 'old-reply-thread'
    analyzed = api.post(f'/api/v1/tasks/{ident}/controls', json={'action': 'analyze', 'expected_state_version': resumed.json()['state_version']})
    assert analyzed.status_code == 200
    assert analyzed.json()['kind'] == 'analysis'
    assert analyzed.json()['codex_thread_id'] is None
    assert analyzed.json()['status'] == 'queued'
    assert api.post(f'/api/v1/tasks/{ident}/controls', json={'action': 'analyze'}).status_code == 409
    with db.Session.begin() as session:
        row = session.get(db.Task, ident)
        row.status, row.outcome_unknown = 'cancelled', True
    assert api.post(f'/api/v1/tasks/{ident}/controls', json={'action': 'resume'}).status_code == 409


@pytest.mark.parametrize('action', ['pause', 'cancel'])
def test_restart_during_readonly_stop_allows_closing_without_reply(api_db, tmp_path, monkeypatch, action):
    from superagent.core.delivery import DeliveryRecord, ReplyDraft

    async def lose_stop_confirmation(ident, action):
        pass  # Simulate shutdown before the stop request can update persisted state.

    worker = scheduler_module.Scheduler()
    monkeypatch.setattr(main, 'scheduler', worker)
    monkeypatch.setattr(worker, 'stop_run', lose_stop_confirmation)
    headers = {'Authorization': 'Bearer test-token'}
    with TestClient(main.app, headers=headers) as api:
        project = api.post('/api/v1/projects', json={'name': '重启测试', 'repo_path': str(tmp_path)}).json()
        task = api.post('/api/v1/tasks', json={'title': '无需回复', 'goal': '查看消息',
                        'project_id': project['id'], 'kind': 'analysis'}).json()
        ident = task['id']
        with db.Session.begin() as session:
            row = session.get(db.Task, ident)
            row.status = 'running'
            session.add(db.Event(task_id=ident, source='dingtalk', event_type='message.received', content='原消息'))
            session.add(db.Task(project_id=project['id'], title='其他等待', goal='等待资源',
                                status='waiting_resource', last_error='调度已关闭'))
        url = f'/api/v1/tasks/{ident}'
        stop = api.post(f'{url}/controls', json={'action': action, 'expected_state_version': task['state_version']})
        assert stop.status_code == 200
        pending = stop.json()
        assert pending['status'] == 'waiting_resource' and pending['last_error'] == '正在停止执行'

    monkeypatch.setattr(main, 'scheduler', scheduler_module.Scheduler())
    with TestClient(main.app, headers=headers) as api:
        recovered = api.get(url).json()['task']
        assert recovered['outcome_unknown'] and recovered['last_error'] != pending['last_error']
        assert recovered['state_version'] == pending['state_version'] + 1
        assert api.post(f'{url}/controls', json={'action': 'cancel'}).status_code == 409
        closed = api.post(f'{url}/reconcile', json={
            'outcome': 'abandoned', 'evidence': '已核对执行端，确认无活动执行；无需回复',
            'expected_state_version': recovered['state_version'],
        })
        assert closed.status_code == 200 and closed.json()['status'] == 'cancelled'
        assert any(e['content'] == '原消息' for e in api.get(url).json()['events'])
        with db.Session() as session:
            assert session.query(ReplyDraft).count() == session.query(DeliveryRecord).count() == 0
            other = session.query(db.Task).filter_by(title='其他等待').one()
            assert not other.outcome_unknown and other.last_error == '调度已关闭'


def test_resume_reply_blocked_before_start_rechecks_engine_and_preserves_revision(api, tmp_path, monkeypatch):
    from superagent.core import reply_worker
    project = api.post('/api/v1/projects', json={'name':'回复恢复', 'repo_path':str(tmp_path)}).json()
    task = api.post('/api/v1/tasks', json={'title':'回复', 'goal':'检查', 'project_id':project['id'], 'kind':'reply'}).json()
    ident = task['id']
    with db.Session.begin() as session:
        row = session.get(db.Task, ident)
        row.kind, row.status = 'reply', 'waiting_resource'
        row.last_error = '本机回复引擎配置无效，请在 Agent 页面检查连接'
    monkeypatch.setattr(main.gov, 'settings_snapshot', lambda: {'scheduler_enabled': True})
    # Keep the real scheduler disabled; this test exercises the HTTP transition without running a task.
    monkeypatch.setattr(scheduler_module, 'settings_snapshot', lambda: {'scheduler_enabled': False})
    monkeypatch.setattr(reply_worker, 'reply_command', lambda: (None, '本机 Codex 不可用'))
    url = f'/api/v1/tasks/{ident}/controls'
    body = {'action':'resume', 'expected_state_version':task['state_version']}
    assert api.post(url, json=body).json()['detail'] == '本机 Codex 不可用'
    monkeypatch.setattr(reply_worker, 'reply_command', lambda: ('offline-codex', None))
    with db.Session.begin() as session:
        session.get(db.Task, ident).outcome_unknown = True
    assert api.post(url, json=body).status_code == 409
    with db.Session.begin() as session:
        session.get(db.Task, ident).outcome_unknown = False
    result = api.post(url, json=body)
    assert result.status_code == 200
    queued = result.json()
    assert (queued['status'], queued['revision'], queued['last_error']) == ('queued', task['revision'], None)
    assert api.post(url, json=body).status_code == 409


def test_rebinding_stopped_event_preserves_history_and_requires_fresh_workspace(api, tmp_path):
    from superagent.core.ingestion import TaskRoute
    before = api.post('/api/v1/projects', json={'name': '原项目', 'repo_path': str(tmp_path)}).json()
    after = api.post('/api/v1/projects', json={'name': '正确项目', 'repo_path': str(tmp_path), 'reference_access': 'projects'}).json()
    task = api.post('/api/v1/tasks', json={'title':'核对', 'goal':'核对', 'kind':'analysis', 'project_id':before['id']}).json()
    url = f"/api/v1/tasks/{task['id']}/project"
    body = {'project_id':after['id'], 'reason':'核对来源后确认', 'expected_state_version':task['state_version']}
    assert api.post(url, json=body).status_code == 409  # queued cannot be rebound
    with db.Session.begin() as s:
        row = s.get(db.Task, task['id'])
        row.status = 'review_ready'
        row.workspace_path, row.codex_thread_id = 'old-workspace', 'old-thread'
        s.add(TaskRoute(project_id=before['id'], task_id=row.id, route_key='test-source'))
        s.add(db.Artifact(task_id=row.id, revision=1, kind='summary', content='原项目结果'))
    updated = api.post(url, json=body).json()
    assert updated['project_id'] == after['id']
    assert (updated['status'], updated['revision'], updated['workspace_path'], updated['codex_thread_id']) == ('waiting_input', 2, None, None)
    detail = api.get(f"/api/v1/tasks/{task['id']}").json()
    assert detail['artifacts'][0]['content'] == '原项目结果'
    assert detail['events'][-1]['data']['previous_workspace'] == 'old-workspace'
    with db.Session() as s:
        from sqlalchemy import select
        assert s.scalar(select(TaskRoute.project_id).where(TaskRoute.task_id == task['id'])) == after['id']
