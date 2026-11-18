"""WP3 verification with disposable SQLite, fake runners and no external sends."""

import asyncio
import subprocess
import sys
import time
from pathlib import Path
from unittest.mock import AsyncMock

import httpx
import pytest
from sqlalchemy import select
from sqlalchemy.schema import CreateTable

import superagent.main as main
from superagent.connectors import dingtalk
from superagent.connectors.common import digest
from superagent.core import db, delivery, execution, reply_worker
from superagent.core.message_policy import DEFAULT_POLICY
from superagent.core.subscriptions import EventTarget
from test_execution_ownership import rows, seed, setup, until


def config(key, default=None):
    return {'external_delivery_enabled': True,
            'dingtalk_response_policy': DEFAULT_POLICY | {'delivery': 'auto_send'},
            'connectors.dingtalk': {'enabled': True, 'profile': 'offline'}}.get(key, default)


def seed_draft(sessions, *, task_id=2, automatic=False):
    with sessions.begin() as session:
        task = db.Task(id=task_id, project_id=1, title='offline', goal='offline', kind='reply', status='review_ready')
        source = db.Event(task_id=task_id, source='dingtalk', external_id='fake-incoming', event_type='message.received',
                          content='hello', data={'routing_status': 'routed', 'thread_id': 'fake-thread',
                                                 'metadata': {'profile': 'offline', 'message_id': 'fake-source'}})
        session.add_all([task, source])
        session.flush()
        draft = delivery.create_draft(task_id, source.id, 'offline reply', settings=config, db_session=session)
        if automatic:
            session.add(db.Event(task_id=task_id, source='runtime', event_type='reply_decision', data={
                'decision': 'send', 'draft_id': draft['id'], 'source_event_id': source.id,
                'revision': task.revision, 'control_version': task.control_version, 'guidance_hash': digest(''),
            }))
    approval = draft['approval']
    if not automatic:
        delivery.decide_draft(draft['id'], 'approve', approval['action_hash'], session_factory=sessions)
    return draft['id'], f'reply-{approval["id"]}', approval['action_hash']


def write_status(sessions, action_id):
    with sessions() as session:
        row = session.get(delivery.DeliveryRecord, action_id)
        return row and row.result['write_status']


def fake_client(runner):
    return dingtalk.DingTalkClient('offline', profile='offline', runner=runner)


def test_slow_delivery_does_not_block_scheduler_started_by_lifespan(tmp_path, monkeypatch):
    engine, sessions, _fake = setup(tmp_path, monkeypatch)
    db.init_db()
    seed(sessions)
    with sessions.begin() as session:
        session.get(db.Task, 1).status = 'paused'
    draft_id, action_id, _action_hash = seed_draft(sessions, automatic=True)
    monkeypatch.setenv('SUPERAGENT_DELIVERY_MODE', 'worker')
    monkeypatch.setenv('SUPERAGENT_LEDGER_MODE', 'v2')
    monkeypatch.setenv('SUPERAGENT_CONTEXT_MODE', 'decisions')
    monkeypatch.setattr(delivery, 'get_config', config)

    async def scenario():
        started = asyncio.Event()
        requests = []

        async def slow_runner(argv):
            assert write_status(sessions, action_id) == 'dispatching'
            requests.append(argv)
            started.set()
            await asyncio.sleep(2)
            return {'deliveryStatus': 'sent', 'messageId': 'offline-receipt'}

        client = fake_client(slow_runner)
        monkeypatch.setattr(dingtalk, 'DingTalkClient', lambda *_args, **_options: client)
        async with main.lifespan(main.app):
            await asyncio.wait_for(started.wait(), 4)
            before = time.monotonic()
            with sessions.begin() as session:
                execution.advance_task(session, session.get(db.Task, 1), status='queued')
            await until(lambda: rows(sessions)[0].status == 'review_ready')
            assert time.monotonic() - before < 1.2
            assert write_status(sessions, action_id) == 'dispatching'
            with sessions() as session:
                manifest = session.scalar(select(db.ContextManifest).where(db.ContextManifest.task_id == 1))
                assert manifest.attempt_id and manifest.turn_id == 'turn'
            duplicate = await delivery.publish_draft(draft_id, session_factory=sessions, settings=config, client=client)
            assert duplicate['write_status'] == 'dispatching'
            await until(lambda: write_status(sessions, action_id) == 'succeeded')
            assert len(requests) == 1

    asyncio.run(scenario())
    engine.dispose()


def ledger_child(root, action_id, action_hash, phase):
    with pytest.MonkeyPatch.context() as patch:
        patch.setenv('SUPERAGENT_LEDGER_MODE', 'v2')
        _engine, sessions, _fake = setup(root, patch)
        ledger = delivery.PersistentActionLedger(sessions, config)

        async def at_boundary():
            assert await ledger.claim(action_id, action_hash)
            if phase == 'dispatching':
                assert await ledger.mark_dispatching(action_id)
                (root / 'fake_send').write_text('1', encoding='utf-8')

        asyncio.run(at_boundary())
        (root / 'ledger_ready').touch()
        while True:
            time.sleep(0.02)


@pytest.mark.parametrize('phase', ['claimed', 'dispatching'])
def test_process_kill_retries_only_pre_dispatch_claim(tmp_path, monkeypatch, phase):
    engine, sessions, _fake = setup(tmp_path, monkeypatch)
    db.init_db()
    seed(sessions)
    draft_id, action_id, action_hash = seed_draft(sessions)
    monkeypatch.setenv('SUPERAGENT_LEDGER_MODE', 'v2')
    code = ('import runpy,sys; from pathlib import Path; sys.path.insert(0, str(Path(sys.argv[1]).parent)); '
            'runpy.run_path(sys.argv[1])["ledger_child"](Path(sys.argv[2]), *sys.argv[3:])')
    process = subprocess.Popen([sys.executable, '-c', code, __file__, str(tmp_path), action_id, action_hash, phase],
                               stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    try:
        until_time = time.monotonic() + 15
        while not (tmp_path / 'ledger_ready').exists() and process.poll() is None and time.monotonic() < until_time:
            time.sleep(0.02)
    finally:
        if process.poll() is None:
            process.kill()
        output, _ = process.communicate(timeout=5)
    assert (tmp_path / 'ledger_ready').exists(), output.decode(errors='replace')
    assert write_status(sessions, action_id) == phase
    if phase == 'claimed':
        with sessions.begin() as session:
            row = session.get(delivery.DeliveryRecord, action_id)
            row.result = {**row.result, 'claimed_at': delivery._cutoff(delivery.CLAIM_MAX_AGE + 1)}

    requests = []

    async def runner(argv):
        requests.append(argv)
        return {'deliveryStatus': 'sent', 'messageId': 'offline'}

    async def restart():
        monkeypatch.setattr(main.scheduler, 'start', AsyncMock())
        async with main.lifespan(main.app):
            assert write_status(sessions, action_id) == ('failed' if phase == 'claimed' else 'unknown')
            settings = {'session_factory': sessions, 'settings': config, 'client': fake_client(runner)}
            result = await delivery.publish_draft(draft_id, **settings)
            assert result['write_status'] == ('succeeded' if phase == 'claimed' else 'unknown')
            assert await delivery.publish_draft(draft_id, **settings) == result

    asyncio.run(restart())
    assert len(requests) + int((tmp_path / 'fake_send').exists()) == 1
    engine.dispose()


def test_reclaimed_token_and_legacy_unknown_cannot_send(tmp_path, monkeypatch):
    engine, sessions, _fake = setup(tmp_path, monkeypatch)
    db.init_db()
    seed(sessions)
    draft_id, action_id, action_hash = seed_draft(sessions)

    async def scenario():
        monkeypatch.setenv('SUPERAGENT_LEDGER_MODE', 'v2')
        old = delivery.PersistentActionLedger(sessions, config)
        assert await old.claim(action_id, action_hash)
        with sessions.begin() as session:
            row = session.get(delivery.DeliveryRecord, action_id)
            row.result = {**row.result, 'claimed_at': delivery._cutoff(delivery.CLAIM_MAX_AGE + 1)}
        replacement = delivery.PersistentActionLedger(sessions, config)
        assert await replacement.claim(action_id, action_hash)
        assert not await old.mark_dispatching(action_id)
        assert await replacement.mark_dispatching(action_id)
        delivery.recover_claimed(session_factory=sessions)
        assert write_status(sessions, action_id) == 'dispatching'  # Another controller may still own it.
        delivery.recover_claimed(session_factory=sessions, exclusive=True)
        assert write_status(sessions, action_id) == 'unknown'
        delivery.reconcile_delivery(draft_id, 'failed', 'fake evidence', session_factory=sessions)
        await replacement.finish(action_id, {'write_status': 'succeeded'})
        assert write_status(sessions, action_id) == 'failed'
        # Historical v1 unknown records survive the v2 switch and recovery.
        with sessions.begin() as session:
            row = session.get(delivery.DeliveryRecord, action_id)
            row.result = {'action_id': action_id, 'action_hash': action_hash, 'write_status': 'unknown',
                          'reason': 'claimed_outcome_pending_reconciliation'}
        delivery.recover_claimed(session_factory=sessions, exclusive=True)
        runner = AsyncMock(side_effect=AssertionError('unknown was resent'))
        result = await delivery.publish_draft(draft_id, session_factory=sessions, settings=config, client=fake_client(runner))
        assert result['write_status'] == 'unknown'
        runner.assert_not_called()

    asyncio.run(scenario())
    engine.dispose()


def test_revoked_authorization_and_cancellation_are_fenced(tmp_path, monkeypatch):
    engine, sessions, _fake = setup(tmp_path, monkeypatch)
    db.init_db()
    seed(sessions)
    draft_id, action_id, action_hash = seed_draft(sessions)
    monkeypatch.setenv('SUPERAGENT_LEDGER_MODE', 'v2')

    async def scenario():
        ledger = delivery.PersistentActionLedger(sessions, config)
        assert await ledger.claim(action_id, action_hash)
        with sessions.begin() as session:
            task = session.get(db.Task, 2)
            execution.advance_task(session, task, control_version=2)
        with pytest.raises(PermissionError, match='授权'):
            await ledger.mark_dispatching(action_id)
        assert write_status(sessions, action_id) == 'claimed'
        with sessions.begin() as session:
            task = session.get(db.Task, 2)
            execution.advance_task(session, task, control_version=1)
            row = session.get(delivery.DeliveryRecord, action_id)
            row.result = {**row.result, 'claimed_at': delivery._cutoff(delivery.CLAIM_MAX_AGE + 1)}
        entered = asyncio.Event()

        async def runner(_argv):
            entered.set()
            await asyncio.Future()

        settings = {'session_factory': sessions, 'settings': config, 'client': fake_client(runner)}
        task = asyncio.create_task(delivery.publish_draft(draft_id, **settings))
        await asyncio.wait_for(entered.wait(), 4)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert write_status(sessions, action_id) == 'unknown'
        assert (await delivery.publish_draft(draft_id, **settings))['write_status'] == 'unknown'

    asyncio.run(scenario())
    engine.dispose()


def test_approval_releases_slot_and_reacquires_before_sending(tmp_path, monkeypatch):
    engine, sessions, fake = setup(tmp_path, monkeypatch)
    db.init_db()
    seed(sessions)
    with sessions.begin() as session:
        session.add(db.Task(id=2, project_id=1, title='second', goal='second'))
    scheduler = main.scheduler
    original_events = fake.events

    async def scenario():
        second_started = asyncio.Event()
        finish_second = asyncio.Event()
        approval_sent = asyncio.Event()

        async def events(self):
            if Path(self.cwd).name.startswith('1-'):
                yield {'id': 1, 'method': 'item/commandExecution/requestApproval',
                       'params': {'threadId': 'thread', 'turnId': 'turn'}}
                await approval_sent.wait()
            else:
                second_started.set()
                await finish_second.wait()
            async for item in original_events(self):
                yield item

        async def decide(_self, _id, _decision):
            approval_sent.set()

        monkeypatch.setattr(fake, 'events', events)
        monkeypatch.setattr(fake, 'respond_approval', decide)
        scheduler.max_waiting_approval = 1
        await scheduler.start()
        try:
            await until(lambda: 1 in scheduler.waiting_approval)
            await asyncio.sleep(0.3)
            assert not second_started.is_set()
            scheduler.max_waiting_approval = 4
            await asyncio.wait_for(second_started.wait(), 4)
            assert scheduler.executing == {2} and scheduler.waiting_approval == {1}
            assert set(scheduler.active) == {1, 2}
            with sessions() as session:
                approval = session.scalar(select(db.Approval))
            uri = f'/api/v1/approvals/{approval.id}/decision'
            body = {'decision': 'reject', 'action_hash': approval.action_hash}
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url='http://testserver',
                                         headers={'Authorization': 'Bearer wp1-test-token'}) as client:
                refused = await client.post(uri, json=body)
                assert refused.status_code == 409 and not approval_sent.is_set()
                with sessions() as session:
                    assert session.get(db.Approval, approval.id).status == 'pending'
                finish_second.set()
                await until(lambda: 2 not in scheduler.active)
                accepted = await client.post(uri, json=body)
                assert accepted.status_code == 200, accepted.text
                await until(lambda: rows(sessions)[0].status == 'review_ready')
        finally:
            finish_second.set()
            approval_sent.set()
            await scheduler.close()

    asyncio.run(scenario())
    engine.dispose()


@pytest.mark.parametrize(('scenario', 'max_seconds', 'idle_seconds', 'expected_limit'), [
    ('duplicate', 2.25, 30, 2.25), ('silent', 2.25, 30, 2.25),
    ('idle_duplicate', 8, 1, 1), ('approval', 2.25, 1, 2.25),
    ('startup', 0.4, 30, 0.4), ('reply', 0.5, 30, 0.5),
])
def test_deadline_counts_silence_duplicates_and_approval_wait(tmp_path, monkeypatch, scenario,
                                                             max_seconds, idle_seconds, expected_limit):
    engine, sessions, fake = setup(tmp_path, monkeypatch)
    db.init_db()
    seed(sessions, kind='reply' if scenario == 'reply' else 'repair')
    monkeypatch.setenv('SUPERAGENT_MAX_RUN_SECONDS', str(max_seconds))
    monkeypatch.setenv('SUPERAGENT_RUN_IDLE_TIMEOUT_SECONDS', str(idle_seconds))

    async def late_start(_self):
        await asyncio.Future()

    async def events(_self):
        params = {'threadId': 'thread', 'turnId': 'turn'}
        if scenario in ('duplicate', 'idle_duplicate'):
            event = {'method': 'item/started', 'params': {**params, 'item': {
                'type': 'commandExecution', 'id': 'same', 'status': 'inProgress'}}}
            while True:
                yield event
                await asyncio.sleep(0.02)
        if scenario == 'approval':
            yield {'id': 1, 'method': 'item/commandExecution/requestApproval', 'params': params}
        await asyncio.Future()

    if scenario == 'startup':
        monkeypatch.setattr(fake, 'start', late_start)
    monkeypatch.setattr(fake, 'events', events)
    scheduler = main.scheduler
    attempt_id = execution.claim_task(1, scheduler.owner, sessions=sessions)
    before = time.monotonic()
    asyncio.run(scheduler.run(1, attempt_id))
    elapsed = time.monotonic() - before
    assert expected_limit - 0.1 <= elapsed < expected_limit + 0.65
    task, attempts = rows(sessions)
    if scenario == 'startup':
        assert not (tmp_path / 'side_effects').exists()
        assert (task.status, attempts[0].status, task.outcome_unknown) == ('failed', 'failed', False)
    else:
        assert (task.status, attempts[0].status, task.outcome_unknown) == ('waiting_resource', 'unknown', True)
    if scenario != 'idle_duplicate':
        assert '绝对期限' in task.last_error
    if scenario == 'approval':
        with sessions() as session:
            assert session.scalar(select(db.Approval)).status == 'expired'
    assert not scheduler.executing and not scheduler.waiting_approval
    engine.dispose()


def test_context_can_use_authorized_canonical_delivery_copy(tmp_path, monkeypatch):
    engine, sessions, _fake = setup(tmp_path, monkeypatch)
    db.init_db()
    seed(sessions)
    with sessions.begin() as session:
        origin = db.Event(source='dingtalk', external_id='offline', event_type='message.received',
                          data={'thread_id': 'fake-thread'})
        session.add(origin)
        session.flush()
        canonical = db.Event(task_id=1, source='dingtalk', event_type='message', content='offline source',
                             data={'source_event_id': origin.id, 'routing_status': 'delivered'})
        session.add(canonical)
        session.flush()
        session.add(EventTarget(event_id=origin.id, task_id=1, message_event_id=canonical.id))
        session.flush()
        assert reply_worker.reply_decision_context(session, 1, allowed_event_ids={origin.id})[0] == canonical.id
        assert reply_worker.reply_decision_context(session, 1, allowed_event_ids=set()) == (None, {})
    engine.dispose()


def test_v1_delivery_records_survive_additive_migration(tmp_path, monkeypatch):
    engine, sessions, _fake = setup(tmp_path, monkeypatch)
    ddl = str(CreateTable(delivery.DeliveryRecord.__table__).compile(dialect=engine.dialect))
    with engine.begin() as connection:
        connection.exec_driver_sql('\n'.join(line for line in ddl.splitlines()
                                             if not line.strip().startswith('claim_token ')))
        connection.exec_driver_sql("INSERT INTO delivery_records VALUES ('old', 'hash', "
                                   """'{"write_status":"unknown"}', 'old')""")
    db.init_db()
    db.init_db()
    with sessions() as session:
        row = session.get(delivery.DeliveryRecord, 'old')
        assert row.claim_token is None and row.result['write_status'] == 'unknown'
    engine.dispose()
