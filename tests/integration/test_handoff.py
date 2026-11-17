import asyncio
from types import SimpleNamespace
import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from superagent.core.db import Base, Project, Task, Approval
from superagent.core.governance import Principal
from superagent.api import sessions as api
from superagent.core.scheduler import scheduler

def run_immediate(coroutine):
    # This handler only awaits an uncontended lock; fail if that contract changes.
    try:
        yielded = coroutine.send(None)
    except StopIteration as done:
        return done.value
    finally:
        coroutine.close()
    pytest.fail(f"Unexpected asynchronous I/O or lock contention: {yielded!r}")


@pytest.mark.parametrize('status,unknown,active,allowed', [('running',False,False,False),('paused',True,False,False),('paused',False,True,False),('paused',False,False,True),('completed',False,False,True),('failed',False,False,True),('review_ready',False,False,True)])
def test_handoff_requires_stopped_execution(tmp_path,monkeypatch,status,unknown,active,allowed):
    engine=create_engine('sqlite:///'+str(tmp_path/'handoff.db'))
    Base.metadata.create_all(engine)
    factory=sessionmaker(engine,expire_on_commit=False)
    monkeypatch.setattr(api,'Session',factory)
    monkeypatch.setattr(scheduler,'active',{1:object()} if active else {})
    with factory.begin() as s:
        s.add(Project(id=1,name='P',repo_path=str(tmp_path)))
        s.add(Task(id=1,title='T',goal='goal',project_id=1,status=status,outcome_unknown=unknown,codex_thread_id='actual-thread'))
        s.add(Approval(id=1,task_id=1,revision=1,control_version=1,action_hash='test',action={},status='pending'))
    req=SimpleNamespace(state=SimpleNamespace(principal=Principal(user_id='root',role='admin')))
    if allowed:
        result=run_immediate(api.handoff_material('worker:1',req))
        assert result['thread_id']=='actual-thread'
        assert 'goal' in result['content']
        with factory() as s:
            task=s.get(Task,1)
            assert task.status == ('completed' if status == 'completed' else 'paused')
            if status != 'completed':
                assert task.state_version == 2
                assert task.control_version == 2
                assert s.get(Approval,1).status == 'expired'
    else:
        with pytest.raises(HTTPException) as exc: run_immediate(api.handoff_material('worker:1',req))
        assert exc.value.status_code==409
    req.state.principal=Principal(user_id='outsider',role='member')
    with pytest.raises(HTTPException) as exc: run_immediate(api.handoff_material('worker:1',req))
    assert exc.value.status_code==404
    engine.dispose()
