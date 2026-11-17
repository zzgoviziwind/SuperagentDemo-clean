import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from superagent.core.db import Base, Event, Project
from superagent.core import governance
from superagent.core.ingestion import ingest_event, retry_routing, list_inbox


def test_retry_preserves_attempts_and_denies_untrusted(tmp_path):
    engine = create_engine("sqlite:///" + str(tmp_path / "events.db"))
    Base.metadata.create_all(engine)
    sessions = sessionmaker(engine, expire_on_commit=False)
    with sessions.begin() as session:
        session.add(Project(name="p", repo_path=str(tmp_path), dingtalk_chat_ids=["chat"]))
    event = {"source":"dingtalk", "external_id":"m1", "event_type":"message.received", "actor_id":"x", "project_external_id":"chat", "thread_id":"chat", "content":"请分析", "metadata":{}, "_lifecycle":[{"attempt":999,"steps":[]}]}
    first = ingest_event(event, session_factory=sessions, actor_resolver=lambda *_: None)
    assert len(first["data"]["_lifecycle"]) == 1
    assert first["data"]["_lifecycle"][0]["attempt"] == 1
    assert first["data"]["routing_reason"] == "actor_unmapped_or_disabled"
    assert first["data"]["_lifecycle"][0]["steps"][1]["status"] == "blocked"
    assert first["data"]["_lifecycle"][0]["steps"][2]["status"] == "skipped"
    duplicate = ingest_event(event, session_factory=sessions, actor_resolver=lambda *_: None)
    assert duplicate["duplicate"] and len(duplicate["data"]["_lifecycle"]) == 1
    retry_routing(first["id"], session_factory=sessions, actor_resolver=lambda *_: None)
    with sessions() as session:
        stored = session.get(Event, first["id"])
        assert len(stored.data["_lifecycle"]) == 2
        assert stored.data["_lifecycle"][0]["steps"][1]["reason"] == "actor_unmapped_or_disabled"
        assert stored.data["_lifecycle"][1]["steps"][1]["status"] == "blocked"
        assert stored.task_id is None
    assert len(list_inbox(routing_status="all", session_factory=sessions)["items"]) == 1
    engine.dispose()


def test_followup_reference_still_checks_actor(tmp_path):
    engine = create_engine("sqlite:///" + str(tmp_path / "followup.db"))
    Base.metadata.create_all(engine)
    sessions = sessionmaker(engine, expire_on_commit=False)
    with sessions.begin() as session:
        session.add(Project(name="p", repo_path=str(tmp_path), dingtalk_chat_ids=["chat"]))
    actor = lambda source, ident: {"user_id":"u", "role":"admin", "project_ids":[1], "permissions":["request"]} if ident == "ok" else None
    base = {"source":"dingtalk", "event_type":"message.received", "project_external_id":"chat", "thread_id":"chat", "metadata":{}}
    first = ingest_event(base | {"external_id":"m1", "actor_id":"ok", "content":"请分析 #42"}, session_factory=sessions, actor_resolver=actor)
    first_steps = {step["stage"]: step for step in first["data"]["_lifecycle"][0]["steps"]}
    assert first_steps["subscription"]["reason"] == "no_existing_task"
    assert first_steps["router"]["reason"] == "created_task"
    plain = ingest_event(base | {"external_id":"plain", "actor_id":"ok", "content":"hello"}, session_factory=sessions, actor_resolver=actor)
    assert plain["data"]["routing_reason"] == "explicit_request_required"
    assert any(step["reason"] == "explicit_request_required" and step["status"] == "blocked" for step in plain["data"]["_lifecycle"][0]["steps"])
    follow = ingest_event(base | {"external_id":"m2", "actor_id":"ok", "content":"#42 这是补充"}, session_factory=sessions, actor_resolver=actor)
    denied = ingest_event(base | {"external_id":"m3", "actor_id":"bad", "content":"#42 这是补充"}, session_factory=sessions, actor_resolver=actor)
    assert follow["task_id"] == first["task_id"]
    steps = {step["stage"]: step for step in follow["data"]["_lifecycle"][0]["steps"]}
    assert steps["fast_filter"]["status"] == "passed"
    assert steps["subscription"]["detail"]["selected_task_id"] == first["task_id"]
    assert steps["router"]["reason"] == "reused_task"
    assert steps["slow_filter"]["status"] == "skipped"
    assert denied["task_id"] is None
    engine.dispose()


def test_trace_api_shows_task_evidence_separate_from_route_attempt(tmp_path, monkeypatch):
    import pytest
    from fastapi import HTTPException
    import superagent.api.lifecycle as lifecycle_api
    from superagent.core.db import Task, Artifact
    from superagent.core.delivery import ReplyDraft, DeliveryRecord

    engine = create_engine("sqlite:///" + str(tmp_path / "trace.db"))
    Base.metadata.create_all(engine)
    sessions = sessionmaker(engine, expire_on_commit=False)
    with sessions.begin() as session:
        task = Task(title="T", goal="goal", project_id=1, status="waiting_resource",
                    outcome_unknown=True, last_error="服务重启，运行结果未知，请人工对账",
                    codex_thread_id="thread-1", codex_turn_id="turn-1", workspace_path="workspace")
        session.add(task)
        session.flush()
        source = Event(task_id=task.id, source="dingtalk", external_id="external",
                       event_type="message.received", content="request", data={"_lifecycle": [{"attempt": 1, "steps": []}]})
        session.add(source)
        session.flush()
        source_id = source.id
        session.add_all([
            Event(task_id=task.id, source="runtime", event_type="run_started", data={"revision": 1}),
            Event(task_id=task.id, source="runtime", event_type="assistant_message", content="result", data={"artifact_id": 1}),
            Event(task_id=task.id, source="web", event_type="control", content="pause", data={}),
            Event(task_id=task.id, source="runtime", event_type="run_error", data={"type": "Error"}),
            Event(task_id=task.id, source="web", event_type="execution_reconciled", content="verified", data={"outcome": "stopped"}),
            Artifact(task_id=task.id, revision=1, kind="summary", content="report"),
            ReplyDraft(task_id=task.id, event_id=source_id, approval_id=9, content="reply"),
            DeliveryRecord(action_id="reply-9", action_hash="hash", result={"write_status": "unknown"}),
        ])
    monkeypatch.setattr(lifecycle_api, "Session", sessions)
    trace = lifecycle_api.trace(source_id)
    assert trace["attempts"] == [{"attempt": 1, "steps": []}]
    assert trace["execution"]["thread_id"] == "thread-1"
    assert trace["execution"]["turn_id"] == "turn-1"
    assert {item["event_type"] for item in trace["execution"]["events"]} == {"run_started", "assistant_message", "control", "run_error", "execution_reconciled"}
    assert trace["execution"]["artifacts"][0]["kind"] == "summary"
    assert trace["deliveries"][0]["record"]["result"]["write_status"] == "unknown"
    assert trace["live_stages"]["watchdog"]["outcome_unknown"] is True
    assert {item["event_type"] for item in trace["live_stages"]["watchdog"]["events"]} == {"run_error", "execution_reconciled"}
    with pytest.raises(HTTPException) as error:
        lifecycle_api.trace(99999)
    assert error.value.status_code == 404
    engine.dispose()


@pytest.mark.parametrize("terminal_status", ["completed", "cancelled"])
def test_terminal_followup_requires_explicit_new_request(tmp_path, terminal_status):
    from superagent.core.db import Task
    engine = create_engine("sqlite:///" + str(tmp_path / "terminal.db"))
    Base.metadata.create_all(engine)
    sessions = sessionmaker(engine, expire_on_commit=False)
    with sessions.begin() as session:
        session.add(Project(name="p", repo_path=str(tmp_path), dingtalk_chat_ids=["chat"]))
    actor = lambda *_: {"user_id":"u", "role":"admin", "project_ids":[1], "permissions":["request"]}
    base = {"source":"dingtalk", "event_type":"message.received", "actor_id":"ok", "project_external_id":"chat", "thread_id":"chat", "metadata":{}}
    first = ingest_event(base | {"external_id":"t1", "content":"请分析 #42"}, session_factory=sessions, actor_resolver=actor)
    with sessions.begin() as session:
        session.get(Task, first["task_id"]).status = terminal_status
    thanks = ingest_event(base | {"external_id":"t2", "content":"#42 谢谢"}, session_factory=sessions, actor_resolver=actor)
    assert thanks["task_id"] is None
    assert thanks["data"]["routing_reason"] == "explicit_request_required"
    with sessions() as session:
        assert len(session.scalars(select(Task)).all()) == 1
    follow = ingest_event(base | {"external_id":"t3", "content":"请继续分析 #42"}, session_factory=sessions, actor_resolver=actor)
    assert follow["task_id"] != first["task_id"]
    assert follow["data"]["related_task_id"] == first["task_id"]
    engine.dispose()


def test_architecture_and_subscription_views_show_real_receipt_counts(tmp_path, monkeypatch):
    import superagent.api.lifecycle as lifecycle_api
    from superagent.core.db import Task
    from superagent.core.ingestion import TaskRoute
    engine = create_engine("sqlite:///" + str(tmp_path / "views.db"))
    Base.metadata.create_all(engine)
    sessions = sessionmaker(engine, expire_on_commit=False)
    with sessions.begin() as session:
        session.add(Project(id=1, name="project", repo_path=str(tmp_path)))
        session.add(Task(id=1, title="task", goal="goal", project_id=1, status="queued"))
        session.add(TaskRoute(project_id=1, route_key="issue:42", task_id=1))
        session.add_all([Event(source="dingtalk", external_id="e1", event_type="message.received", data={}),
                         Event(source="runtime", event_type="run_started", task_id=1, data={})])
    monkeypatch.setattr(lifecycle_api, "Session", sessions)
    assert lifecycle_api.architecture()["counts"] == {"events": 1, "subscriptions": 1}
    item = lifecycle_api.subscriptions()["items"][0]
    assert (item["task_title"], item["task_status"], item["project_name"], item["reference_kind"]) == ("task", "queued", "project", "issue")
    engine.dispose()


def test_fanout_trace_includes_each_target_watchdog_and_execution(tmp_path, monkeypatch):
    import superagent.api.lifecycle as api
    from superagent.core.db import Task
    from superagent.core.subscriptions import EventTarget
    from superagent.core.watchdog import WatchdogRun
    engine = create_engine('sqlite:///' + str(tmp_path / 'fanout-trace.db'))
    Base.metadata.create_all(engine)
    sessions = sessionmaker(engine, expire_on_commit=False)
    with sessions.begin() as session:
        session.add(Event(id=1, source='dingtalk', external_id='m1', event_type='message.received',
                          data={'routing_status': 'routed', 'target_task_ids': [1, 2]}))
        for task_id, status in [(1, 'running'), (2, 'paused')]:
            session.add(Task(id=task_id, project_id=1, title='t', goal='g', status=status,
                             codex_thread_id=f'thread-{task_id}', codex_turn_id=f'turn-{task_id}'))
            session.add(EventTarget(event_id=1, task_id=task_id, message_event_id=task_id + 1))
            session.add(Event(id=task_id + 1, task_id=task_id, source='dingtalk', event_type='message', data={}))
            session.add(Event(id=10+task_id, task_id=task_id, source='runtime', event_type='watchdog_review', data={'action': 'observe'}))
            session.add(WatchdogRun(id=f'run-{task_id}', task_id=task_id, state_version=1, status='completed',
                                    evidence={'task_id': task_id}, conclusion={'action': 'observe'}))
    monkeypatch.setattr(api, 'Session', sessions)
    trace = api.trace(1)
    assert trace['live_stages']['worker']['state'] == 'fanout'
    assert len(trace['target_observations']) == 2
    assert {row['execution']['state'] for row in trace['target_observations']} == {'running', 'paused'}
    for row in trace['target_observations']:
        assert row['watchdog']['runs'][0]['evidence']['task_id'] == row['task_id']
        assert row['execution']['events'][0]['event_type'] == 'watchdog_review'
        canonical_trace = api.trace(row['message_event_id'])
        assert canonical_trace['live_stages']['watchdog']['runs'][0]['task_id'] == row['task_id']
        assert canonical_trace['live_stages']['watchdog']['events'][0]['event_type'] == 'watchdog_review'
    engine.dispose()
