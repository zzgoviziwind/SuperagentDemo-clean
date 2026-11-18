import asyncio
import json

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from superagent.core import db, reply_worker
from superagent.core.delivery import ReplyDraft, create_draft, decide_draft, publish_draft
from superagent.core.governance import Setting
from superagent.core.ingestion import ingest_event
from superagent.core.message_policy import DEFAULT_POLICY, validate_policy
from superagent.connectors.dingtalk import normalize_event, DingTalkListener, DingTalkClient


def actor(source, actor_id):
    return {'user_id': 'member', 'role': 'member', 'project_ids': [1], 'permissions': ['request']} if actor_id == 'trusted' else None


def message(ident='m1', content='你好', event_type='user_im_message_receive_o2o_all', conversation='direct-chat'):
    return normalize_event({'type': event_type, 'conversation_id': conversation, 'message_id': ident,
        'sender_open_dingtalk_id': 'trusted', 'sender': '群聊名称不能代表类型', 'content': content,
        'event_time': '2026-11-14T01:00:00Z'}, profile='offline', self_ids=['self'])


@pytest.fixture
def store(tmp_path, monkeypatch):
    engine = create_engine('sqlite:///' + str(tmp_path / 'messages.db'), connect_args={'check_same_thread': False})
    db.Base.metadata.create_all(engine)
    factory = sessionmaker(engine, expire_on_commit=False)
    monkeypatch.setattr(db, 'Session', factory)
    monkeypatch.setattr(reply_worker, 'client_options', lambda: {})
    monkeypatch.setattr(reply_worker, 'reserve_model_run', lambda *args, **kwargs: {'id': None, 'billing_mode': 'subscription'})
    monkeypatch.setenv('SUPERAGENT_REPLY_ROOT', str(tmp_path / 'replies'))
    from superagent.core import scheduler
    monkeypatch.setattr(scheduler, 'executable', lambda: 'offline-engine')
    monkeypatch.setattr(reply_worker, 'settings_snapshot', lambda: {'scheduler_enabled': True, 'codex_model': 'offline'})
    with factory.begin() as session:
        session.add(db.Project(id=1, name='消息', repo_path=str(tmp_path / 'does-not-exist'), dingtalk_chat_ids=['direct-chat']))
        session.add(Setting(key='connectors.dingtalk', value={'enabled': True, 'profile': 'offline', 'self_ids': ['self']}))
    yield factory
    engine.dispose()


def receive(store, event, policy=None):
    return ingest_event(event, session_factory=store, actor_resolver=actor,
                        settings=(lambda key, default=None: policy if key == 'dingtalk_response_policy' else default) if policy else None)


def test_direct_type_listener_and_normalization():
    value = message()
    assert value['metadata']['conversation_type'] == 'direct'
    assert value['metadata']['dws_event_type'] == 'user_im_message_receive_o2o_all'
    assert not value['metadata']['at_me']
    listener = DingTalkListener('dws', None, profile='offline', self_ids=['self'], kind='all-direct')
    assert listener.command()[listener.command().index('--kind') + 1] == 'all-direct'
    groups = DingTalkListener('dws', None, profile='offline', self_ids=['self'], kind='all-group')
    assert groups.command()[groups.command().index('--kind') + 1] == 'all-group'


def test_private_hello_is_reply_and_reuses_conversation(store):
    first = receive(store, message())
    assert first['data']['routing_status'] == 'routed'
    with store.begin() as session:
        task = session.get(db.Task, first['task_id'])
        assert task.kind == 'reply'
        task.status = 'review_ready'
    second = receive(store, message('m2', '再解释一下'))
    assert first['task_id'] == second['task_id']
    with store() as session:
        assert session.get(db.Task, first['task_id']).status == 'queued'


def test_policy_off_and_default_project_authorization(store):
    receipt = receive(store, message(), DEFAULT_POLICY | {'direct_messages': 'off'})
    assert receipt['data']['routing_status'] == 'ignored'
    unbound = message('new', conversation='unbound')
    assert receive(store, unbound)['data']['routing_reason'] == 'project_binding_missing_ambiguous_or_disabled'
    chosen = receive(store, message('chosen', conversation='unbound'), DEFAULT_POLICY | {'default_project_id': 1})
    assert chosen['task_id']
    denied = receive(store, message('denied', conversation='unbound'), DEFAULT_POLICY | {'default_project_id': 2})
    assert not denied['task_id']
    unmapped = message('actor') | {'actor_id': 'unknown'}
    assert receive(store, unmapped)['data']['routing_reason'] == 'actor_unmapped_or_disabled'


def test_selected_group_scope_filters_before_routing_but_preserves_direct_reply(store):
    policy = DEFAULT_POLICY | {'group_scope': 'selected', 'group_chat_ids': ['direct-chat']}
    excluded = receive(store, message('excluded', '请分析原因', 'user_im_message_receive_group', 'other-chat'), policy)
    assert excluded['data']['routing_status'] == 'ignored'
    included = receive(store, message('included', '请分析原因', 'user_im_message_receive_group'), policy)
    assert included['task_id']
    direct = receive(store, message('direct', '你好'), policy)
    assert direct['task_id']


def test_explicit_repair_and_paused_reply_are_preserved(store):
    repair = receive(store, message('repair', '请修复功能'))
    with store() as session:
        assert session.get(db.Task, repair['task_id']).kind == 'repair'
    receipt = receive(store, message())
    with store.begin() as session:
        session.get(db.Task, receipt['task_id']).status = 'paused'
    followup = receive(store, message('next', '继续讨论'))
    with store() as session:
        assert session.get(db.Task, followup['task_id']).status == 'paused'


@pytest.mark.parametrize('bad', [DEFAULT_POLICY | {'delivery': 'approved_auto'}, DEFAULT_POLICY | {'default_project_id': True}, {'direct_messages': 'reply'}])
def test_invalid_policy_rejected(bad):
    with pytest.raises(ValueError):
        validate_policy(bad)


class Worker:
    def __init__(self):
        self.clients = {}
    def lock(self, task_id):
        return asyncio.Lock()


class Peer:
    resumes = []
    prompts = []
    def __init__(self, command, cwd, **kwargs):
        self.cwd = cwd
    async def start(self):
        pass
    async def start_thread(self, cwd, instructions='', *, read_only=False, tool_less=False):
        assert read_only and tool_less
        return {'id': 'reply-thread'}
    async def resume_thread(self, thread_id, *, read_only=False, tool_less=False):
        assert read_only and tool_less
        self.resumes.append(thread_id)
        return {'id': thread_id}
    async def start_turn(self, thread_id, prompt, **kwargs):
        assert prompt.strip()
        self.prompts.append(prompt)
        return {'id': 'reply-turn'}
    async def close(self):
        pass
    async def events(self):
        yield {'method': 'item/completed', 'params': {'threadId': 'reply-thread', 'turnId': 'reply-turn', 'item': {'type': 'userMessage'}}}
        yield {'method': 'item/completed', 'params': {'threadId': 'reply-thread', 'turnId': 'reply-turn', 'item': {'id': 'answer', 'type': 'agentMessage', 'text': '你好，有什么需要讨论的？'}}}
        yield {'method': 'turn/completed', 'params': {'threadId': 'reply-thread', 'turn': {'id': 'reply-turn', 'status': 'completed'}}}


def test_reply_worker_without_repository_produces_draft_and_resumes(store):
    Peer.prompts = []
    receipt = receive(store, message())
    worker = Worker()
    asyncio.run(reply_worker.run_reply(worker, receipt['task_id'], client_factory=Peer))
    with store() as session:
        task = session.get(db.Task, receipt['task_id'])
        assert task.status == 'review_ready'
        assert task.workspace_path is None
        draft = session.scalars(select(ReplyDraft)).one()
        assert draft.content == '你好，有什么需要讨论的？'
        approval = session.get(db.Approval, draft.approval_id)
        assert approval.status == 'pending'
        assert approval.action['target']['recipient_id'] == 'trusted'
        assert approval.action['target']['message_id'] == 'm1'
    next_receipt = receive(store, message('m2', '还有呢'))
    asyncio.run(reply_worker.run_reply(worker, next_receipt['task_id'], client_factory=Peer))
    with store() as session:
        drafts = session.scalars(select(ReplyDraft).order_by(ReplyDraft.id)).all()
        assert len(drafts) == 2
        assert session.get(db.Approval, drafts[0].approval_id).status == 'expired'
        assert session.get(db.Approval, drafts[1].approval_id).action['target']['message_id'] == 'm2'
    import json
    context = json.loads(Peer.prompts[-1].split('\n', 1)[1])
    assert [(row['sender'], row['content']) for row in context['messages']] == [('群聊名称不能代表类型', '你好'), ('群聊名称不能代表类型', '还有呢')]
    assert context['project'] == '消息' and context['previous_reply']
    assert Peer.resumes[-1] == 'reply-thread'


@pytest.mark.parametrize('decision', ['send', 'skip', 'review'])
def test_reply_worker_records_model_judgment_and_only_drafts_when_needed(store, decision):
    class JudgingPeer(Peer):
        async def start_turn(self, thread_id, prompt, **kwargs):
            context = json.loads(prompt.split('\n', 1)[1])
            assert context['current_time'].endswith('+08:00')
            assert context['incoming_message']['content'] == '你好'
            assert context['max_auto_reply_age_minutes'] == 120
            return await super().start_turn(thread_id, prompt, **kwargs)

        async def events(self):
            async for event in super().events():
                item = event['params'].get('item', {})
                if item.get('type') == 'agentMessage':
                    item['text'] = json.dumps({'decision': decision, 'reason': '依据当前会话',
                                               'reply': '' if decision == 'skip' else '渠道正文'})
                yield event

    receipt = receive(store, message())
    asyncio.run(reply_worker.run_reply(Worker(), receipt['task_id'], client_factory=JudgingPeer))
    with store() as session:
        judgment = session.scalars(select(db.Event).where(db.Event.event_type == 'reply_decision')).one()
        assert judgment.data['decision'] == decision
        draft = session.scalars(select(ReplyDraft)).first()
        if decision == 'skip':
            assert draft is None and judgment.data['draft_id'] is None
            from superagent.core.event_groups import group_view
            assert group_view(session, session.get(db.Task, receipt['task_id']))['processing_status'] == 'reply_skipped'
        else:
            assert draft.content == '渠道正文' and judgment.data['draft_id'] == draft.id


def test_forbidden_tool_blocks_draft_and_marks_unknown(store):
    receipt = receive(store, message())
    class ToolPeer(Peer):
        async def events(self):
            yield {'method': 'item/completed', 'params': {'threadId': 'reply-thread', 'turnId': 'reply-turn', 'item': {'type': 'commandExecution'}}}
    asyncio.run(reply_worker.run_reply(Worker(), receipt['task_id'], client_factory=ToolPeer))
    with store() as session:
        task = session.get(db.Task, receipt['task_id'])
        assert task.outcome_unknown
        assert task.status == 'waiting_resource'
        assert session.scalars(select(ReplyDraft)).first() is None
        assert session.scalars(select(db.Event).where(db.Event.event_type == 'reply_tool_denied')).first()


def test_incomplete_source_configuration_keeps_answer(store):
    receipt = receive(store, message())
    with store.begin() as session:
        session.get(Setting, 'connectors.dingtalk').value = {'profile': 'other-account'}
    asyncio.run(reply_worker.run_reply(Worker(), receipt['task_id'], client_factory=Peer))
    with store() as session:
        assert session.get(db.Task, receipt['task_id']).status == 'waiting_input'
        assert session.scalars(select(db.Artifact).where(db.Artifact.kind == 'summary')).one().content
        assert session.scalars(select(ReplyDraft)).first() is None


def test_unknown_worker_blocks_old_draft_approval(store):
    receipt = receive(store, message())
    draft = create_draft(receipt['task_id'], receipt['id'], '回复', session_factory=store)
    with store.begin() as session:
        session.get(db.Task, receipt['task_id']).outcome_unknown = True
    with pytest.raises(ValueError):
        decide_draft(draft['id'], 'approve', draft['approval']['action_hash'], session_factory=store)


def test_group_policy_and_legacy_migration(store):
    with store.begin() as session:
        session.get(db.Project, 1).dingtalk_chat_ids = ['direct-chat', 'group-chat']
        session.add(Setting(key='dingtalk_route_all_mentions', value=True))
    group = message('group-off', '请检查问题', event_type='user_im_message_receive_group', conversation='group-chat')
    assert receive(store, group)['data']['routing_status'] == 'ignored'
    mention = message('group-mention', '你好', event_type='user_im_message_receive_at', conversation='group-chat')
    assert receive(store, mention)['task_id']
    assert receive(store, message('group-request', '请检查问题', event_type='user_im_message_receive_group', conversation='group-chat'), DEFAULT_POLICY)['task_id']
    assert receive(store, message('group-disabled', '请检查问题', event_type='user_im_message_receive_at', conversation='group-chat'), DEFAULT_POLICY | {'group_messages': 'off'})['data']['routing_status'] == 'ignored'


def fast_filter_evidence(receipt):
    return next(step['detail'] for step in receipt['data']['_lifecycle'][-1]['steps'] if step['stage'] == 'fast_filter')


def test_semantic_pending_trace_contains_actual_callback_grants_and_policy(store):
    actual_policy = DEFAULT_POLICY | {'group_messages': 'requests', 'delivery': 'approved_send'}
    with store.begin() as session:
        session.add(Setting(key='dingtalk_response_policy', value=DEFAULT_POLICY | {'group_messages': 'off'}))
    def settings(key, default=None):
        return {'dingtalk_response_policy': actual_policy, 'semantic_routing_enabled': True}.get(key, default)
    event = message('trace-pending', '请分析消息处理过程', event_type='user_im_message_receive_group')
    receipt = ingest_event(event, session_factory=store, actor_resolver=actor, settings=settings)
    assert receipt['data']['routing_status'] == 'semantic_pending'
    detail = fast_filter_evidence(receipt)
    assert detail['validated_actor_user_id'] == 'member'
    assert detail['resolved_actor'] == {'user_id': 'member', 'role': 'member', 'enabled': True, 'project_ids': [1], 'permissions': ['request']}
    assert detail['effective_response_policy'] == actual_policy
    assert detail['persisted_response_policy']['group_messages'] == 'off'
    assert detail['policy_allowed'] is True
    assert detail['conversation_type'] == 'group'
    assert detail['settings_provider'] == 'callback'
    assert detail['project_candidates'][0]['id'] == 1
    assert detail['project_selection_source'] == 'external_binding'
    assert detail['authorization']['status'] == 'passed'
    assert all(rule['allowed'] for rule in detail['authorization']['rules'])


@pytest.mark.parametrize('failure', ['identity', 'policy', 'grant'])
def test_blocked_trace_retains_checked_values_without_later_passes(store, failure):
    value = actor('dingtalk', 'trusted')
    policy = DEFAULT_POLICY
    if failure == 'identity':
        value = value | {'enabled': False}
    elif failure == 'policy':
        policy = policy | {'direct_messages': 'off'}
    else:
        value = value | {'permissions': []}
    receipt = ingest_event(message('blocked-' + failure), session_factory=store, actor_resolver=lambda *_: value,
                           settings=lambda key, default=None: policy if key == 'dingtalk_response_policy' else default)
    detail = fast_filter_evidence(receipt)
    assert detail['resolved_actor']['user_id'] == 'member'
    assert detail['blocked_reason'] == receipt['data']['routing_reason']
    if failure == 'identity':
        assert detail['resolved_actor']['enabled'] is False
        assert detail['effective_response_policy'] is None
        assert detail['project_candidates'] is None
        assert detail['authorization']['status'] == 'not_evaluated'
        assert 'response_policy' not in detail['checks']
    elif failure == 'policy':
        assert detail['effective_response_policy'] == policy
        assert detail['policy_allowed'] is False
        assert detail['project_candidates'] is None
        assert detail['authorization']['status'] == 'not_evaluated'
        assert 'project_binding' not in detail['checks']
    else:
        assert detail['resolved_actor']['permissions'] == []
        assert detail['authorization']['allowed'] is False
        assert detail['authorization']['rules'][-1] == {'rule': 'request_permission_required', 'allowed': False}
        assert 'event_type' not in detail['checks']


def test_trace_uses_actual_default_project_callback_and_records_denied_scope(store):
    with store.begin() as session:
        session.add(db.Project(id=2, name='未授权项目', repo_path='unused'))
        session.add(Setting(key='dingtalk_response_policy', value=DEFAULT_POLICY | {'default_project_id': 1}))
    actual_policy = DEFAULT_POLICY | {'default_project_id': 2}
    receipt = receive(store, message('trace-fallback', conversation='unbound'), actual_policy)
    detail = fast_filter_evidence(receipt)
    assert receipt['data']['routing_reason'] == 'actor_not_authorized_for_project'
    assert detail['project_matches'] == []
    assert detail['project_selection_source'] == 'configured_direct_default'
    assert detail['default_project_fallback'] == {'attempted': True, 'configured_project_id': 2, 'found': True}
    assert detail['default_project_match']['id'] == detail['selected_project_id'] == 2
    assert detail['authorization']['rules'][1] == {'rule': 'project_in_actor_grants', 'allowed': False}


def test_late_reply_after_control_change_does_not_create_draft(store):
    receipt = receive(store, message())
    class StalePeer(Peer):
        async def events(self):
            with store.begin() as session:
                task = session.get(db.Task, receipt['task_id'])
                task.control_version += 1
                task.status = 'paused'
            async for event in super().events():
                yield event
    asyncio.run(reply_worker.run_reply(Worker(), receipt['task_id'], client_factory=StalePeer))
    with store() as session:
        assert session.get(db.Task, receipt['task_id']).status == 'paused'
        assert session.scalars(select(ReplyDraft)).first() is None


def test_stale_reply_close_failure_protects_new_revision(store):
    receipt = receive(store, message())
    class UnstoppedPeer(Peer):
        async def events(self):
            with store.begin() as session:
                task = session.get(db.Task, receipt['task_id'])
                task.revision += 1
                task.control_version += 1
                task.status = 'queued'
                task.goal = '新目标'
            async for event in super().events():
                yield event
        async def close(self):
            raise RuntimeError('stop unconfirmed')
    asyncio.run(reply_worker.run_reply(Worker(), receipt['task_id'], client_factory=UnstoppedPeer))
    with store() as session:
        task = session.get(db.Task, receipt['task_id'])
        assert task.outcome_unknown and task.status == 'waiting_resource'
        assert task.goal == '新目标' and task.revision == 2
        assert session.scalars(select(ReplyDraft)).first() is None


def test_private_draft_requires_approval_and_preserves_receiver(store):
    receipt = receive(store, message())
    draft = create_draft(receipt['task_id'], receipt['id'], '经过审核的答复', session_factory=store)
    calls = []
    async def runner(argv):
        calls.append(argv)
        return {'deliveryStatus': 'sent', 'messageId': 'offline-sent-id'}
    client = DingTalkClient('offline-dws', profile='offline', runner=runner)
    settings = lambda key, default=None: {'dingtalk_response_policy': DEFAULT_POLICY | {'delivery': 'approved_send'}, 'connectors.dingtalk': {'enabled': True, 'profile': 'offline'}, 'external_delivery_enabled': True}.get(key, default)
    with pytest.raises(PermissionError):
        asyncio.run(publish_draft(draft['id'], session_factory=store, settings=settings, client=client))
    assert calls == []
    decide_draft(draft['id'], 'approve', draft['approval']['action_hash'], session_factory=store)
    result = asyncio.run(publish_draft(draft['id'], session_factory=store, settings=settings, client=client))
    assert result['write_status'] == 'succeeded'
    assert calls[0][calls[0].index('--open-dingtalk-id') + 1] == 'trusted'
    assert calls[0][calls[0].index('--group') + 1] == 'direct-chat'
    assert calls[0][calls[0].index('--message-id') + 1] == 'm1'
    asyncio.run(publish_draft(draft['id'], session_factory=store, settings=settings, client=client))
    assert len(calls) == 1
    quoted = message('quoted-answer', '补充一点')
    quoted['metadata']['reply_to_message_id'] = 'offline-sent-id'
    followup = receive(store, quoted)
    assert followup['task_id'] == receipt['task_id']


def test_draft_policy_blocks_even_an_approved_delivery(store):
    receipt = receive(store, message())
    draft = create_draft(receipt['task_id'], receipt['id'], '仅供审核', session_factory=store)
    decide_draft(draft['id'], 'approve', draft['approval']['action_hash'], session_factory=store)
    calls = []
    async def runner(argv):
        calls.append(argv)
        return {'deliveryStatus': 'sent'}
    settings = lambda key, default=None: {'dingtalk_response_policy': DEFAULT_POLICY, 'connectors.dingtalk': {'enabled': True, 'profile': 'offline'}, 'external_delivery_enabled': True}.get(key, default)
    with pytest.raises(PermissionError, match='仅生成草稿'):
        asyncio.run(publish_draft(draft['id'], session_factory=store, settings=settings, client=DingTalkClient('offline', profile='offline', runner=runner)))
    assert calls == []
    from superagent.core.delivery import PersistentActionLedger, DeliveryRecord
    ledger = PersistentActionLedger(store, settings)
    with pytest.raises(PermissionError, match='仅生成草稿'):
        asyncio.run(ledger.claim('reply-' + str(draft['approval_id']), draft['approval']['action_hash']))
    with store() as session:
        assert session.scalars(select(DeliveryRecord)).first() is None


def test_subscription_fanout_drafts_target_the_latest_source_message(store):
    from superagent.core.subscriptions import subscribe, EventTarget
    from superagent.core.governance import TaskOwner
    first = receive(store, message())
    asyncio.run(reply_worker.run_reply(Worker(), first['task_id'], client_factory=Peer))
    with store.begin() as session:
        second = db.Task(project_id=1, title='第二个回复', goal='回复', kind='reply', owner_id='member', status='review_ready')
        session.add(second)
        session.flush()
        session.add(TaskOwner(task_id=second.id, user_id='member'))
        second_id = second.id
        for task_id in (first['task_id'], second_id):
            subscribe(session, project_id=1, source='dingtalk', thread_id='direct-chat', task_id=task_id, actor=actor('dingtalk', 'trusted'), profile='offline')
    latest = receive(store, message('fanout-latest', '请再解释一下'))
    assert set(latest['data']['target_task_ids']) == {first['task_id'], second_id}
    for task_id in latest['data']['target_task_ids']:
        asyncio.run(reply_worker.run_reply(Worker(), task_id, client_factory=Peer))
    with store() as session:
        targets = session.scalars(select(EventTarget).where(EventTarget.event_id == latest['id'])).all()
        for target in targets:
            draft = session.scalars(select(ReplyDraft).where(ReplyDraft.task_id == target.task_id).order_by(ReplyDraft.id.desc())).first()
            assert draft.event_id == target.message_event_id
            assert session.get(db.Event, target.message_event_id).data['routing_status'] == 'delivered'
            assert session.get(db.Approval, draft.approval_id).action['target']['message_id'] == 'fanout-latest'
            assert session.get(db.Task, target.task_id).status == 'review_ready'


def test_reply_after_engine_restart_uses_real_protocol_and_normal_scheduler(tmp_path):
    import importlib.util
    import sys
    import types
    from pathlib import Path
    root = Path(__file__).resolve().parents[2]
    spec = importlib.util.spec_from_file_location('reply_blackbox_fixture', root / 'tests/e2e/test_blackbox.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    case = module.BlackBoxAcceptance(methodName='test_full_delivery_and_persistence')
    fake = tmp_path / 'reply_peer.py'
    fake.write_text('''import json,sys
sys.stdin.reconfigure(encoding='utf-8')
sys.stdout.reconfigure(encoding='utf-8')
def send(message):
    print(json.dumps(message),flush=True)
for line in sys.stdin:
    message=json.loads(line)
    method=message.get('method')
    if 'id' not in message:
        continue
    params=message.get('params',{})
    if method in ('thread/start','thread/resume'):
        if params.get('sandbox')!='read-only' or params.get('dynamicTools'):
            send({'id':message['id'],'error':{'message':'tool-less reply required'}})
            continue
        send({'id':message['id'],'result':{'thread':{'id':'persistent-reply-thread'}}})
    elif method=='turn/start':
        send({'id':message['id'],'result':{'turn':{'id':'reply-turn'}}})
        send({'method':'item/completed','params':{'threadId':'persistent-reply-thread','turnId':'reply-turn','item':{'id':'response','type':'agentMessage','text':'你好，已收到你的私聊。'}}})
        send({'method':'turn/completed','params':{'threadId':'persistent-reply-thread','turn':{'id':'reply-turn','status':'completed'}}})
    else:
        send({'id':message['id'],'result':{}})
''', encoding='utf-8')
    original = case.start
    def start(self):
        self.environment['SUPERAGENT_CODEX_EXECUTABLE'] = json.dumps([sys.executable, str(fake)])
        self.environment['SUPERAGENT_CODEX_HOME'] = str(self.root / 'codex-home')
        self.environment['SUPERAGENT_REPLY_ROOT'] = str(self.root / 'replies')
        return original()
    case.start = types.MethodType(start, case)
    try:
        case.setUp()
        case.request('PATCH', '/api/v1/settings', {'connectors.dingtalk': {'enabled': False, 'profile': 'offline'}})
        case.request('POST', '/api/v1/identities', {'source': 'dingtalk', 'actor_id': 'trusted', 'user_id': 'admin', 'project_ids': [case.project['id']], 'permissions': ['request']})
        first = case.request('POST', '/api/v1/events', message('real-first', conversation='offline-chat'))
        ready = case.wait_status({'id': first['task_id']}, {'review_ready'})
        assert ready['task']['kind'] == 'reply'
        assert ready['task']['workspace_path'] is None
        assert any(item['kind'] == 'summary' and '已收到' in item['content'] for item in ready['artifacts'])
        drafts = case.request('GET', f"/api/v1/tasks/{first['task_id']}/deliveries")
        assert drafts and drafts[0]['content'] == '你好，已收到你的私聊。'
        case.stop()
        case.start()
        next_message = case.request('POST', '/api/v1/events', message('real-second', '继续聊聊', conversation='offline-chat'))
        assert next_message['task_id'] == first['task_id']
        resumed = case.wait_status({'id': first['task_id']}, {'review_ready'})
        assert resumed['task']['codex_thread_id'] == 'persistent-reply-thread'
        assert len(case.request('GET', f"/api/v1/tasks/{first['task_id']}/deliveries")) == 2
    finally:
        case.doCleanups()


def test_project_progress_question_uses_analysis(store):
    result = receive(store, message(content='德阳的分科数据排序做好没'))
    assert result['data']['routing_status'] == 'routed'
    with store() as session:
        task = session.get(db.Task, result['task_id'])
        assert task.kind == 'analysis'


def test_progress_question_stays_analysis_after_model_reply_decision(store):
    from superagent.core.semantic_routing import SemanticRoutingService
    with store.begin() as session:
        session.add(Setting(key='semantic_routing_enabled', value=True))
    result = receive(store, message(content='德阳的分科数据排序做好没'))
    assert result['data']['routing_status'] == 'semantic_pending'
    async def model(context):
        return {'action': 'create', 'kind': 'reply', 'task_id': None, 'state_version': None, 'reason': '回复进展'}
    service = SemanticRoutingService(session_factory=store, actor_resolver=actor, model_runner=model)
    asyncio.run(service.run_once())
    with store() as session:
        event = session.get(db.Event, result['id'])
        assert event.data['routing_status'] == 'routed'
        assert session.get(db.Task, event.task_id).kind == 'analysis'


def test_ordinary_private_question_stays_reply(store):
    result = receive(store, message(content='你能做什么？'))
    with store() as session:
        assert session.get(db.Task, result['task_id']).kind == 'reply'


def test_account_message_is_context_and_suppresses_auto_reply(store):
    from superagent.core.delivery import deliver_automatically, reply_source_allowed
    from superagent.core.event_groups import actionable, group_events
    receipt = receive(store, message(content='接口地址不存在问题是修好了是么'))
    own = normalize_event({
        'type': 'user_im_message_receive_o2o_all', 'conversation_id': 'direct-chat',
        'message_id': 'mine', 'sender_open_dingtalk_id': 'self', 'sender': '本人',
        'content': '已核对测试环境', 'event_time': '2026-11-14T01:07:00Z',
    }, profile='offline', self_ids=['self'])
    followup = receive(store, own)
    assert followup['task_id'] == receipt['task_id']
    assert receive(store, own)['duplicate']
    with store.begin() as session:
        task = session.get(db.Task, receipt['task_id'])
        assert task.kind == 'analysis' and task.revision == 1
        assert session.scalars(select(db.Task.id)).all() == [task.id]
        event = group_events(session, task.id)[-1]
        assert not actionable(event) and not reply_source_allowed(session, event, task.id)
        task.status = 'review_ready'
        session.add(db.Artifact(task_id=task.id, revision=task.revision, kind='summary', content='候选答复'))
    settings = lambda key, default=None: {
        'external_delivery_enabled': True,
        'dingtalk_response_policy': DEFAULT_POLICY | {'delivery': 'auto_send'},
        'connectors.dingtalk': {'enabled': True, 'profile': 'offline'},
    }.get(key, default)
    asyncio.run(deliver_automatically(session_factory=store, settings=settings))
    with store() as session:
        assert session.scalars(select(ReplyDraft)).first() is None


def test_private_history_requires_matching_anchor_and_imports_only_own_messages():
    from datetime import datetime, timedelta, timezone
    from superagent.connectors.common import ConnectorError
    from superagent.connectors.history import read_own_direct_messages
    now = datetime.now(timezone.utc)
    start = (now - timedelta(minutes=5)).isoformat()
    conversation = 'bound-chat'
    items = [
        {'messageId': 'anchor', 'senderId': 'peer', 'conversationId': conversation},
        {'messageId': 'own', 'senderId': 'legacy-self', 'text': '补充已经核对',
         'createTime': (now - timedelta(minutes=3)).isoformat(), 'conversationId': conversation},
        {'messageId': 'other', 'senderId': 'peer', 'text': '另一条消息', 'conversationId': conversation},
    ]
    async def runner(argv, *, timeout):
        assert argv[argv.index('--open-dingtalk-id') + 1] == 'peer'
        return {'data': {'messages': items, 'complete': True, 'hasMore': False}}
    opts = dict(profile='offline', peer='peer', conversation=conversation, since=start,
                self_ids={'self'}, history_timezone=timezone.utc, sender_map={'legacy-self': 'self'}, runner=runner)
    result = asyncio.run(read_own_direct_messages('fake', anchor_id='anchor', **opts))
    assert [(row['message_id'], row['sender_open_dingtalk_id']) for row in result] == [('own', 'self')]
    with pytest.raises(ConnectorError, match='scope_not_confirmed'):
        asyncio.run(read_own_direct_messages('fake', anchor_id='not-in-reader', **opts))


def test_recent_work_cannot_cross_private_chat_with_shared_platform_owner(store):
    from superagent.core.message_context import recent_work
    with store.begin() as session:
        session.get(db.Project, 1).dingtalk_chat_ids = ['direct-chat', 'another-chat']
    current = receive(store, message('current', '检查当前数据进展'))
    related = receive(store, message('related', '修好了吗'))
    unrelated = receive(store, message('unrelated', '修好了吗', conversation='another-chat'))
    with store.begin() as session:
        for receipt, content in [(related, 'same conversation evidence'), (unrelated, 'other private chat')]:
            task = session.get(db.Task, receipt['task_id'])
            session.add(db.Artifact(task_id=task.id, revision=task.revision, kind='summary', content=content))
        session.flush()
        result = recent_work(session, session.get(db.Task, current['task_id']))
        assert [(row['task_id'], row['summary']) for row in result] == [(related['task_id'], 'same conversation evidence')]
