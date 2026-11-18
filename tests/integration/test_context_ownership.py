"""Offline WP2 coverage using the same isolated Worker fixture as WP1."""

import asyncio
import hashlib
import json
from unittest.mock import AsyncMock

import httpx
import pytest
from sqlalchemy import delete, inspect, select
from sqlalchemy.schema import CreateTable

import superagent.main as main
from superagent.core import context, db, execution, governance, scheduler as worker
from superagent.core.subscriptions import EventTarget
from test_execution_ownership import rows, seed, setup


@pytest.fixture
def state(tmp_path, monkeypatch):
    engine, sessions, fake = setup(tmp_path, monkeypatch)
    db.init_db()
    seed(sessions)
    monkeypatch.setenv('SUPERAGENT_CONTEXT_MODE', 'decisions')
    monkeypatch.setenv('SUPERAGENT_USERS_JSON', json.dumps([
        {'user_id': 'alice', 'role': 'member', 'token': 'wp2-alice'},
        {'user_id': 'bob', 'role': 'member', 'token': 'wp2-bob'},
        {'user_id': 'visitor', 'role': 'viewer', 'token': 'wp2-viewer'},
    ]))
    with sessions.begin() as session:
        session.get(db.Task, 1).owner_id = 'alice'
    yield sessions, fake
    engine.dispose()


def api(token='wp1-test-token'):
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url='http://testserver',
                             headers={'Authorization': f'Bearer {token}'})


async def create(client, *, content, project_id=1, task_id=1, event_id=None, kind='decision'):
    response = await client.post('/api/v1/decisions', json=dict(
        project_id=project_id, task_id=task_id, event_id=event_id, kind=kind, content=content))
    assert response.status_code == 201, response.text
    return response.json()


async def run_claimed(sessions):
    attempt_id = execution.claim_task(1, main.scheduler.owner, sessions=sessions)
    assert attempt_id
    await main.scheduler.run(1, attempt_id)
    return attempt_id


def test_earliest_decision_survives_timeline_limit_then_revokes(state, monkeypatch):
    sessions, fake = state
    with sessions.begin() as session:
        for index in range(1, 32):
            session.add(db.Event(id=index, task_id=1, source='web', event_type='message',
                                 content='x' * 3501 if index == 31 else f'历史消息 {index}'))
    calls = []
    decision_text = '早期范围约束必须生效'
    start_turn = fake.start_turn
    events = fake.events
    start_thread = AsyncMock(wraps=fake.start_thread)
    resume_thread = AsyncMock(side_effect=AssertionError('decisions mode must open a fresh thread'))
    # Preserve the protocol signatures relied on by the Worker.
    async def new_thread(self, cwd, *, instructions='', read_only=False, tool_less=False):
        return await start_thread(self, cwd, instructions=instructions, read_only=read_only, tool_less=tool_less)

    async def capture(self, thread_id, prompt, *, model=None, effort=None, **options):
        with sessions() as session:
            manifest = session.scalar(select(db.ContextManifest).order_by(db.ContextManifest.id.desc()).limit(1))
            attempt = session.get(db.ExecutionAttempt, manifest.attempt_id)
            assert (attempt.phase, attempt.manifest_id, manifest.turn_id) == ('turn', manifest.id, None)
            calls.append((manifest.id, prompt))
        return await start_turn(self, thread_id, prompt, model=model, effort=effort, **options)

    async def quoted_summary(self):
        async for event in events(self):
            item = event['params'].get('item', {})
            if len(calls) == 1 and item.get('type') == 'agentMessage':
                item['text'] = json.dumps({'status': 'completed', 'summary': decision_text}, ensure_ascii=False)
            yield event

    monkeypatch.setattr(fake, 'start_thread', new_thread)
    monkeypatch.setattr(fake, 'resume_thread', resume_thread)
    monkeypatch.setattr(fake, 'start_turn', capture)
    monkeypatch.setattr(fake, 'events', quoted_summary)

    async def scenario():
        async with api('wp2-alice') as client:
            first = await create(client, event_id=1, kind='constraint', content=decision_text)
            long = await create(client, content='补充' * 1200)
            attempt_id = await run_claimed(sessions)
            assert rows(sessions)[0].status == 'review_ready'
            response = await client.get(f'/api/v1/attempts/{attempt_id}/context')
            assert response.status_code == 200, response.text
            manifest = response.json()
            assert (manifest['id'], manifest['turn_id']) == (calls[0][0], 'turn')
            prompt = calls[0][1]
            assert f'"id": {first["id"]}, "kind": "constraint"' in prompt and first['content'] in prompt
            assert '历史消息 1"' not in prompt
            by_id = {(item['type'], item['id']): item for item in manifest['items']}
            assert sum(item['type'] == 'timeline' and item['included'] for item in manifest['items']) == 24
            assert sum(item['type'] == 'timeline' for item in manifest['items']) == 31
            assert not by_id['timeline', 1]['included'] and by_id['timeline', 1]['truncated']
            assert by_id['timeline', 31]['included'] and by_id['timeline', 31]['truncated']
            assert by_id['decision', long['id']]['included'] and by_id['decision', long['id']]['truncated']

            with sessions.begin() as session:
                peer = db.Task(project_id=1, title='other task', goal='isolated task', owner_id='alice')
                session.add(peer)
                session.flush()
                sections, items = context.assemble_worker_context(session, peer)
                assert not sections['recent_work']
                assert any(item['type'] == 'recent_work' and not item['included'] for item in items)

            response = await client.post(f'/api/v1/decisions/{first["id"]}/revoke', json={'reason': '本轮范围更新'})
            assert response.status_code == 200 and response.json()['status'] == 'revoked'
            with sessions.begin() as session:
                task = session.get(db.Task, 1)
                execution.advance_task(session, task, status='queued', revision=2, control_version=2)
            next_attempt = await run_claimed(sessions)
            assert rows(sessions)[0].status == 'review_ready'
            assert next_attempt != attempt_id and len(calls) == 2
            assert first['content'] not in calls[1][1]
            assert f'"id": {first["id"]}, "kind": "constraint"' not in calls[1][1]
            histories = (await client.get('/api/v1/tasks/1/context')).json()['items']
            assert len(histories) == 2 and histories[1] == manifest
            assert not any(item['type'] == 'decision' and item['id'] == first['id'] for item in histories[0]['items'])
            assert any(item['type'] == 'previous_summary' and not item['included'] for item in histories[0]['items'])
            start_thread.assert_awaited()
            assert start_thread.await_count == 2
            resume_thread.assert_not_awaited()
            with sessions() as session:
                trace = session.scalars(select(db.Event).where(db.Event.event_type == 'context_manifest_linked')).all()
                assert {row.data['manifest_id'] for row in trace} == {history['id'] for history in histories}
                audit = session.scalars(select(governance.Audit).where(governance.Audit.action.like('context.decision.%'))).all()
                assert {record.actor for record in audit} == {'alice'}
                assert len(audit) == 3

    asyncio.run(scenario())


def test_decision_source_project_owner_and_historical_manifest_permissions(state):
    sessions, _fake = state
    with sessions.begin() as session:
        session.add(db.Project(id=2, name='other', repo_path='unused'))
        session.add_all([
            db.Task(id=2, project_id=1, title='peer', goal='peer', owner_id='bob'),
            db.Task(id=3, project_id=2, title='other project', goal='other project', owner_id='alice'),
            db.Event(id=1, task_id=1, source='web', event_type='message', content='own evidence'),
            db.Event(id=2, task_id=2, source='web', event_type='message', content='different owner evidence'),
            db.Event(id=3, task_id=3, source='web', event_type='message', content='other project evidence'),
            EventTarget(event_id=2, task_id=1, message_event_id=2),
            EventTarget(event_id=3, task_id=1, message_event_id=3),
        ])

    async def scenario():
        async with api() as admin, api('wp2-alice') as alice, api('wp2-bob') as bob, api('wp2-viewer') as viewer:
            shared = await create(admin, task_id=None, content='explicit project-wide constraint')
            bound = await create(admin, task_id=None, event_id=1, content='limited to recipients who can see event')
            peer = await create(bob, task_id=2, event_id=2, content='Bob private decision')
            other = await create(alice, project_id=2, task_id=3, event_id=3, content='other project decision')
            payload = dict(project_id=1, task_id=1, kind='decision', content='unsupported citation')
            for event_id in (2, 3):
                response = await alice.post('/api/v1/decisions', json=payload | {'event_id': event_id})
                assert response.status_code == 404
            assert (await alice.post('/api/v1/decisions', json=payload | {'task_id': None})).status_code == 403
            assert (await alice.post('/api/v1/decisions', json=payload | {'project_id': 2})).status_code == 404
            assert (await alice.get('/api/v1/decisions?project_id=1')).status_code == 403
            assert (await alice.post(f'/api/v1/decisions/{peer["id"]}/revoke',
                                     json={'reason': 'unauthorized'})).status_code == 403
            assert (await viewer.get('/api/v1/tasks/1/decisions')).status_code == 403
            assert (await bob.get('/api/v1/tasks/1/decisions')).status_code == 403
            assert (await alice.get('/api/v1/decisions?project_id=2&task_id=1')).status_code == 404
            ids = {row['id'] for row in (await alice.get('/api/v1/tasks/1/decisions')).json()['items']}
            assert ids == {shared['id'], bound['id']}
            ids = {row['id'] for row in (await bob.get('/api/v1/tasks/2/decisions')).json()['items']}
            assert ids == {shared['id'], peer['id']}
            with sessions() as session:
                sections, _ = context.assemble_worker_context(session, session.get(db.Task, 1))
                assert {item['id'] for item in sections['decisions']} == {shared['id'], bound['id']}
                assert {item['event_id'] for item in sections['timeline']} == {1}
            attempt_id = await run_claimed(sessions)
            assert (await bob.get(f'/api/v1/attempts/{attempt_id}/context')).status_code == 403
            with sessions.begin() as session:
                task = session.get(db.Task, 1)
                execution.advance_task(session, task, project_id=2, revision=2, control_version=2)
                session.add(db.Event(task_id=1, source='web', event_type='project_rebound',
                                     content='rebound', data={'revision': 2}))
            assert (await alice.get(f'/api/v1/attempts/{attempt_id}/context')).status_code == 404
            assert (await admin.get(f'/api/v1/attempts/{attempt_id}/context')).status_code == 200
            with sessions() as session:
                sections, _ = context.assemble_worker_context(session, session.get(db.Task, 1))
                assert not sections['decisions']
                assert {item['content'] for item in sections['timeline']} == {'rebound'}
                assert sections['previous_summary'] == ''
                assert other['id'] not in {item['id'] for item in sections['decisions']}

    asyncio.run(scenario())


def test_budget_limits_serialized_context_and_redacts_new_decisions(state):
    sessions, _fake = state
    raw = 'api_key=synthetic-test-secret and Authorization: Bearer test-only-bearer'

    async def scenario():
        async with api('wp2-alice') as client:
            decision = await create(client, content=raw + '\n' + ('"\\\n文本' * 100))
            assert 'synthetic-test-secret' not in decision['content'] and 'test-only-bearer' not in decision['content']
            response = await client.post('/api/v1/decisions', json={
                'project_id': 1, 'task_id': 1, 'kind': 'note', 'content': 'x' * 10001})
            assert response.status_code == 422

    asyncio.run(scenario())
    with sessions() as session:
        sections, items = context.assemble_worker_context(session, session.get(db.Task, 1), budget_chars=350)
        assert sum(len(json.dumps(value, ensure_ascii=False)) for value in sections.values()) <= 350
        assert items[0]['included'] and items[0]['truncated']
        assert 'synthetic-test-secret' not in session.scalar(select(db.Decision)).content


@pytest.mark.parametrize('failure', ['write', 'missing_after_turn'])
def test_manifest_failure_never_allows_review_ready(state, tmp_path, monkeypatch, failure):
    sessions, _fake = state

    def fail(*_args):
        raise OSError('simulated manifest persistence failure')

    def lose(*_args, **_kwargs):
        with sessions.begin() as session:
            session.execute(delete(db.ContextManifest))

    if failure == 'write':
        monkeypatch.setattr(context, 'write_manifest', fail)
    else:
        monkeypatch.setattr(worker, 'validate_workspace_changes', lose)
    asyncio.run(run_claimed(sessions))
    task, attempts = rows(sessions)
    if failure == 'write':
        assert not (tmp_path / 'side_effects').exists()
        assert (task.status, attempts[0].status) == ('failed', 'failed')
    else:
        assert (tmp_path / 'side_effects').exists()
        assert (task.status, attempts[0].status, task.outcome_unknown) == ('waiting_resource', 'unknown', True)
    with sessions() as session:
        assert session.scalar(select(db.Artifact.id).where(db.Artifact.kind == 'verification')) is None


def test_legacy_execution_can_write_reply_manifest_with_null_attempt(state, monkeypatch):
    sessions, fake = state
    monkeypatch.setenv('SUPERAGENT_EXECUTION_MODE', 'legacy')
    with sessions.begin() as session:
        session.get(db.Task, 1).kind = 'reply'
    start_turn = fake.start_turn
    events = fake.events
    dispatched = []

    async def reply_events(self):
        async for event in events(self):
            if event['params'].get('item', {}).get('type') != 'commandExecution':
                yield event

    async def capture(self, thread_id, prompt, *, model=None, effort=None, **options):
        with sessions() as session:
            row = session.scalar(select(db.ContextManifest))
            assert row.attempt_id is None and row.turn_id is None
            dispatched.append(prompt)
        return await start_turn(self, thread_id, prompt, model=model, effort=effort, **options)

    monkeypatch.setattr(fake, 'events', reply_events)
    monkeypatch.setattr(fake, 'start_turn', capture)

    async def scenario():
        async with api('wp2-alice') as client:
            decision = await create(client, content='reply scope decision')
            await main.scheduler.run(1)
            assert len(dispatched) == 1 and decision['content'] in dispatched[0]
            assert rows(sessions)[0].status == 'review_ready'
            history = (await client.get('/api/v1/tasks/1/context')).json()['items']
            assert len(history) == 1 and history[0]['attempt_id'] is None and history[0]['turn_id'] == 'turn'

    asyncio.run(scenario())


def test_field_intake_keeps_attachment_query_and_suppresses_channel_draft(state, tmp_path, monkeypatch):
    sessions, fake = state
    attachment_root = tmp_path / 'attachments'
    attachment_root.mkdir()
    path = attachment_root / 'offline.txt'
    payload = b'synthetic field attachment'
    path.write_bytes(payload)
    monkeypatch.setenv('SUPERAGENT_ATTACHMENTS_ROOT', str(attachment_root))
    with sessions.begin() as session:
        task = session.get(db.Task, 1)
        task.revision = 2
        session.add(db.Event(task_id=1, source='field', external_id='offline-field', event_type='record',
                             content='field record'))
        session.add(db.Artifact(task_id=1, revision=1, kind='field_attachment', content=json.dumps({
            'local_path': str(path), 'size': len(payload), 'sha256': hashlib.sha256(payload).hexdigest(),
            'content_type': 'text/plain', 'filename': path.name,
        })))
    reply_context = AsyncMock(side_effect=AssertionError('Field Intake skips channel reply context'))
    monkeypatch.setattr('superagent.core.reply_worker.reply_decision_context', reply_context)
    start_turn = fake.start_turn
    prompts = []

    async def capture(self, thread_id, prompt, *, model=None, effort=None, **options):
        prompts.append(prompt)
        return await start_turn(self, thread_id, prompt, model=model, effort=effort, **options)

    monkeypatch.setattr(fake, 'start_turn', capture)
    asyncio.run(run_claimed(sessions))
    assert rows(sessions)[0].status == 'review_ready'
    assert len(prompts) == 1 and 'synthetic field attachment' in prompts[0] and 'channel_reply' not in prompts[0]
    reply_context.assert_not_called()


def test_wp1_database_migrates_additively(tmp_path, monkeypatch):
    engine, sessions, _fake = setup(tmp_path, monkeypatch)
    ddl = str(CreateTable(db.ExecutionAttempt.__table__).compile(dialect=engine.dialect))
    old_ddl = '\n'.join(line for line in ddl.splitlines() if not line.strip().startswith('manifest_id '))
    with engine.begin() as connection:
        connection.exec_driver_sql(old_ddl)
        connection.exec_driver_sql(
            "INSERT INTO execution_attempts (id, task_id, attempt_no, status, phase, owner, "
            "revision, control_version, updated_at) VALUES ('old', 1, 1, 'completed', 'done', 'worker', 1, 1, 'old')"
        )
    db.init_db()
    db.init_db()
    assert {'decisions', 'context_manifests'} <= set(inspect(engine).get_table_names())
    with sessions() as session:
        old = session.get(db.ExecutionAttempt, 'old')
        assert (old.status, old.manifest_id) == ('completed', None)
    engine.dispose()
