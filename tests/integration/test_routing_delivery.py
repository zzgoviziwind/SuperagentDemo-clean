"""Offline business loop against real clients with fake external transports."""

import asyncio
import sys
from pathlib import Path

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from superagent.connectors.dingtalk import DingTalkClient, normalize_event
from superagent.connectors.redmine import RedmineClient, RedminePoller
from superagent.core.connections import ConnectionManager, PersistentStateStore
from superagent.core.db import Base, Event, Project, Task
from superagent.core.delivery import (DeliveryRecord, create_draft, decide_draft,
                                      publish_draft, reconcile_delivery)
from superagent.core.governance import TaskOwner
from superagent.core.ingestion import ingest_event


@pytest.fixture
def sessions(tmp_path):
    engine = create_engine("sqlite:///" + str(tmp_path / "routing.db"))
    Base.metadata.create_all(engine)
    factory = sessionmaker(engine, expire_on_commit=False)
    with factory.begin() as session:
        session.add(Project(name="演示项目", repo_path=str(tmp_path), dingtalk_chat_ids=["chat"], redmine_project_ids=["7"]))
    yield factory
    engine.dispose()


def actor(source, actor_id):
    return {"user_id": "admin", "role": "admin", "project_ids": [1], "permissions": ["request"]} if actor_id in {"trusted", "9"} else None


def message(ident="message-1", content="请修复 #42 的问题"):
    return normalize_event({"type": "user_im_message_receive_at", "sender_open_dingtalk_id": "trusted",
                            "conversation_id": "chat", "message_id": ident, "content": content,
                            "event_time": "2026-11-13T01:00:00Z"}, profile="test", self_ids=["self"])


def config(key, default=None):
    return {"connectors.dingtalk": {"enabled": True, "profile": "test", "executable": "fake-dws", "self_ids": ["self"]},
            "connectors.redmine": {"enabled": True, "base_url": "http://fake-redmine", "user_id": "5", "project_ids": [7]},
            "external_delivery_enabled": True}.get(key, default)


def receive(sessions, event):
    return ingest_event(event, session_factory=sessions, actor_resolver=actor, settings=config)


def test_redmine_poll_dingtalk_correlation_and_restart_dedupe(sessions):
    async def scenario():
        requests = []
        async def transport(method, path, params, body):
            requests.append((method, path))
            if path == "/issues.json":
                return 200, {"issues": [{"id": 42}], "total_count": 1, "offset": 0}
            return 200, {"issue": {"id": 42, "project": {"id": 7}, "author": {"id": 9},
                                   "assigned_to": {"id": 5}, "subject": "修复问题", "description": "明确需求",
                                   "updated_on": "2026-11-13T01:00:00Z", "journals": []}}
        async def emit(event):
            receive(sessions, event)
        client = RedmineClient("http://fake-redmine", "fake-key", transport=transport)
        await RedminePoller(client, emit, PersistentStateStore(sessions), [7], 5).poll_once()
        chat = receive(sessions, message())
        assert chat["task_id"] is not None
        assert receive(sessions, message())["duplicate"] is True
        # New poller and state-store instances model process restart.
        await RedminePoller(client, emit, PersistentStateStore(sessions), [7], 5).poll_once()
        with sessions() as session:
            assert len(session.scalars(select(Task)).all()) == 1
            assert len(session.scalars(select(Event)).all()) == 2
            assert session.get(TaskOwner, chat["task_id"]).user_id == "admin"
        assert requests
    asyncio.run(scenario())


@pytest.mark.parametrize("change,reason", [
    ({"actor_id": "unknown"}, "actor_unmapped_or_disabled"),
    ({"project_external_id": "wrong"}, "project_binding_missing_ambiguous_or_disabled"),
    ({"content": "请修复 #42 和 #43"}, "ambiguous_issue_reference"),
    ({"content": "早上好"}, "explicit_request_required"),
    ({"metadata": {"needs_confirmation": True}}, "ambiguous_or_empty_request"),
])
def test_untrusted_or_ambiguous_event_is_durable_pending(sessions, change, reason):
    receipt = receive(sessions, message() | change)
    assert receipt["task_id"] is None
    assert receipt["data"]["routing_reason"] == reason
    with sessions() as session:
        assert not session.scalars(select(Task)).all()
        assert len(session.scalars(select(Event)).all()) == 1


def test_ambiguous_binding_and_terminal_followup(sessions):
    first = receive(sessions, message())
    with sessions.begin() as session:
        session.get(Task, first["task_id"]).status = "completed"
    second = receive(sessions, message("message-2"))
    assert second["task_id"] != first["task_id"]
    assert second["data"]["related_task_id"] == first["task_id"]
    with sessions.begin() as session:
        session.add(Project(name="重复绑定", repo_path=".", dingtalk_chat_ids=["chat"]))
    assert receive(sessions, message("message-3"))["task_id"] is None


@pytest.mark.parametrize("unknown", [False, True])
def test_dws_draft_approval_publish_once_and_unknown_reconcile(sessions, unknown):
    async def scenario():
        receipt = receive(sessions, message())
        draft = create_draft(receipt["task_id"], receipt["id"], "修复已完成，测试通过", session_factory=sessions, settings=config)
        calls = []
        async def fake_dws(argv):
            calls.append(argv)
            if unknown:
                from superagent.connectors.common import WriteOutcomeUnknown
                raise WriteOutcomeUnknown("timeout")
            return {"data": {"deliveryStatus": "sent", "messageId": "reply-1"}}
        client = DingTalkClient(profile="test", runner=fake_dws)
        with pytest.raises(PermissionError):
            await publish_draft(draft["id"], session_factory=sessions, settings=config, client=client)
        assert not calls
        decide_draft(draft["id"], "approve", draft["approval"]["action_hash"], session_factory=sessions)
        result = await publish_draft(draft["id"], session_factory=sessions, settings=config, client=client)
        assert result["write_status"] == ("unknown" if unknown else "succeeded")
        assert await publish_draft(draft["id"], session_factory=sessions, settings=config, client=client) == result
        assert len(calls) == 1
        if unknown:
            result = reconcile_delivery(draft["id"], "succeeded", "外部消息记录已人工核验", session_factory=sessions)
            assert result["write_status"] == "succeeded"
            await publish_draft(draft["id"], session_factory=sessions, settings=config, client=client)
            assert len(calls) == 1
    asyncio.run(scenario())


def test_redmine_reply_uses_approved_original_issue(sessions):
    async def scenario():
        event = message() | {"source": "redmine", "external_id": "issue-42", "actor_id": "9", "issue_id": "42",
                             "event_type": "issue.comment", "project_external_id": "7", "metadata": {"redmine_endpoint": "http://fake-redmine"}}
        receipt = receive(sessions, event)
        draft = create_draft(receipt["task_id"], receipt["id"], "结果", session_factory=sessions, settings=config)
        decide_draft(draft["id"], "approve", draft["approval"]["action_hash"], session_factory=sessions)
        writes = []
        async def transport(method, path, params, body):
            writes.append((method, path, body))
            return 204, {}
        client = RedmineClient("http://fake-redmine", "fake-key", transport=transport)
        assert (await publish_draft(draft["id"], session_factory=sessions, settings=config, client=client))["write_status"] == "succeeded"
        assert writes == [("PUT", "/issues/42.json", {"issue": {"notes": "结果"}})]
    asyncio.run(scenario())


def test_stale_approval_never_calls_external_service(sessions):
    async def scenario():
        receipt = receive(sessions, message())
        draft = create_draft(receipt["task_id"], receipt["id"], "结果", session_factory=sessions, settings=config)
        decide_draft(draft["id"], "approve", draft["approval"]["action_hash"], session_factory=sessions)
        with sessions.begin() as session:
            session.get(Task, receipt["task_id"]).revision += 1
        with pytest.raises(PermissionError):
            await publish_draft(draft["id"], session_factory=sessions, settings=config)
        with sessions() as session:
            assert not session.scalars(select(DeliveryRecord)).all()
    asyncio.run(scenario())


def test_manager_defaults_disabled_and_explicit_start_stop(sessions, monkeypatch):
    async def scenario():
        calls = []
        class Listener:
            status = "stopped"
            def __init__(self, executable, emit, **kwargs):
                self.emit = emit
            async def start(self):
                calls.append("start")
                await self.emit(message())
                self.status = "running"
            async def stop(self):
                calls.append("stop")
                self.status = "stopped"
        async def emit(event):
            receive(sessions, event)
        disabled = ConnectionManager(settings=lambda k, d: d, session_factory=sessions, listener_factory=Listener)
        await disabled.start()
        assert not calls
        manager = ConnectionManager(settings=config, session_factory=sessions, emit=emit, listener_factory=Listener)
        await manager.start("dingtalk")
        assert manager.statuses()[0]["status"] == "running"
        await manager.start("dingtalk")
        await manager.stop()
        assert calls == ["start", "stop"]
        PersistentStateStore(sessions).set("checkpoint", "2026-11-13")
        PersistentStateStore(sessions).set("checkpoint", "2026-11-12")
        assert PersistentStateStore(sessions).get("checkpoint") == "2026-11-13"
    asyncio.run(scenario())


def test_real_dws_subprocess_event_to_task_and_approved_reply(sessions):
    async def scenario():
        executable = [sys.executable, str(Path(__file__).with_name("fake_business_dws.py"))]
        def settings(key, default=None):
            value = config(key, default)
            return {**value, "executable": executable} if key == "connectors.dingtalk" else value
        async def emit(event):
            receive(sessions, event)
        manager = ConnectionManager(settings=settings, session_factory=sessions, emit=emit)
        await manager.start("dingtalk")
        try:
            for _ in range(100):
                with sessions() as session:
                    event = session.scalar(select(Event))
                if event:
                    break
                await asyncio.sleep(0.02)
            assert event is not None and event.task_id is not None
            draft = create_draft(event.task_id, event.id, "离线验证回复", session_factory=sessions, settings=settings)
            decide_draft(draft["id"], "approve", draft["approval"]["action_hash"], session_factory=sessions)
            result = await publish_draft(draft["id"], session_factory=sessions, settings=settings)
            assert result["write_status"] == "succeeded"
            assert result["message_id"] == "offline-reply"
            with sessions() as session:
                assert len(session.scalars(select(Task)).all()) == 1
                assert len(session.scalars(select(Event).where(Event.source == "dingtalk")).all()) == 1
        finally:
            await manager.stop()
    asyncio.run(scenario())


def test_scoped_identity_required_even_for_admin(sessions):
    for index, grants in enumerate([{}, {"project_ids": [2], "permissions": ["request"]}, {"project_ids": [1]}]):
        result = ingest_event(message(str(index)), session_factory=sessions,
                              actor_resolver=lambda *_: {"user_id": "admin", "role": "admin", **grants})
        assert result["task_id"] is None
        assert result["data"]["routing_reason"] == "actor_not_authorized_for_project"


def test_real_governance_identity_mapping_and_scope(sessions, monkeypatch):
    from superagent.core import governance
    monkeypatch.setattr(governance.db, "Session", sessions)
    monkeypatch.delenv("SUPERAGENT_USERS_JSON", raising=False)
    governance.map_actor("dingtalk", "trusted", "admin")
    first = ingest_event(message("unscoped"), session_factory=sessions)
    assert first["task_id"] is None
    governance.map_actor("dingtalk", "trusted", "admin", project_ids=[1], permissions=["request"])
    second = ingest_event(message("scoped"), session_factory=sessions)
    assert second["task_id"] is not None
    with sessions() as session:
        assert session.get(TaskOwner, second["task_id"]).user_id == "admin"
    governance.map_actor("dingtalk", "trusted", "admin", enabled=False, project_ids=[1], permissions=["request"])
    assert ingest_event(message("disabled"), session_factory=sessions)["task_id"] is None


def test_api_admin_controls_and_owner_delivery(sessions, monkeypatch):
    import json
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from superagent.api import connections as api
    from superagent.core import delivery, governance, ingestion
    monkeypatch.setenv("SUPERAGENT_USERS_JSON", json.dumps([
        {"user_id": "admin", "role": "admin", "token": "admin-token"},
        {"user_id": "other", "role": "member", "token": "member-token"},
        {"user_id": "viewer", "role": "viewer", "token": "viewer-token"}]))
    monkeypatch.setattr(governance.db, "Session", sessions)
    monkeypatch.setattr(ingestion, "Session", sessions)
    monkeypatch.setattr(delivery, "Session", sessions)
    monkeypatch.setattr(delivery, "get_config", config)
    monkeypatch.setattr(api, "Session", sessions)
    governance.map_actor("dingtalk", "trusted", "admin", project_ids=[1], permissions=["request"])
    app = FastAPI()
    app.include_router(api.router)
    with TestClient(app, base_url="http://localhost") as client:
        viewer = {"Authorization": "Bearer viewer-token"}
        member = {"Authorization": "Bearer member-token"}
        admin = {"Authorization": "Bearer admin-token"}
        assert client.post("/api/v1/events", headers=viewer, json=message()).status_code == 403
        assert client.post("/api/v1/connectors/dingtalk/start", headers=member).status_code == 403
        receipt = client.post("/api/v1/events", headers=admin, json=message()).json()
        path = f"/api/v1/tasks/{receipt['task_id']}/deliveries"
        payload = {"event_id": receipt["id"], "content": "结果"}
        assert client.post(path, headers=member, json=payload).status_code == 403
        assert client.post(path, headers=viewer, json=payload).status_code == 403
        response = client.post(path, headers=admin, json=payload)
        assert response.status_code == 200
        draft = response.json()
        decision_path = f"/api/v1/deliveries/{draft['id']}/decision"
        decision = {"decision": "approve", "action_hash": draft["approval"]["action_hash"]}
        assert client.post(decision_path, headers=member, json=decision).status_code == 403
        assert client.post(decision_path, headers=admin, json=decision).status_code == 200


def test_concurrent_duplicate_receipts_and_crashed_send_claim(sessions):
    from concurrent.futures import ThreadPoolExecutor
    from superagent.core.delivery import PersistentActionLedger
    with ThreadPoolExecutor(max_workers=4) as workers:
        receipts = list(workers.map(lambda _: receive(sessions, message()), range(4)))
    assert len({item["task_id"] for item in receipts}) == 1
    assert sum(not item["duplicate"] for item in receipts) == 1
    async def scenario():
        receipt = receipts[0]
        draft = create_draft(receipt["task_id"], receipt["id"], "结果", session_factory=sessions, settings=config)
        decide_draft(draft["id"], "approve", draft["approval"]["action_hash"], session_factory=sessions)
        ledger = PersistentActionLedger(sessions)
        action_id = "reply-" + str(draft["approval_id"])
        assert await ledger.claim(action_id, draft["approval"]["action_hash"])
        # Process died after its durable claim, before a response could be saved.
        result = await publish_draft(draft["id"], session_factory=sessions, settings=config)
        assert result["write_status"] == "unknown"
        assert not await ledger.claim(action_id, draft["approval"]["action_hash"])
    asyncio.run(scenario())


def test_followup_expires_old_result_and_retains_request(sessions):
    receipt = receive(sessions, message())
    draft = create_draft(receipt["task_id"], receipt["id"], "旧结果", session_factory=sessions, settings=config)
    with sessions.begin() as session:
        session.get(Task, receipt["task_id"]).status = "running"
    followup = receive(sessions, message("second", "请继续检查 #42 的边界"))
    assert followup["task_id"] == receipt["task_id"]
    assert followup["event_type"] == "message"
    with sessions() as session:
        task = session.get(Task, receipt["task_id"])
        assert task.status == "waiting_input" and task.revision == 2 and task.control_version == 2
    with pytest.raises(ValueError):
        decide_draft(draft["id"], "approve", draft["approval"]["action_hash"], session_factory=sessions)


def test_environment_configuration_requires_explicit_enable_and_rejects_secrets(sessions, monkeypatch):
    import json
    from superagent.core import governance
    from superagent.core.connections import get_config, validate_configuration
    monkeypatch.setattr(governance.db, "Session", sessions)
    monkeypatch.setenv("SUPERAGENT_DINGTALK_CONFIG", json.dumps({"profile": "test", "self_ids": ["self"], "executable": "fake-dws"}))
    manager = ConnectionManager(session_factory=sessions)
    assert manager.statuses()[0]["configured"] is True
    assert manager.statuses()[0]["enabled"] is False
    with pytest.raises(ValueError):
        validate_configuration("redmine", {"api_key": "must-not-be-stored"})
    monkeypatch.setenv("SUPERAGENT_DINGTALK_CONFIG", "{broken")
    assert get_config("connectors.dingtalk", {}) == {"configuration_error": True}
    assert manager.statuses()[0]["configured"] is False
    stored = {"enabled": False, "profile": "saved", "self_ids": ["saved-self"], "executable": "fake-dws"}
    governance.set_setting("connectors.dingtalk", stored)
    assert get_config("connectors.dingtalk", {}) == stored
    assert ConnectionManager(session_factory=sessions).statuses()[0]["configured"] is True


def test_receipt_dispatches_nonblocking_runtime_interruption(sessions):
    from superagent.core.connections import schedule_interruption
    async def scenario():
        owner = ConnectionManager(session_factory=sessions, settings=lambda key, default: default)
        first = receive(sessions, message())
        with sessions.begin() as session:
            session.get(Task, first["task_id"]).status = "running"
        followup = receive(sessions, message("interrupt", "请修复 #42 的另一个边界"))
        entered, release = asyncio.Event(), asyncio.Event()
        class Scheduler:
            async def stop_run(self, task_id, action):
                assert task_id == first["task_id"] and action == "change_goal"
                entered.set()
                await release.wait()
        schedule_interruption(followup, scheduler=Scheduler(), session_factory=sessions, owner=owner)
        # Scheduling returns before the runtime responds to its interrupt.
        assert not entered.is_set()
        await asyncio.wait_for(entered.wait(), 1)
        assert not release.is_set()
        release.set()
        await asyncio.sleep(0)
        await owner.stop()
    asyncio.run(scenario())


def test_member_task_owner_and_admin_inbox_retry(sessions, monkeypatch):
    import json
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from superagent.api import connections as api
    from superagent.core import governance, ingestion
    from superagent.core.governance import Audit, task_owner
    monkeypatch.setattr(governance.db, "Session", sessions)
    monkeypatch.setattr(ingestion, "Session", sessions)
    monkeypatch.setattr(api, "Session", sessions)
    monkeypatch.setenv("SUPERAGENT_USERS_JSON", json.dumps([
        {"user_id": "admin", "role": "admin", "token": "admin-token"},
        {"user_id": "member", "role": "member", "token": "member-token"}]))
    app = FastAPI()
    app.include_router(api.router)
    with TestClient(app, base_url="http://localhost") as client:
        admin = {"Authorization": "Bearer admin-token"}
        member = {"Authorization": "Bearer member-token"}
        first = client.post("/api/v1/events", headers=admin, json=message()).json()
        second = client.post("/api/v1/events", headers=admin, json=message("pending-2")).json()
        assert first["task_id"] is None
        page = client.get("/api/v1/events?limit=1", headers=admin).json()
        assert page["items"][0]["id"] == first["id"] and page["has_more"]
        assert client.get(f"/api/v1/events?after={page['next_after']}", headers=admin).json()["items"][0]["id"] == second["id"]
        assert client.get("/api/v1/events", headers=member).status_code == 403
        governance.map_actor("dingtalk", "trusted", "member", project_ids=[1], permissions=["request"])
        path = f"/api/v1/events/{first['id']}/retry-routing"
        assert client.post(path, headers=member).status_code == 403
        routed = client.post(path, headers=admin).json()
        assert routed["task_id"] is not None and "routing_reason" not in routed["data"]
        assert client.post(path, headers=admin).json()["duplicate"]
        with sessions() as session:
            task = session.get(Task, routed["task_id"])
            assert task.owner_id == "member" and task_owner(task.id, session) == "member"
            assert len(session.scalars(select(Audit).where(Audit.action == "event.retry_routing")).all()) == 1
        # Canonical Task.owner_id governs even when a legacy TaskOwner row differs.
        with sessions.begin() as session:
            session.get(TaskOwner, routed["task_id"]).user_id = "admin"
        next_event = ingest_event(message("member-followup"), session_factory=sessions)
        assert next_event["task_id"] == routed["task_id"]
        assert len(client.get("/api/v1/events?routing_status=pending_confirmation", headers=admin).json()["items"]) == 1


@pytest.mark.parametrize("bad_origin", [False, True])
def test_real_http_attachment_to_task_context_is_bounded_and_revalidated(sessions, monkeypatch, tmp_path, bad_origin):
    import json
    import threading
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    from superagent.core.connections import prepare_attachments
    from superagent.core.db import Artifact
    from superagent.core.ingestion import EventAttachmentJob
    payload = b"Verified source context.\n"
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path.startswith("/issues/"):
                manifest = {"id": 8, "filename": "context.txt", "filesize": len(payload), "content_type": "text/plain",
                            "content_url": "http://untrusted.invalid/attachments/download/8/context.txt" if bad_origin else "/attachments/download/8/context.txt"}
                data = json.dumps({"issue": {"id": 42, "project": {"id": 7}, "attachments": [manifest]}}).encode()
                kind = "application/json"
            else:
                assert self.path == "/attachments/download/8/context.txt"
                data, kind = payload, "text/plain"
            self.send_response(200)
            self.send_header("Content-Type", kind)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        def log_message(self, *args):
            pass
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    endpoint = f"http://127.0.0.1:{server.server_port}"
    monkeypatch.setenv("HLZJ_REDMINE_API_KEY", "offline-test-key")
    monkeypatch.setenv("SUPERAGENT_ATTACHMENTS_ROOT", str(tmp_path / "managed-attachments"))
    def settings(key, default=None):
        return {"enabled": True, "base_url": endpoint} if key == "connectors.redmine" else default
    try:
        event = message() | {"source": "redmine", "event_type": "issue.comment", "external_id": "attachment-event",
                             "actor_id": "9", "project_external_id": "7", "issue_id": "42",
                             "metadata": {"redmine_endpoint": endpoint},
                             "attachments": [{"id": 8, "content_url": "file:///untrusted", "local_path": "C:/secret"}]}
        receipt = receive(sessions, event)
        with sessions() as session:
            assert session.get(Task, receipt["task_id"]).status == "waiting_resource"
        asyncio.run(prepare_attachments(receipt["id"], session_factory=sessions, settings=settings))
        with sessions() as session:
            job = session.get(EventAttachmentJob, receipt["id"])
            task = session.get(Task, receipt["task_id"])
            assert job.status == ("failed" if bad_origin else "completed")
            assert task.status == ("waiting_input" if bad_origin else "queued")
            artifacts = session.scalars(select(Artifact).where(Artifact.kind == "source_attachment")).all()
            if bad_origin:
                assert not artifacts
            else:
                saved = json.loads(artifacts[0].content)
                assert Path(saved["local_path"]).is_relative_to(tmp_path / "managed-attachments")
                assert Path(saved["local_path"]).read_bytes() == payload
                context = session.scalar(select(Event).where(Event.source == "runtime", Event.event_type == "message"))
                assert saved["local_path"] in context.content
                assert "file:///untrusted" not in context.content and "C:/secret" not in context.content
        if bad_origin:
            from superagent.core.ingestion import retry_attachments
            from superagent.core.governance import Audit
            bad_origin = False
            retry_attachments(receipt["id"], actor="admin", session_factory=sessions)
            asyncio.run(prepare_attachments(receipt["id"], session_factory=sessions, settings=settings))
            with sessions() as session:
                assert session.get(EventAttachmentJob, receipt["id"]).status == "completed"
                assert session.get(Task, receipt["task_id"]).status == "queued"
                assert session.scalar(select(Audit).where(Audit.action == "event.retry_attachments")) is not None
    finally:
        server.shutdown()
        server.server_close()
        worker.join(timeout=2)


def test_manager_wires_scoped_history_replay_and_governance_config(sessions, monkeypatch):
    from superagent.core import governance
    from superagent.core.connections import validate_configuration
    monkeypatch.setattr(governance.db, "Session", sessions)
    executable = [sys.executable, str(Path(__file__).with_name("fake_business_dws.py"))]
    value = {"enabled": True, "executable": executable, "profile": "test", "self_ids": ["self"],
             "history": {"chat_ids": ["chat"], "initial_since": "2020-01-01T00:00:00Z", "history_timezone": "+08:00",
                         "sender_map": {"history-user": "trusted"}, "page_limit": 2}}
    governance.set_setting("connectors.dingtalk", value)
    async def scenario():
        async def emit(event):
            receive(sessions, event)
        manager = ConnectionManager(session_factory=sessions, emit=emit)
        try:
            await manager.start("dingtalk")
            assert manager.statuses()[0]["status"] == "running"
            with sessions() as session:
                events = session.scalars(select(Event).where(Event.source == "dingtalk")).all()
                assert any("historical-message" in event.external_id for event in events)
                assert len(session.scalars(select(Task)).all()) == 1
            assert manager.instances["dingtalk"].replay is not None
        finally:
            await manager.stop()
    asyncio.run(scenario())
    with pytest.raises(ValueError):
        validate_configuration("dingtalk", value | {"kind": "group", "chat_id": "other"})


def test_dws_downloaded_image_enters_persisted_task_context(sessions, monkeypatch, tmp_path):
    import json
    from superagent.core.connections import prepare_attachments
    from superagent.core.db import Artifact
    monkeypatch.setenv("SUPERAGENT_ATTACHMENTS_ROOT", str(tmp_path / "media"))
    executable = [sys.executable, str(Path(__file__).with_name("fake_business_dws.py"))]
    def settings(key, default=None):
        return {"enabled": True, "profile": "test", "executable": executable} if key == "connectors.dingtalk" else default
    receipt = receive(sessions, message() | {"attachments": [{"local_path": "C:/untrusted", "url": "file:///untrusted"}]})
    asyncio.run(prepare_attachments(receipt["id"], session_factory=sessions, settings=settings))
    with sessions() as session:
        assert session.get(Task, receipt["task_id"]).status == "queued"
        artifact = session.scalar(select(Artifact).where(Artifact.kind == "source_attachment"))
        assert artifact is not None
        metadata = json.loads(artifact.content)
        assert metadata["content_type"] == "image/png"
        assert Path(metadata["local_path"]).is_relative_to(tmp_path / "media")
        assert Path(metadata["local_path"]).read_bytes().startswith(b"\x89PNG")


@pytest.mark.parametrize("status", ["paused", "cancelled", "waiting_input"])
def test_late_attachment_job_preserves_user_control(sessions, monkeypatch, tmp_path, status):
    from superagent.core.connections import prepare_attachments
    monkeypatch.setenv("HLZJ_REDMINE_API_KEY", "offline-key")
    monkeypatch.setenv("SUPERAGENT_ATTACHMENTS_ROOT", str(tmp_path / "late"))
    async def scenario():
        entered, release = asyncio.Event(), asyncio.Event()
        class Client:
            def __init__(self, *_):
                pass
            async def get_issue(self, *_):
                return {"id": 42, "project": {"id": 7}, "attachments": [{"id": 8}]}
            async def download_attachment(self, manifest, directory, **kwargs):
                entered.set()
                await release.wait()
                directory.mkdir(parents=True)
                path = directory / "context.txt"
                path.write_text("context")
                return {"local_path": str(path), "filename": path.name, "size": 7, "content_type": "text/plain", "sha256": "offline-hash"}
            async def close(self):
                pass
        event = message() | {"source": "redmine", "external_id": "late-attachment", "event_type": "issue.comment",
                             "actor_id": "9", "project_external_id": "7", "issue_id": "42",
                             "metadata": {"redmine_endpoint": "http://fake-redmine"}, "attachments": [{"id": 8}]}
        receipt = receive(sessions, event)
        worker = asyncio.create_task(prepare_attachments(receipt["id"], session_factory=sessions, settings=config, redmine_factory=Client))
        await asyncio.wait_for(entered.wait(), 1)
        with sessions.begin() as session:
            task = session.get(Task, receipt["task_id"])
            task.status, task.control_version = status, task.control_version + 1
            task.last_error = "用户操作"
            if status == "waiting_input":
                task.revision += 1
        release.set()
        await worker
        with sessions() as session:
            task = session.get(Task, receipt["task_id"])
            assert task.status == status and task.last_error == "用户操作"
            assert not session.scalars(select(Event).where(Event.source == "runtime", Event.event_type == "message")).all()
    asyncio.run(scenario())


def test_restart_processing_attachment_fails_for_explicit_retry(sessions):
    from superagent.core.ingestion import EventAttachmentJob, retry_attachments
    event = message() | {"attachments": [{"id": "image"}]}
    receipt = receive(sessions, event)
    with sessions.begin() as session:
        session.get(EventAttachmentJob, receipt["id"]).status = "processing"
    async def scenario():
        manager = ConnectionManager(settings=lambda key, default: default, session_factory=sessions)
        await manager.start()
        assert not manager._attachment_tasks
        with sessions() as session:
            assert session.get(EventAttachmentJob, receipt["id"]).status == "failed"
            assert session.get(Event, receipt["id"]).data["attachments_status"] == "failed"
            assert session.get(Task, receipt["task_id"]).status == "waiting_input"
        retry_attachments(receipt["id"], session_factory=sessions)
        with sessions() as session:
            assert session.get(EventAttachmentJob, receipt["id"]).status == "pending"
        await manager.stop()
    asyncio.run(scenario())


def test_manager_shutdown_owns_tasks_and_retains_slow_cleanup(sessions):
    async def scenario():
        owner = ConnectionManager(settings=lambda key, default: default, session_factory=sessions)
        other = ConnectionManager(settings=lambda key, default: default, session_factory=sessions)
        owner.shutdown_timeout = 0.02
        entered, release, interrupted = asyncio.Event(), asyncio.Event(), asyncio.Event()
        async def slow_cleanup():
            try:
                await asyncio.Event().wait()
            finally:
                entered.set()
                await release.wait()
        async def interrupt():
            try:
                await asyncio.Event().wait()
            finally:
                interrupted.set()
        attachment = asyncio.create_task(slow_cleanup())
        interruption = asyncio.create_task(interrupt())
        owner.track(attachment, owner._attachment_tasks)
        owner.track(interruption, owner._interrupts)
        await asyncio.sleep(0)
        await other.stop()
        assert not attachment.done() and not interruption.done()
        with pytest.raises(RuntimeError):
            await owner.stop()
        assert entered.is_set() and interrupted.is_set()
        assert attachment in owner._attachment_tasks and not attachment.done()
        with pytest.raises(RuntimeError):
            await owner.start()
        release.set()
        await asyncio.gather(attachment, interruption, return_exceptions=True)
        await owner.stop()
        assert not owner._attachment_tasks and not owner._interrupts and not owner._closing
    asyncio.run(scenario())


def test_redmine_stop_retains_inflight_http_worker_until_it_finishes(sessions, monkeypatch):
    import threading
    monkeypatch.setenv("HLZJ_REDMINE_API_KEY", "offline-key")
    async def scenario():
        entered, release = threading.Event(), threading.Event()
        clients = []
        class Client:
            base_url = "http://fake-redmine"
            def __init__(self, *_):
                self.closed = False
                clients.append(self)
            async def list_updated_issues(self, *_):
                def read():
                    entered.set()
                    release.wait(3)
                    return []
                return await asyncio.to_thread(read)
            async def close(self):
                self.closed = True
        owner = ConnectionManager(settings=config, session_factory=sessions, redmine_factory=Client)
        owner.shutdown_timeout = 0.02
        await owner.start("redmine")
        for _ in range(100):
            if entered.is_set():
                break
            await asyncio.sleep(0.01)
        assert entered.is_set()
        try:
            with pytest.raises(RuntimeError):
                await owner.stop()
            assert owner.tasks["redmine"] and not owner.tasks["redmine"].done()
            assert not clients[0].closed
            assert owner.statuses()[1]["status"] == "stop_failed"
        finally:
            release.set()
            owner.shutdown_timeout = 2
            await owner.stop()
        assert clients[0].closed and not owner.tasks and not owner.instances
    asyncio.run(scenario())


def quoted_message(ident, target, content="请继续检查边界", *, conversation="chat", profile="test"):
    return normalize_event({"type": "user_im_message_receive_at", "sender_open_dingtalk_id": "trusted",
                            "conversation_id": conversation, "message_id": ident, "content": content,
                            "event_time": "2026-11-13T01:00:00Z",
                            "quoted_message": {"message_id": target, "conversation_id": conversation}},
                           profile=profile, self_ids=["self"])


@pytest.mark.parametrize("content", ["请修复 #42 的问题", "请检查业务边界"])
def test_ticket_and_plain_message_reply_alias_chain(sessions, content):
    first = receive(sessions, message("initial", content))
    second = receive(sessions, quoted_message("followup", "initial"))
    third = receive(sessions, quoted_message("followup-again", "followup"))
    assert first["task_id"] == second["task_id"] == third["task_id"]
    assert receive(sessions, quoted_message("followup-again", "followup"))["duplicate"]
    with sessions() as session:
        assert len(session.scalars(select(Task)).all()) == 1


@pytest.mark.parametrize("content", ["请修复 #42 的问题", "请检查业务边界"])
def test_reply_alias_recovers_legacy_receipt_and_terminal_continuation(sessions, content):
    from sqlalchemy import delete
    from superagent.core.ingestion import TaskRoute
    first = receive(sessions, message("original", content))
    with sessions.begin() as session:
        session.execute(delete(TaskRoute).where(TaskRoute.route_key.like("dingtalk:message:%")))
    reply = receive(sessions, quoted_message("recovered", "original"))
    assert reply["task_id"] == first["task_id"]
    with sessions.begin() as session:
        session.get(Task, first["task_id"]).status = "completed"
    continuation = receive(sessions, quoted_message("new-demand", "original"))
    assert continuation["task_id"] != first["task_id"]
    assert continuation["data"]["related_task_id"] == first["task_id"]
    # An older message alias still follows the ticket's latest related task.
    next_reply = receive(sessions, quoted_message("next-demand", "recovered"))
    assert next_reply["task_id"] == continuation["task_id"]


def test_unknown_cross_scope_and_conflicting_replies_stay_pending(sessions):
    receive(sessions, message("ticket-42"))
    other = receive(sessions, message("ticket-43", "请修复 #43 的问题"))
    with sessions.begin() as session:
        session.get(Project, 1).dingtalk_chat_ids = ["chat", "other-chat"]
    for index, event in enumerate([
        quoted_message("missing", "unknown"),
        quoted_message("other-scope", "ticket-42", conversation="other-chat"),
        quoted_message("other-profile", "ticket-42", profile="different-account"),
        quoted_message("conflict", "ticket-42", "请继续修复 #43 的问题"),
        quoted_message("unbound-ticket", "ticket-42", "请继续修复 #44 的问题"),
    ]):
        result = receive(sessions, event)
        assert result["task_id"] is None, (index, result)
        assert result["data"]["routing_status"] == "pending_confirmation"
    assert other["task_id"] is not None
    with sessions() as session:
        assert len(session.scalars(select(Task)).all()) == 2


def test_explicit_owner_dispatch_works_after_application_manager_stopped(sessions, monkeypatch):
    from superagent.core.connections import manager, schedule_interruption
    monkeypatch.setattr(manager, "stopping", True)
    async def scenario():
        owner = ConnectionManager(session_factory=sessions, settings=lambda key, default: default)
        called = asyncio.Event()
        class Scheduler:
            async def stop_run(self, *_):
                called.set()
        worker = schedule_interruption({"id": 1, "task_id": 1, "data": {"requires_interrupt": True}},
                                       owner=owner, scheduler=Scheduler(), session_factory=sessions)
        assert worker is not None
        await worker
        assert called.is_set()
        await owner.stop()
    asyncio.run(scenario())


@pytest.mark.parametrize("content,kind", [
    ("请分析 #42 的流程，仅分析，不修改代码", "analysis"),
    ("请只读检查 #42，不要修改文件", "analysis"),
    ("请修复 #42 的问题", "repair"),
    ("请修复 #42，不修改数据库", "repair"),
    ("请检查 #42 的边界", "repair"),
])
def test_explicit_readonly_request_selects_analysis(sessions, content, kind):
    receipt = receive(sessions, message(content=content))
    assert receipt["task_id"] is not None
    with sessions() as session:
        assert session.get(Task, receipt["task_id"]).kind == kind


def test_conflicting_readonly_and_write_request_stays_pending(sessions):
    receipt = receive(sessions, message(content="请修复 #42 的代码，同时仅分析，不修改代码"))
    assert receipt["task_id"] is None
    assert receipt["data"]["routing_reason"] == "conflicting_analysis_and_write_request"


def test_followup_preserves_analysis_until_explicit_kind_change(sessions):
    first = receive(sessions, message("analysis", "请分析 #42，仅分析，不修改代码"))
    receive(sessions, quoted_message("continue-analysis", "analysis", "请继续检查边界"))
    with sessions() as session:
        assert session.get(Task, first["task_id"]).kind == "analysis"
    updated = receive(sessions, quoted_message("repair", "analysis", "请修复这处代码"))
    assert updated["task_id"] == first["task_id"]
    with sessions() as session:
        task = session.get(Task, first["task_id"])
        assert task.kind == "repair" and task.revision == 3


def redmine_comment(journal_id, content, occurred, *, actor_id="5", issue_id="42", endpoint="http://fake-redmine"):
    from superagent.connectors.common import digest
    return {"source": "redmine", "event_type": "issue.comment",
            "external_id": f"{endpoint}:issue:{issue_id}:journal:{journal_id}:" + digest(content),
            "actor_id": actor_id, "thread_id": issue_id, "project_external_id": "7", "issue_id": issue_id,
            "content": content, "occurred_at": occurred,
            "metadata": {"redmine_endpoint": endpoint, "journal_id": str(journal_id), "details": []}}


def approved_redmine_draft(sessions):
    first = receive(sessions, redmine_comment("original", "请修复 #42 的问题", "2026-11-13T01:00:00Z", actor_id="9"))
    draft = create_draft(first["task_id"], first["id"], "修复已完成，测试通过", session_factory=sessions, settings=config)
    decide_draft(draft["id"], "approve", draft["approval"]["action_hash"], session_factory=sessions)
    return first, draft


def receive_configured_account(sessions, event):
    return ingest_event(event, session_factory=sessions, settings=config,
                        actor_resolver=lambda *_: {"user_id": "admin", "role": "admin", "project_ids": [1], "permissions": ["request"]})


@pytest.mark.parametrize("unknown", [False, True])
@pytest.mark.parametrize("terminal", [False, True])
def test_redmine_write_echo_keeps_task_version_and_preserves_manual_comments(sessions, unknown, terminal):
    from datetime import datetime, timedelta
    from superagent.core.db import dump
    from superagent.core.governance import Audit
    from superagent.core.delivery import DeliveryEchoBinding
    async def scenario():
        first, draft = approved_redmine_draft(sessions)
        writes = []
        async def transport(method, path, params, body):
            assert method == "PUT"
            writes.append(body)
            if unknown:
                raise TimeoutError
            return 204, {}
        client = RedmineClient("http://fake-redmine", "offline-key", transport=transport)
        sent = await publish_draft(draft["id"], session_factory=sessions, settings=config, client=client)
        with sessions.begin() as session:
            record = session.get(DeliveryRecord, sent["action_id"])
            occurred = (datetime.fromisoformat(record.created_at) + timedelta(seconds=1)).isoformat()
            if terminal:
                session.get(Task, first["task_id"]).status = "completed"
            before = dump(session.get(Task, first["task_id"]))
        echo_event = redmine_comment("100", draft["content"], occurred)
        echo = receive_configured_account(sessions, echo_event)
        status = "self_echo_candidate" if unknown else "self_echo"
        assert echo["data"]["routing_status"] == status
        assert echo["task_id"] == first["task_id"]
        with pytest.raises(ValueError):
            create_draft(first["task_id"], echo["id"], "禁止回声递归回复", session_factory=sessions, settings=config)
        assert receive_configured_account(sessions, echo_event)["duplicate"]
        with sessions() as session:
            assert dump(session.get(Task, first["task_id"])) == before
            record = session.get(DeliveryRecord, sent["action_id"])
            assert record.result["write_status"] == ("unknown" if unknown else "succeeded")
            assert record.result["echo_evidence"]["journal_id"] == "100"
            assert len(session.scalars(select(DeliveryEchoBinding)).all()) == 1
            assert session.scalar(select(Audit).where(Audit.action == "delivery." + status)) is not None
        assert await publish_draft(draft["id"], session_factory=sessions, settings=config, client=client)
        assert len(writes) == 1
        manual = receive_configured_account(sessions, redmine_comment("101", "请补充 #42 的日志证据", occurred))
        assert manual["data"]["routing_status"] == "routed"
        # A second journal with the same text is a new request after the one-time binding.
        repeated = receive_configured_account(sessions, redmine_comment("102", draft["content"], occurred))
        assert repeated["data"]["routing_status"] == "routed"
        with sessions() as session:
            if terminal:
                assert session.get(Task, first["task_id"]).revision == before["revision"]
                assert manual["task_id"] == repeated["task_id"] != first["task_id"]
            else:
                assert session.get(Task, first["task_id"]).revision == before["revision"] + 2
    asyncio.run(scenario())


@pytest.mark.parametrize("change", ["actor", "endpoint", "issue", "expired", "before_claim", "failed", "journal_changes", "attachments", "sender_changed"])
def test_redmine_echo_requires_exact_scope_actor_time_and_write(sessions, change):
    from datetime import datetime, timedelta
    from superagent.core.delivery import PersistentActionLedger
    async def scenario():
        first, draft = approved_redmine_draft(sessions)
        action_id = "reply-" + str(draft["approval_id"])
        ledger = PersistentActionLedger(sessions, config)
        assert await ledger.claim(action_id, draft["approval"]["action_hash"])
        await ledger.finish(action_id, {"write_status": "failed" if change == "failed" else "succeeded"})
        with sessions() as session:
            claimed = datetime.fromisoformat(session.get(DeliveryRecord, action_id).created_at)
        seconds = {"expired": 121, "before_claim": -31}.get(change, 1)
        event = redmine_comment("test-journal", draft["content"], (claimed + timedelta(seconds=seconds)).isoformat())
        if change == "actor":
            event["actor_id"] = "9"
        if change == "endpoint":
            event["metadata"]["redmine_endpoint"] = "http://another-redmine"
        if change == "issue":
            event["issue_id"], event["thread_id"] = "43", "43"
        if change == "journal_changes":
            event["metadata"]["details"] = [{"property": "attr", "name": "status_id", "new_value": "2"}]
        if change == "attachments":
            event["attachments"] = [{"id": 8}]
        settings = config
        if change == "sender_changed":
            event["actor_id"] = "9"
            def settings(key, default=None):
                value = config(key, default)
                return {**value, "user_id": 9} if key == "connectors.redmine" else value
        receipt = ingest_event(event, session_factory=sessions, settings=settings,
                    actor_resolver=lambda *_: {"user_id": "admin", "role": "admin", "project_ids": [1], "permissions": ["request"]})
        assert receipt["data"]["routing_status"] == "routed"
    asyncio.run(scenario())


@pytest.mark.parametrize("timing", ["after_claim", "same_second", "server_clock_lag"])
def test_redmine_poll_after_write_records_echo_without_revision_or_new_snapshot(sessions, timing):
    from datetime import datetime, timedelta, timezone
    async def scenario():
        issue = {"id": 42, "project": {"id": 7}, "author": {"id": 9}, "assigned_to": {"id": 5},
                 "subject": "请修复 #42", "description": "边界情况", "updated_on": "2026-11-13T01:00:00Z", "journals": []}
        writes = []
        async def transport(method, path, params, body):
            if method == "PUT":
                writes.append(body)
                if timing != "after_claim":
                    with sessions.begin() as session:
                        record = session.get(DeliveryRecord, "reply-" + str(draft["approval_id"]))
                        claim = (datetime(2026, 11, 13, 9, 30, 21, 414879, tzinfo=timezone.utc)
                                 if timing == "server_clock_lag" else datetime.now(timezone.utc).replace(microsecond=500000))
                        record.created_at = claim.isoformat()
                    server_time = claim.replace(microsecond=0) - timedelta(seconds=2 if timing == "server_clock_lag" else 0)
                    occurred = server_time.isoformat(timespec="seconds").replace("+00:00", "Z")
                else:
                    occurred = (datetime.now(timezone.utc) + timedelta(seconds=1)).isoformat()
                issue["updated_on"] = occurred
                issue["journals"].append({"id": 100, "user": {"id": 5}, "notes": body["issue"]["notes"],
                                          "created_on": occurred, "details": []})
                return 204, {}
            if path == "/issues.json":
                return 200, {"issues": [{"id": 42}], "total_count": 1, "offset": 0}
            return 200, {"issue": issue}
        async def emit(event):
            receive_configured_account(sessions, event)
        client = RedmineClient("http://fake-redmine", "offline-key", transport=transport)
        poller = RedminePoller(client, emit, PersistentStateStore(sessions), [7], 5)
        await poller.poll_once()
        with sessions() as session:
            original = session.scalar(select(Event).where(Event.source == "redmine"))
            task_id, event_id = original.task_id, original.id
        draft = create_draft(task_id, event_id, "修复已完成，测试通过", session_factory=sessions, settings=config)
        decide_draft(draft["id"], "approve", draft["approval"]["action_hash"], session_factory=sessions)
        await publish_draft(draft["id"], session_factory=sessions, settings=config, client=client)
        await poller.poll_once()
        await poller.poll_once()
        with sessions() as session:
            task = session.get(Task, task_id)
            assert task.revision == 1 and task.control_version == 1
            receipts = session.scalars(select(Event).where(Event.source == "redmine")).all()
            assert len(receipts) == 2
            expected = "self_echo" if timing == "after_claim" else "self_echo_candidate"
            echo = next(event for event in receipts if event.data["routing_status"] == expected)
            assert len(session.scalars(select(Task)).all()) == 1
            if timing != "after_claim":
                assert echo.data["occurred_at"].endswith(".000000Z")
                reason = "source_clock_skew_overlap" if timing == "server_clock_lag" else "source_second_precision_overlap"
                assert echo.data["echo_reason"] == reason
                record = session.get(DeliveryRecord, "reply-" + str(draft["approval_id"]))
                assert record.result["write_status"] == "succeeded"
                assert record.result["echo_evidence"]["routing_status"] == "self_echo_candidate"
                if timing == "server_clock_lag":
                    assert record.result["echo_evidence"]["elapsed_seconds"] == pytest.approx(-2.414879)
        assert len(writes) == 1
    asyncio.run(scenario())


def test_seconds_precision_overlap_is_echo_candidate_and_finish_preserves_evidence(sessions):
    from datetime import datetime
    from superagent.core.delivery import PersistentActionLedger
    async def scenario():
        first, draft = approved_redmine_draft(sessions)
        ledger = PersistentActionLedger(sessions, config)
        action_id = "reply-" + str(draft["approval_id"])
        assert await ledger.claim(action_id, draft["approval"]["action_hash"])
        with sessions.begin() as session:
            record = session.get(DeliveryRecord, action_id)
            claim = datetime.fromisoformat(record.created_at).replace(microsecond=500000)
            record.created_at = claim.isoformat()
        receipt = receive_configured_account(sessions, redmine_comment("same-second", draft["content"], claim.isoformat(timespec="seconds")))
        assert receipt["data"]["routing_status"] == "self_echo_candidate"
        # A later successful network response retains the journal reconciliation evidence.
        await ledger.finish(action_id, {"action_id": action_id, "action_hash": draft["approval"]["action_hash"], "write_status": "succeeded"})
        saved = await ledger.get(action_id)
        assert saved["echo_evidence"]["journal_id"] == "same-second"
        assert saved["sender_actor_id"] == "5"
        with sessions() as session:
            assert session.get(Task, first["task_id"]).revision == 1
    asyncio.run(scenario())


@pytest.mark.parametrize("seconds", [-30, -30.000001, -2.414879, 120, 120.000001])
@pytest.mark.parametrize("write_status", ["succeeded", "unknown"])
def test_redmine_echo_bounded_clock_skew_keeps_original_write_status(sessions, seconds, write_status):
    from datetime import datetime, timedelta, timezone
    from superagent.core.delivery import PersistentActionLedger
    async def scenario():
        first, draft = approved_redmine_draft(sessions)
        action_id = "reply-" + str(draft["approval_id"])
        ledger = PersistentActionLedger(sessions, config)
        assert await ledger.claim(action_id, draft["approval"]["action_hash"])
        claim = datetime(2026, 11, 13, 9, 30, 21, 414879, tzinfo=timezone.utc)
        with sessions.begin() as session:
            session.get(DeliveryRecord, action_id).created_at = claim.isoformat()
        await ledger.finish(action_id, {"action_id": action_id, "action_hash": draft["approval"]["action_hash"], "write_status": write_status})
        occurred = (claim + timedelta(seconds=seconds)).isoformat()
        event = receive_configured_account(sessions, redmine_comment("clock-window", draft["content"], occurred))
        matched = -30 <= seconds <= 120
        expected = "self_echo_candidate" if seconds < 0 or write_status == "unknown" else "self_echo"
        assert event["data"]["routing_status"] == (expected if matched else "routed")
        with sessions() as session:
            task = session.get(Task, first["task_id"])
            assert task.revision == (1 if matched else 2)
            record = session.get(DeliveryRecord, action_id)
            assert record.result["write_status"] == write_status
            assert ("echo_evidence" in record.result) == matched
    asyncio.run(scenario())


def test_manager_restores_legacy_redmine_snapshot_without_replaying_unchanged_issue(sessions, monkeypatch):
    import copy
    monkeypatch.setenv("HLZJ_REDMINE_API_KEY", "offline-key")
    content = "请修复 #42\n原始描述"
    data = {"source": "redmine", "event_type": "issue.updated", "external_id": "http://fake-redmine:issue:42:2026-11-13T01:00:00Z",
            "actor_id": "9", "thread_id": "42", "issue_id": "42", "project_external_id": "7", "content": content,
            "metadata": {"redmine_endpoint": "http://fake-redmine", "external_user_id": "5", "assigned_to_me": True}}
    receipt = receive(sessions, data)
    # Legacy receipts may be canonical message events after task association.
    with sessions.begin() as session:
        event = session.get(Event, receipt["id"])
        event.event_type = "message"
        newest = copy.deepcopy(event.data)
        newest["external_id"] = "http://fake-redmine:issue:42:2026-11-13T02:00:00Z"
        newest["metadata"]["marker"] = "latest_valid"
        session.add(Event(source="redmine", external_id=newest["external_id"], task_id=receipt["task_id"],
                          event_type="message", content=content, data=newest))
        for index, (field, value) in enumerate([("endpoint", "http://other"), ("issue", "43"), ("project", "8"),
                                               ("account", "999"), ("kind", "issue.comment")]):
            wrong = copy.deepcopy(newest)
            if field == "endpoint":
                wrong["metadata"]["redmine_endpoint"] = value
            elif field == "issue":
                wrong["issue_id"] = value
            elif field == "project":
                wrong["project_external_id"] = value
            elif field == "account":
                wrong["metadata"]["external_user_id"] = value
            else:
                wrong["event_type"] = wrong["original_event_type"] = value
            session.add(Event(source="redmine", external_id=f"wrong-scope-{index}", event_type="message", content=content, data=wrong))
    store = PersistentStateStore(sessions)
    loaded = store.load_snapshot("http://fake-redmine", "42", [7], "5")
    assert loaded["metadata"]["marker"] == "latest_valid"
    for endpoint, issue_id, projects, account in [("http://missing", "42", [7], "5"), ("http://fake-redmine", "999", [7], "5"),
                                                  ("http://fake-redmine", "42", [999], "5"), ("http://fake-redmine", "42", [7], "unknown")]:
        assert store.load_snapshot(endpoint, issue_id, projects, account) is None
    async def scenario():
        emitted = []
        issue = {"id": 42, "project": {"id": 7}, "assigned_to": {"id": 5}, "author": {"id": 9},
                 "subject": "请修复 #42", "description": "原始描述", "updated_on": "2026-11-13T09:30:19Z", "journals": []}
        async def transport(method, path, params, body):
            if path == "/issues.json":
                return 200, {"issues": [{"id": 42}], "total_count": 1, "offset": 0}
            return 200, {"issue": issue}
        def client_factory(base_url, key):
            return RedmineClient(base_url, key, transport=transport)
        async def emit(event):
            emitted.append(event)
            receive(sessions, event)
        manager = ConnectionManager(settings=config, session_factory=sessions, redmine_factory=client_factory, emit=emit)
        await manager.start("redmine")
        try:
            for _ in range(100):
                if store.get("redmine:http://fake-redmine:7:5:issue:42:semantics"):
                    break
                await asyncio.sleep(0.01)
            assert store.get("redmine:http://fake-redmine:7:5:issue:42:semantics")
            assert not emitted
            assert store.load_snapshot("http://fake-redmine", "42", [7], "5") == loaded
            with sessions() as session:
                assert session.get(Task, receipt["task_id"]).revision == 1
        finally:
            await manager.stop()
        # Real content changes are still emitted after restoring the old checkpoint.
        issue["description"] = "更新后的真实需求"
        client = client_factory("http://fake-redmine", "offline-key")
        poller = RedminePoller(client, emit, store, [7], 5, load_snapshot=store.load_snapshot)
        await poller.poll_once()
        assert len(emitted) == 1 and emitted[0]["event_type"] == "issue.updated"
        with sessions() as session:
            assert session.get(Task, receipt["task_id"]).revision == 2
        await client.close()
    asyncio.run(scenario())
