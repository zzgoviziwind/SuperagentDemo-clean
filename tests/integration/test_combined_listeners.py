import asyncio
import sys
from pathlib import Path

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from superagent.core.connections import ConnectionManager, CombinedDingTalkListener, dingtalk_scopes
from superagent.core.db import Base, Project


POLICY = {'direct_messages': 'reply', 'group_messages': 'requests',
          'delivery': 'draft', 'default_project_id': None}


@pytest.fixture
def setup(tmp_path):
    engine = create_engine('sqlite:///' + str(tmp_path / 'combined.db'), connect_args={'check_same_thread': False})
    Base.metadata.create_all(engine)
    factory = sessionmaker(engine, expire_on_commit=False)
    with factory.begin() as session:
        session.add(Project(name='示例', repo_path=str(tmp_path), dingtalk_chat_ids=['group-chat']))
    config = {'enabled': True, 'executable': [sys.executable, str(Path(__file__).with_name('fake_combined_dws.py'))],
              'profile': 'offline', 'self_ids': ['self'], 'kind': 'at-me'}
    values = {'connectors.dingtalk': config, 'dingtalk_response_policy': dict(POLICY)}
    yield factory, values, lambda key, default=None: values.get(key, default)
    engine.dispose()


def test_scope_plan_preserves_legacy_and_selects_actual_dm_group_ranges():
    assert dingtalk_scopes({'kind': 'at-me'}, None) == [{'kind': 'at-me', 'chat_id': None}]
    assert [item['kind'] for item in dingtalk_scopes({'kind': 'at-me'}, POLICY)] == ['all-direct', 'all-group']
    assert dingtalk_scopes({'kind': 'group', 'chat_id': 'bound'}, POLICY)[1] == {'kind': 'group', 'chat_id': 'bound'}
    assert [item['kind'] for item in dingtalk_scopes({}, POLICY | {'group_messages': 'mentions'})] == ['all-direct', 'at-me']
    assert dingtalk_scopes({}, POLICY | {'group_messages': 'off', 'direct_messages': 'off'}) == []


def test_explicit_multiple_groups_and_all_groups_override_legacy_scope():
    config = {'kind': 'group', 'chat_id': 'old'}
    policy = POLICY | {'group_scope': 'selected', 'group_chat_ids': ['one', 'two']}
    assert dingtalk_scopes(config, policy) == [
        {'kind': 'all-direct', 'chat_id': None},
        {'kind': 'group', 'chat_id': 'one'}, {'kind': 'group', 'chat_id': 'two'}]
    assert dingtalk_scopes(config, policy | {'group_scope': 'all', 'group_chat_ids': []})[-1] == {
        'kind': 'all-group', 'chat_id': None}
    assert dingtalk_scopes(config, policy | {'group_scope': 'all'})[-1]['kind'] == 'all-group'
    assert dingtalk_scopes(config, POLICY | {'group_messages': 'off', 'group_scope': 'selected', 'group_chat_ids': []}) == [
        {'kind': 'all-direct', 'chat_id': None}]


@pytest.mark.parametrize('scope', [
    {'group_scope': 'selected', 'group_chat_ids': ['one', 'one']},
    {'group_scope': 'unknown', 'group_chat_ids': ['one']},
    {'group_scope': 'selected', 'group_chat_ids': [1]},
])
def test_invalid_explicit_group_scope_is_rejected(scope):
    from superagent.core.message_policy import validate_policy
    with pytest.raises(ValueError):
        validate_policy(POLICY | scope)


def test_real_fake_processes_both_scopes_and_stopped_processes(setup):
    factory, values, settings = setup
    async def run():
        events = []
        async def emit(event):
            events.append(event)
        manager = ConnectionManager(settings=settings, session_factory=factory, emit=emit)
        try:
            await manager.start('dingtalk')
            for _ in range(100):
                if len(events) == 2:
                    break
                await asyncio.sleep(.01)
            assert {event['metadata']['conversation_type'] for event in events} == {'direct', 'group'}
            status = manager.statuses()[0]
            assert status['status'] == 'running'
            assert manager.instances['dingtalk'].health()['status'] == 'running'
            assert {row['kind'] for row in status['scopes']} == {'all-direct', 'all-group'}
            assert all(row['status'] == 'running' for row in status['scopes'])
            listeners = list(manager.instances['dingtalk'].listeners)
            assert next(listener for scope, listener in listeners if scope['kind'] == 'all-direct').state is None
            assert all(listener.replay is None for _, listener in listeners)
        finally:
            await manager.stop()
        assert all(listener._process.returncode is not None for _, listener in listeners)
    asyncio.run(run())


def test_partial_start_failure_keeps_working_scope_visible(setup):
    factory, values, settings = setup
    values['connectors.dingtalk']['executable'] += ['--fail-kind', 'all-group']
    async def emit(event):
        pass
    async def run():
        manager = ConnectionManager(settings=settings, session_factory=factory, emit=emit)
        try:
            await manager.start('dingtalk')
            status = manager.statuses()[0]
            assert status['status'] == 'degraded'
            scopes = {row['kind']: row for row in status['scopes']}
            assert scopes['all-direct']['status'] == 'running'
            assert scopes['all-group']['status'] == 'failed'
            assert scopes['all-group']['last_error']
        finally:
            await manager.stop()
    asyncio.run(run())


def test_reconcile_restarts_changed_scopes_and_leaves_disabled_unstarted(setup):
    factory, values, settings = setup
    async def emit(event):
        pass
    async def run():
        manager = ConnectionManager(settings=settings, session_factory=factory, emit=emit)
        try:
            await manager.reconcile()
            assert not manager.instances
            await manager.start('dingtalk')
            previous = manager.instances['dingtalk']
            old_processes = [listener._process for _, listener in previous.listeners]
            values['dingtalk_response_policy'] = POLICY | {'group_messages': 'mentions'}
            await manager.reconcile()
            assert all(process.returncode is not None for process in old_processes)
            assert manager.instances['dingtalk'] is not previous
            assert {scope['kind'] for scope in manager.statuses()[0]['scopes']} == {'all-direct', 'at-me'}
            values['connectors.dingtalk'] = values['connectors.dingtalk'] | {'enabled': False}
            await manager.reconcile()
            assert not manager.instances
            assert manager.statuses()[0]['status'] == 'disabled'
        finally:
            await manager.stop()
    asyncio.run(run())


def test_history_replay_is_assigned_only_to_bound_group_stream(setup):
    factory, values, settings = setup
    values['connectors.dingtalk']['history'] = {
        'chat_ids': ['group-chat'], 'initial_since': '2026-11-14T00:00:00Z', 'history_timezone': 'UTC'}
    created = []
    class Listener:
        def __init__(self, executable, emit, **kwargs):
            self.__dict__.update(kwargs)
            self.key = self.kind
            self.status = 'stopped'
            created.append(self)
        async def start(self):
            self.status = 'running'
        async def stop(self):
            self.status = 'stopped'
    async def run():
        manager = ConnectionManager(settings=settings, session_factory=factory, listener_factory=Listener)
        await manager.start('dingtalk')
        try:
            dm, group = created
            assert dm.kind == 'all-direct' and dm.replay is None and dm.state_store is None
            assert group.kind == 'all-group' and group.replay.kind == 'group'
            assert group.replay.chat_ids == ('group-chat',)
            assert [row['history_recovery'] for row in manager.statuses()[0]['scopes']] == [False, True]
        finally:
            await manager.stop()
    asyncio.run(run())


def test_live_scope_failure_becomes_degraded_and_failed_stop_retains_ownership():
    class Listener:
        status = 'running'
        last_error = None
        fail_stop = False
        async def start(self):
            self.status = 'running'
        async def stop(self):
            if self.fail_stop:
                self.status = 'stop_failed'
                raise RuntimeError('offline stop failure')
            self.status = 'stopped'
    async def run():
        dm, group = Listener(), Listener()
        combined = CombinedDingTalkListener([({'kind': 'all-direct'}, dm), ({'kind': 'all-group'}, group)])
        group.status, group.last_error = 'failed', 'dws_disconnected_replay_required'
        assert combined.status == 'degraded'
        group.fail_stop = True
        with pytest.raises(RuntimeError):
            await combined.stop()
        assert dm.status == 'stopped'
        assert combined.status == 'stop_failed'
        with pytest.raises(RuntimeError):
            await combined.start()
        group.fail_stop = False
        await combined.stop()
        assert combined.status == 'stopped'
    asyncio.run(run())


def test_legacy_manager_starts_exactly_one_listener(setup):
    factory, values, settings = setup
    values.pop('dingtalk_response_policy')
    calls = []
    class Listener:
        def __init__(self, executable, emit, **kwargs):
            self.__dict__.update(kwargs)
            self.status = 'stopped'
        async def start(self):
            calls.append(('start', self.kind))
            self.status = 'running'
        async def stop(self):
            calls.append(('stop', self.kind))
            self.status = 'stopped'
    async def run():
        manager = ConnectionManager(settings=settings, session_factory=factory, listener_factory=Listener)
        await manager.start('dingtalk')
        await manager.start('dingtalk')
        await manager.stop()
        assert calls == [('start', 'at-me'), ('stop', 'at-me')]
    asyncio.run(run())


def test_reconcile_stop_failure_returns_diagnostic_without_starting_replacement(setup):
    factory, values, settings = setup
    created = []
    class Listener:
        fail_stop = False
        def __init__(self, executable, emit, **kwargs):
            self.__dict__.update(kwargs)
            self.status = 'stopped'
            created.append(self)
        async def start(self):
            self.status = 'running'
        async def stop(self):
            if self.fail_stop:
                raise RuntimeError('offline fixture')
            self.status = 'stopped'
    async def run():
        manager = ConnectionManager(settings=settings, session_factory=factory, listener_factory=Listener)
        await manager.start('dingtalk')
        previous = manager.instances['dingtalk']
        created[1].fail_stop = True
        values['dingtalk_response_policy'] = POLICY | {'group_messages': 'mentions'}
        result = await manager.reconcile()
        assert manager.instances['dingtalk'] is previous
        assert len(created) == 2
        assert result[0]['status'] == 'failed'
        assert result[0]['last_error']
        created[1].fail_stop = False
        await manager.reconcile()
        assert manager.instances['dingtalk'] is not previous
        assert len(created) == 4
        await manager.stop()
    asyncio.run(run())


def test_saved_both_off_policy_has_no_processes(setup):
    factory, values, settings = setup
    values['dingtalk_response_policy'] = POLICY | {'direct_messages': 'off', 'group_messages': 'off'}
    async def run():
        manager = ConnectionManager(settings=settings, session_factory=factory)
        await manager.start('dingtalk')
        assert manager.statuses()[0]['status'] == 'policy_off'
        assert manager.statuses()[0]['scopes'] == []
        await manager.stop()
    asyncio.run(run())


def test_inactive_history_project_does_not_block_live_scopes(setup):
    factory, values, settings = setup
    values['connectors.dingtalk']['history'] = {
        'chat_ids': ['group-chat'], 'initial_since': '2026-11-14T00:00:00Z', 'history_timezone': 'UTC'}
    with factory.begin() as session:
        session.query(Project).update({'enabled': False})
    async def emit(event):
        pass
    async def run():
        manager = ConnectionManager(settings=settings, session_factory=factory, emit=emit)
        try:
            await manager.start('dingtalk')
            status = manager.statuses()[0]
            assert status['status'] == 'running'
            assert status['warnings']
            assert all(not row['history_recovery'] for row in status['scopes'])
        finally:
            await manager.stop()
    asyncio.run(run())


def test_legacy_failed_listener_can_be_started_again(setup):
    factory, values, settings = setup
    values.pop('dingtalk_response_policy')
    async def emit(event):
        pass
    async def run():
        manager = ConnectionManager(settings=settings, session_factory=factory, emit=emit)
        try:
            await manager.start('dingtalk')
            previous = manager.instances['dingtalk']
            await previous.stop()
            previous.status = 'failed'
            await manager.start('dingtalk')
            assert manager.instances['dingtalk'] is not previous
            assert manager.statuses()[0]['status'] == 'running'
        finally:
            await manager.stop()
    asyncio.run(run())


def test_all_configured_groups_can_be_switched_off_and_restored():
    from superagent.core.message_policy import validate_policy, policy_allows
    policy = validate_policy(POLICY | {'group_scope': 'selected', 'group_chat_ids': [],
                                      'group_names': {'one': '医院项目群'}})
    assert dingtalk_scopes({}, policy) == [{'kind': 'all-direct', 'chat_id': None}]
    assert policy_allows(policy, {'dws_event_type': 'user_im_message_receive_group'}, 'one') is False
    restored = validate_policy(policy | {'group_chat_ids': ['one']})
    assert restored['group_names']['one'] == '医院项目群'
    assert policy_allows(restored, {'dws_event_type': 'user_im_message_receive_group'}, 'one') is True


def test_original_names_and_remarks_can_be_saved_and_deleted_independently():
    from superagent.core.message_policy import validate_policy
    policy = validate_policy(POLICY | {'group_scope': 'selected', 'group_chat_ids': ['one'],
                                      'group_names': {'one': '医院群备注'},
                                      'group_original_names': {'one': '钉钉群原名'}})
    assert policy['group_names']['one'] == '医院群备注'
    assert policy['group_original_names']['one'] == '钉钉群原名'
    deleted = validate_policy(policy | {'group_chat_ids': [], 'group_names': {}, 'group_original_names': {}})
    assert dingtalk_scopes({}, deleted) == [{'kind': 'all-direct', 'chat_id': None}]
    with pytest.raises(ValueError, match='群名称配置无效'):
        validate_policy(policy | {'group_original_names': {'one': 123}})
