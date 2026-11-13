import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from superagent.core import db, scheduler as scheduler_module, ingestion
import superagent.main as main


@pytest.fixture
def api(tmp_path, monkeypatch):
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
    with TestClient(main.app, headers={'Authorization':'Bearer test-token'}) as client:
        yield client
    engine.dispose()


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
