import asyncio
from types import SimpleNamespace
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from superagent.core.db import Base, Event
from superagent.core.subscriptions import EventTarget
from superagent.core import connections


def test_each_durable_target_gets_interrupt_and_attachments(tmp_path, monkeypatch):
    engine = create_engine('sqlite:///' + str(tmp_path/'fanout.db'))
    Base.metadata.create_all(engine)
    factory = sessionmaker(engine, expire_on_commit=False)
    with factory.begin() as s:
        s.add(Event(id=1,source='dingtalk',external_id='origin',event_type='message.received'))
        for n in (2,3):
            s.add(Event(id=n,task_id=n,source='dingtalk',event_type='message',data={
                'requires_interrupt':True,'attachments_status':'pending','source_event_id':1}))
            s.add(EventTarget(event_id=1,task_id=n,message_event_id=n))
    stopped, prepared, tracked = [], [], []
    async def stop(ident, reason): stopped.append((ident,reason))
    async def prepare(ident, **kwargs): prepared.append(ident)
    monkeypatch.setattr(connections,'prepare_attachments',prepare)
    owner=SimpleNamespace(stopping=False,_interrupts=set(),_attachment_tasks=set(),track=lambda task, group:tracked.append(task))
    receipt={'id':1,'task_id':None,'data':{'target_task_ids':[2,3]}}
    async def run():
        await connections.schedule_interruption(receipt,scheduler=SimpleNamespace(stop_run=stop),session_factory=factory,owner=owner)
        await connections.schedule_attachments(receipt,session_factory=factory,owner=owner)
        assert connections.schedule_interruption({**receipt,'duplicate':True},session_factory=factory,owner=owner) is None
        assert connections.schedule_attachments({**receipt,'duplicate':True},session_factory=factory,owner=owner) is None
    asyncio.run(run())
    assert sorted(stopped)==[(2,'change_goal'),(3,'change_goal')]
    assert sorted(prepared)==[2,3]
    assert len(tracked)==4
    engine.dispose()
