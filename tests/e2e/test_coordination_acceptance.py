from types import SimpleNamespace
import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from superagent.core.db import Base, Project, Task, Event
from superagent.core.governance import Principal
from superagent.api import sessions as api
from superagent.core import ingestion
from superagent.core.subscriptions import EventTarget

@pytest.mark.anyio
@pytest.mark.parametrize('case', ['completed','cancelled','unknown','running','unauthorized','unbound','stale'])
async def test_coordination_rejects_invalid_application(tmp_path, monkeypatch, case):
    engine=create_engine('sqlite:///' + str(tmp_path/'accept.db'))
    Base.metadata.create_all(engine)
    factory=sessionmaker(engine, expire_on_commit=False)
    monkeypatch.setattr(api,'Session',factory)
    actor={'user_id':'a','role':'admin','permissions':['request'],'project_ids':[1]}
    monkeypatch.setattr(ingestion,'trusted_actor',lambda *_: actor)
    with factory.begin() as s:
        s.add(Project(id=1,name='P',repo_path=str(tmp_path),dingtalk_chat_ids=['chat']))
        s.add(Task(id=1,title='T',goal='g',project_id=1,owner_id='a'))
        s.add(Event(id=1,source='dingtalk',external_id='e',event_type='message',content='补充',data={'actor_id':'a','project_external_id':'chat'}))
    req=SimpleNamespace(state=SimpleNamespace(principal=Principal(user_id='a',role='admin')))
    body=api.CoordinationIn(target_task_id=1,event_id=1,evidence='核对关联',expected_state_version=1,request_key='one')
    row=api.request_coordination('worker:1',body,req)
    with factory.begin() as s:
        task=s.get(Task,1)
        if case in {'completed','cancelled','running'}: task.status=case
        if case=='unknown': task.outcome_unknown=True
        if case=='stale': task.state_version+=1
        if case=='unbound': s.get(Event,1).data={'actor_id':'a','project_external_id':'another'}
    if case=='unauthorized': actor['permissions']=[]
    with pytest.raises(HTTPException) as err:
        await api.apply_coordination('worker:1',row['id'],req)
    assert err.value.status_code in {403,409}
    with factory() as s:
        assert not list(s.scalars(select(EventTarget)))
        assert s.get(Event,row['id']).data['status']=='pending'
    engine.dispose()
