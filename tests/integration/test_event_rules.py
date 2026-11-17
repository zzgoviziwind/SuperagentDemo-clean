from datetime import datetime, timezone
from types import SimpleNamespace
import pytest
from superagent.core.event_rules import EventRule, evaluate

class Store:
    def __init__(self, items): self.items = items
    def get(self, *args): return SimpleNamespace(value=self.items)

def test_private_rule_scope_and_overnight_boundaries():
    rule = EventRule(name='内部敏感规则', action='quiet', project_id=3, source='dingtalk', chat_id='group').model_dump()
    session = Store([rule])
    event = SimpleNamespace(source='dingtalk', data={'thread_id':'group'})
    assert evaluate(session,event,3,at=datetime(2026,1,1,12,tzinfo=timezone.utc)) == {'quiet'}
    assert evaluate(session,event,3,at=datetime(2026,1,2,0,tzinfo=timezone.utc)) == set()
    assert evaluate(session,event,4,at=datetime(2026,1,1,12,tzinfo=timezone.utc)) == set()
    assert '内部敏感规则' not in str(event.data)

def test_actor_kind_and_disabled_rules():
    rule = EventRule(name='暂缓', action='pause', source='redmine', actor_id='7', kind='repair').model_dump()
    event = SimpleNamespace(source='redmine', data={'actor_id':'7'})
    assert evaluate(Store([rule]),event,1,'analysis') == set()
    assert evaluate(Store([rule]),event,1,'repair') == {'pause'}
    assert evaluate(Store([dict(rule,enabled=False)]),event,1,'repair') == set()

def test_invalid_quiet_range():
    with pytest.raises(ValueError): EventRule(name='无效',action='quiet',start_hour=8,end_hour=8)

def test_ingestion_holds_without_leaking_private_rule():
    from sqlalchemy import create_engine, select
    from sqlalchemy.orm import sessionmaker
    from superagent.core.db import Base, Project, Task
    from superagent.core.governance import Setting
    from superagent.core.ingestion import ingest_event
    engine = create_engine('sqlite:///:memory:')
    Base.metadata.create_all(engine)
    factory = sessionmaker(engine, expire_on_commit=False)
    with factory.begin() as s:
        s.add(Project(name='test',repo_path='.',dingtalk_chat_ids=['chat']))
        s.add(Setting(key='private_event_rules',value=[EventRule(name='不要告诉任何人',action='pause',project_id=1).model_dump()]))
    payload = {'source':'dingtalk','external_id':'one','event_type':'message.received','actor_id':'trusted','thread_id':'chat','project_external_id':'chat','content':'请修复代码','metadata':{}}
    receipt = ingest_event(payload,session_factory=factory,actor_resolver=lambda *_:{'user_id':'admin','role':'admin','project_ids':[1],'permissions':['request']})
    assert receipt['data']['routing_reason'] == 'private_policy_hold'
    assert '不要告诉任何人' not in str(receipt)
    with factory() as s: assert not list(s.scalars(select(Task)))
    engine.dispose()

def test_subscription_task_kind_cannot_bypass_hold():
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from superagent.core.db import Base, Project, Task, Event
    from superagent.core.governance import Setting
    from superagent.core.subscriptions import subscribe, fanout
    engine = create_engine('sqlite:///:memory:')
    Base.metadata.create_all(engine)
    factory = sessionmaker(engine, expire_on_commit=False)
    actor = {'user_id':'admin','role':'admin','project_ids':[1],'permissions':['request']}
    with factory.begin() as s:
        project=Project(name='test',repo_path='.',dingtalk_chat_ids=['chat']); s.add(project); s.flush()
        task=Task(project_id=project.id,title='repair',goal='repair',kind='repair'); s.add(task); s.flush()
        subscribe(s,project_id=project.id,source='dingtalk',thread_id='chat',task_id=task.id,actor=actor)
        s.add(Setting(key='private_event_rules',value=[EventRule(name='private',action='pause',kind='repair').model_dump()])); s.flush()
        event=Event(source='dingtalk',external_id='one',event_type='message.received',content='hello',data={'thread_id':'chat'});s.add(event);s.flush()
        assert fanout(s,event,project,actor) == []
        assert task.revision == 1
    engine.dispose()

def test_ledger_rechecks_policy_after_approval():
    import asyncio
    from sqlalchemy import create_engine, select
    from sqlalchemy.orm import sessionmaker
    from superagent.core.db import Base, Project, Task, Event, Approval
    from superagent.core.governance import Setting
    from superagent.core.delivery import ReplyDraft, PersistentActionLedger, DeliveryRecord
    engine=create_engine('sqlite:///:memory:');Base.metadata.create_all(engine)
    factory=sessionmaker(engine,expire_on_commit=False)
    with factory.begin() as s:
        p=Project(name='p',repo_path='.');s.add(p);s.flush()
        t=Task(project_id=p.id,title='t',goal='g');s.add(t);s.flush()
        e=Event(task_id=t.id,source='dingtalk',event_type='message.received',content='hello',data={'thread_id':'chat','routing_status':'routed'});s.add(e);s.flush()
        a=Approval(task_id=t.id,status='approved',revision=t.revision,control_version=t.control_version,action_hash='hash',action={'source':'dingtalk'});s.add(a);s.flush()
        s.add(ReplyDraft(task_id=t.id,event_id=e.id,approval_id=a.id,content='普通回复'))
        s.add(Setting(key='private_event_rules',value=[EventRule(name='内部原因',action='pause').model_dump()]))
        action_id='reply-'+str(a.id)
    with pytest.raises(PermissionError, match='当前交付暂不可用'):
        PersistentActionLedger(factory).claim(action_id,'hash').send(None)
    with factory() as s: assert not list(s.scalars(select(DeliveryRecord)))
    engine.dispose()
