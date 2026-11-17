from types import SimpleNamespace
import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from superagent.core.db import Base, Project, Task, Event, Artifact
from superagent.core.governance import Principal
from superagent.api import sessions as api


def test_session_visibility_and_history(tmp_path, monkeypatch):
    engine=create_engine('sqlite:///' + str(tmp_path / 'sessions.db'))
    Base.metadata.create_all(engine)
    factory=sessionmaker(engine, expire_on_commit=False)
    monkeypatch.setattr(api, 'Session', factory)
    monkeypatch.setattr(api.gov, 'settings_snapshot', lambda: {})
    with factory.begin() as s:
        s.add_all([Project(id=1,name='A',repo_path=str(tmp_path)),Project(id=2,name='B',repo_path=str(tmp_path))])
        s.add_all([Task(id=1,title='Own',goal='g',project_id=1,owner_id='a'),Task(id=2,title='Other',goal='g',project_id=2,owner_id='b')])
        s.add(Event(task_id=1,source='web',event_type='message',content='补充'))
        s.add(Artifact(task_id=1,revision=1,kind='summary',content='答复'))
    request=SimpleNamespace(state=SimpleNamespace(principal=Principal(user_id='a',role='member')))
    assert [v['id'] for v in api.list_sessions(request)] == ['worker:1']
    result=api.session_detail('worker:1',request)
    assert {m['content'] for m in result['messages']} == {'g','补充','答复'}
    for ident in ('worker:2','router:1'):
        with pytest.raises(HTTPException) as exc:
            api.session_detail(ident,request)
        assert exc.value.status_code == 404
    admin=SimpleNamespace(state=SimpleNamespace(principal=Principal(user_id='root',role='admin')))
    assert {v['id'] for v in api.list_sessions(admin,project_id=1)} == {'worker:1','router:1'}
    engine.dispose()


def test_external_initial_and_assistant_artifact_dedup(tmp_path, monkeypatch):
    engine=create_engine('sqlite:///' + str(tmp_path / 'history.db'))
    Base.metadata.create_all(engine)
    factory=sessionmaker(engine, expire_on_commit=False)
    monkeypatch.setattr(api, 'Session', factory)
    with factory.begin() as s:
        s.add(Project(id=1,name='A',repo_path=str(tmp_path)))
        s.add(Task(id=1,title='T',goal='初始',project_id=1,owner_id='a'))
        s.add(Event(task_id=1,source='dingtalk',event_type='assistant_message',content='来自钉钉的原文',data={'routing_status':'routed'}))
        artifact=Artifact(task_id=1,revision=1,kind='summary',content='回答')
        s.add(artifact); s.flush()
        s.add(Event(task_id=1,source='runtime',event_type='assistant_message',content='回答',data={'artifact_id':artifact.id}))
    request=SimpleNamespace(state=SimpleNamespace(principal=Principal(user_id='a',role='member')))
    messages=api.session_detail('worker:1',request)['messages']
    assert [m['content'] for m in messages].count('回答') == 1
    assert [m['content'] for m in messages].count('来自钉钉的原文') == 1
    assert next(m for m in messages if m['content']=='来自钉钉的原文')['role'] == 'user'
    engine.dispose()


def test_worker_message_stale_and_unauthorized(tmp_path, monkeypatch):
    import asyncio
    import superagent.main as main
    engine=create_engine('sqlite:///' + str(tmp_path / 'versions.db'))
    Base.metadata.create_all(engine)
    factory=sessionmaker(engine, expire_on_commit=False)
    monkeypatch.setattr(api, 'Session', factory)
    monkeypatch.setattr(main, 'Session', factory)
    with factory.begin() as s:
        s.add(Project(id=1,name='A',repo_path=str(tmp_path)))
        s.add(Task(id=1,title='T',goal='初始',project_id=1,owner_id='a',state_version=3))
    owner=SimpleNamespace(state=SimpleNamespace(principal=Principal(user_id='a',role='member')))
    other=SimpleNamespace(state=SimpleNamespace(principal=Principal(user_id='b',role='member')))
    body=api.MessageIn(content='纠正',expected_state_version=2)
    for request, status in ((owner,409),(other,404)):
        with pytest.raises(HTTPException) as exc:
            api.post_message('worker:1',body,request).send(None)
        assert exc.value.status_code == status
    with factory() as s:
        assert not s.query(Event).filter(Event.task_id==1).all()
    engine.dispose()



def test_router_passes_actor_and_restricts_reconcile(tmp_path, monkeypatch):
    from superagent.core.router_agent import router_agent
    engine=create_engine('sqlite:///' + str(tmp_path / 'router-actor.db'))
    Base.metadata.create_all(engine)
    factory=sessionmaker(engine, expire_on_commit=False)
    monkeypatch.setattr(api, 'Session', factory)
    with factory.begin() as s:
        s.add(Project(id=1,name='A',repo_path=str(tmp_path)))
    seen=[]
    async def enqueue(project_id, content, version, *, actor):
        seen.append(('enqueue', project_id, content, version, actor))
        return {'ok': True}
    async def reconcile(project_id, evidence, version, *, actor):
        seen.append(('reconcile', project_id, evidence, version, actor))
        return {'ok': True}
    monkeypatch.setattr(router_agent, 'enqueue', enqueue)
    monkeypatch.setattr(router_agent, 'reconcile', reconcile)
    admin=SimpleNamespace(state=SimpleNamespace(principal=Principal(user_id='alice',role='admin')))
    member=SimpleNamespace(state=SimpleNamespace(principal=Principal(user_id='bob',role='member')))
    for coro in (api.post_message('router:1',api.MessageIn(content='说明',expected_state_version=2),admin),
                 api.reconcile('router:1',api.ReconcileIn(evidence='已核验',expected_state_version=3),admin)):
        with pytest.raises(StopIteration) as done:
            coro.send(None)
        assert done.value.value == {'ok': True}
    with pytest.raises(HTTPException) as denied:
        api.reconcile('router:1',api.ReconcileIn(evidence='已核验',expected_state_version=3),member).send(None)
    assert denied.value.status_code == 404
    assert seen == [('enqueue',1,'说明',2,'alice'),('reconcile',1,'已核验',3,'alice')]
    engine.dispose()

@pytest.mark.anyio
async def test_coordination_append_idempotent_and_guarded(tmp_path, monkeypatch):
    from superagent.core import ingestion
    from superagent.core.subscriptions import EventTarget
    from sqlalchemy import select
    engine=create_engine('sqlite:///' + str(tmp_path / 'coord.db'))
    Base.metadata.create_all(engine)
    factory=sessionmaker(engine, expire_on_commit=False)
    monkeypatch.setattr(api, 'Session', factory)
    monkeypatch.setattr(ingestion, 'trusted_actor', lambda *_: {'user_id':'a','role':'admin','permissions':['request'],'project_ids':[1]})
    with factory.begin() as s:
        s.add(Project(id=1,name='A',repo_path=str(tmp_path),dingtalk_chat_ids=['chat']))
        s.add_all([Task(id=i,title='T',goal='g',project_id=1,owner_id='a') for i in [1,2]])
        s.add(Event(id=1,task_id=1,source='dingtalk',external_id='m',event_type='message',content='补充',data={'actor_id':'a','project_external_id':'chat'}))
    req=SimpleNamespace(state=SimpleNamespace(principal=Principal(user_id='a',role='admin')))
    body=api.CoordinationIn(target_task_id=2,event_id=1,evidence='同一任务',expected_state_version=1,request_key='r')
    row=api.request_coordination('worker:2',body,req)
    assert api.request_coordination('worker:2',body,req)['id']==row['id']
    with pytest.raises(HTTPException):
        api.request_coordination('worker:2',body.model_copy(update={'evidence':'different'}),req)
    applied=await api.apply_coordination('worker:2',row['id'],req)
    assert applied['data']['status']=='applied'
    assert applied['data']['retained_task_ids']==[1]
    await api.apply_coordination('worker:2',row['id'],req)
    with factory() as s:
        assert len(list(s.scalars(select(EventTarget))))==1
        assert s.get(Event,1).task_id==1
    with pytest.raises(HTTPException):
        api.request_coordination('worker:2',body.model_copy(update={'request_key':'stale'}),req)
    pending=api.request_coordination('worker:2',body.model_copy(update={'event_id':None,'source_reference':'Redmine #42','request_key':'fetch','expected_state_version':2}),req)
    assert pending['data']['status']=='awaiting_source'
    with pytest.raises(HTTPException):
        await api.apply_coordination('worker:2',pending['id'],req)
    engine.dispose()

