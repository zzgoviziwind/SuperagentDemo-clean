"""Child process for stage0.py. No server socket, background services or account lookup."""
import asyncio
from datetime import datetime, timedelta
from contextlib import closing
import hashlib
import importlib.metadata
import json
import os
import platform
from pathlib import Path
import selectors
import sqlite3
import sys
import threading
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
WORK = Path.cwd().resolve()
MODE, SOURCE = sys.argv[1:]
if HERE not in WORK.parents or not __debug__ or MODE not in {"legacy", "oracle"}:
    raise RuntimeError("Use the stage0.py entry point")
DB = WORK / ("legacy.db" if MODE == "legacy" else "migrated.db")
assert DB.exists() == (MODE == "oracle")
INPUT = json.loads((HERE / "input.json").read_text("utf-8"))
ATTACH = WORK / "attachments"
PROJECT = WORK / "含空格 项目"
for directory in (ATTACH, PROJECT):
    directory.mkdir(exist_ok=True)
os.environ.update(SUPERAGENT_DATABASE_URL="sqlite:///" + DB.as_posix(),
                  SUPERAGENT_ATTACHMENTS_ROOT=str(ATTACH), SUPERAGENT_STATE_ROOT=str(WORK / "state"),
                  SUPERAGENT_ALLOWED_REPO_ROOTS=str(PROJECT), SUPERAGENT_SERVICE_MODE="preview",
                  SUPERAGENT_WORKSPACES_ROOT=str(WORK / "workspaces"), SUPERAGENT_API_TOKEN="fixture-only",
                  SUPERAGENT_REDMINE_CONFIG=json.dumps(INPUT["redmine"]))

violations = []


def guard(event, args):
    if event in {"socket.connect", "socket.bind", "socket.getaddrinfo", "subprocess.Popen",
                 "os.system", "os.spawn", "os.startfile", "os.posix_spawn"}:
        violations.append(event)
        raise RuntimeError(f"Offline boundary: {event}")


sys.addaudithook(guard)
if sys.platform == "win32":
    # CPython otherwise shells out to 'ver' when WMI is unavailable. Cache the native API result.
    native_version = ".".join(map(str, sys.getwindowsversion().platform_version))
    with patch.object(platform, "_syscmd_ver", return_value=("Windows", "", native_version)):
        platform.uname()
sys.path.insert(0, SOURCE)
import httpx
from superagent import main
from superagent.connectors.redmine import RedmineClient
from superagent.core import db, delivery, governance
from superagent.core.scheduler import load_attachments

assert Path(main.__file__).resolve().is_relative_to(Path(SOURCE).resolve())
assert Path(db.engine.url.database).resolve() == DB


class WakeSelector(selectors.SelectSelector):
    """Wake sync FastAPI worker threads without a Windows socketpair."""
    def __init__(self):
        super().__init__()
        self.wakeup = threading.Event()

    def select(self, timeout=None):
        assert not self.get_map(), "Unexpected I/O descriptor"
        self.wakeup.wait(timeout)
        self.wakeup.clear()
        return []


class OfflineLoop(asyncio.SelectorEventLoop):
    def __init__(self):
        super().__init__(WakeSelector())

    def _make_self_pipe(self):
        pass

    def _close_self_pipe(self):
        pass

    def _write_to_self(self):
        self._selector.wakeup.set()


def digest(value):
    data = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    return hashlib.sha256(data).hexdigest()


def normalize(value, key=None):
    if isinstance(value, dict):
        return {k: normalize(v, k) for k, v in value.items()}
    if isinstance(value, list):
        return [normalize(item, key) for item in value]
    if key in {"created_at", "updated_at", "exported_at", "started_at", "at", "dispatching_at",
               "claimed_at", "finished_at", "revoked_at"} and isinstance(value, str):
        assert datetime.fromisoformat(value).utcoffset() == timedelta(0), value
        return "<UTC>"
    if isinstance(value, str):
        # Artifact.content contains serialized JSON with escaped Windows path separators.
        return value.replace(json.dumps(str(WORK), ensure_ascii=False)[1:-1], "<TEMP>").replace(str(WORK), "<TEMP>")
    return value


def one_write_fixture():
    settings = {"connectors.redmine": dict(INPUT["redmine"], enabled=True), "external_delivery_enabled": True}
    return settings.get


async def create_legacy():
    db.init_db()
    fixture = INPUT["attachment"]
    path = ATTACH / fixture["filename"]
    data = fixture["text"].encode()
    path.write_bytes(data)
    manifest = {"local_path": str(path), "filename": path.name, "content_type": fixture["content_type"],
                "size": len(data), "sha256": hashlib.sha256(data).hexdigest()}
    with db.Session.begin() as s:
        project = db.Project(**INPUT["project"], repo_path=str(PROJECT))
        s.add(project)
        s.flush()
        task = db.Task(project_id=project.id, title="旧库任务", goal="保留历史交付", kind="repair",
                       owner_id="admin", status="waiting_approval", source="redmine")
        s.add(task)
        s.flush()
        s.add(governance.TaskOwner(task_id=task.id, user_id="admin"))
        data = dict(INPUT["event"], external_id="legacy-41", issue_id="41", routing_status="routed")
        event = db.Event(task_id=task.id, source="redmine", external_id=data["external_id"],
                         content="旧记录来信", event_type="issue.comment", data=data)
        s.add_all([event, db.Artifact(task_id=task.id, revision=1, kind="source_attachment",
                                     content=json.dumps(manifest, ensure_ascii=False))])
        action = {"method":"item/commandExecution/requestApproval","request_id":17,"params":{}}
        s.add(db.Approval(task_id=task.id, revision=1, control_version=1, action=action,
                          action_hash=digest(action)))
        s.flush()
        task_id, event_id = task.id, event.id
    draft = delivery.create_draft(task_id, event_id, "旧库草稿", settings=one_write_fixture())
    delivery.decide_draft(draft["id"], "approve", draft["approval"]["action_hash"])
    requests = []

    async def timeout(method, path, params, body):
        requests.append([method, path, body])
        raise TimeoutError()

    client = RedmineClient(INPUT["redmine"]["base_url"], "fixture", transport=timeout)
    for _ in range(2):
        ledger = await delivery.publish_draft(draft["id"], client=client, settings=one_write_fixture())
        assert ledger["write_status"] == "unknown"
    assert requests == [["PUT", "/issues/41.json", {"issue":{"notes":"旧库草稿"}}]]
    await client.close()
    return {"task_id":task_id,"event_id":event_id,"draft_id":draft["id"],"ledger":ledger,
            "attachment":manifest,"fake_requests":requests}


def inventory_and_migration():
    schema = main.app.openapi()["paths"]
    routes = sorted(f"{method.upper()} {path}" for path, methods in schema.items() for method in methods
                    if method in {"get", "post", "patch", "put", "delete", "head", "options"})
    old = sqlite3.connect((WORK / "legacy.db").as_uri() + "?mode=ro", uri=True)
    new = sqlite3.connect(DB.as_uri() + "?mode=ro", uri=True)
    try:
        ddl = dict(new.execute("SELECT name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name"))
        counts = {}
        for (name,) in old.execute("SELECT name FROM sqlite_master WHERE type='table'"):
            assert name.isidentifier()
            cols = [r[1] for r in old.execute(f'PRAGMA table_info("{name}")')]
            assert all(c.isidentifier() for c in cols)
            projection = ",".join(f'"{c}"' for c in cols)
            sql = f'SELECT {projection} FROM "{name}" ORDER BY rowid'
            before = old.execute(sql).fetchall()
            assert before == new.execute(sql).fetchall(), name
            counts[name] = len(before)
        assert all(counts[name] > 0 for name in ("projects", "tasks", "events", "approvals", "reply_drafts",
                                                 "delivery_records", "artifacts"))
        return {"routes": routes, "sqlite_schema": ddl, "old_table_rows_verified": counts}
    finally:
        old.close()
        new.close()


def persisted_sample():
    # Inspect via a new read-only SQLite connection, independently of ORM objects and HTTP serializers.
    with closing(sqlite3.connect(DB.as_uri() + "?mode=ro", uri=True)) as conn:
        conn.row_factory = sqlite3.Row
        def read(sql):
            return [dict(r) for r in conn.execute(sql)]
        tasks = read("SELECT id,source,status,state_version,revision,control_version FROM tasks ORDER BY id")
        receipts = read("SELECT id,task_id,external_id FROM events WHERE external_id IS NOT NULL ORDER BY id")
        approvals = read("SELECT id,task_id,status,revision,control_version,action_hash FROM approvals ORDER BY id")
        drafts = read("""SELECT d.id,d.task_id,d.event_id,d.approval_id,l.action_id,l.action_hash,
                         json_extract(l.result,'$.write_status') AS write_status
                         FROM reply_drafts AS d JOIN delivery_records AS l ON l.action_id='reply-' || d.approval_id
                         ORDER BY d.id""")
        assert [r["id"] for r in tasks] == [1, 2]
        assert [r["task_id"] for r in receipts] == [1, 2]
        assert [r["status"] for r in approvals] == ["rejected", "approved", "approved"]
        assert [r["write_status"] for r in drafts] == ["unknown", "succeeded"]
        for draft, receipt in zip(drafts, receipts, strict=True):
            approval = next(a for a in approvals if a["id"] == draft["approval_id"])
            assert draft["action_hash"] == approval["action_hash"]
            assert draft["task_id"] == receipt["task_id"] == approval["task_id"]
            assert draft["event_id"] == receipt["id"]
        return {"tasks":tasks, "receipts":receipts, "approvals":approvals, "deliveries":drafts}


async def exercise():
    from superagent.core import context, execution
    from superagent.connectors import redmine
    from superagent.core.scheduler import Scheduler
    from unittest.mock import AsyncMock

    db.init_db()
    report = inventory_and_migration()
    records = []
    raw = []
    calls = []
    flags = [execution.enabled, context.enabled, delivery.worker_enabled, delivery.ledger_v2_enabled]
    defaults = [f() for f in flags]
    assert defaults == [False] * 4
    for i, (k, v) in enumerate(INPUT["enabled_modes"].items()):
        with patch.dict(os.environ, {"SUPERAGENT_" + k: v}):
            assert [f() for f in flags] == [j == i for j in range(4)]
    report["modes"] = {"default_predicates": defaults, "enabled_in_isolation": INPUT["enabled_modes"]}
    ticks = {}
    for mode in ("inline", "worker"):
        sched = Scheduler()
        # End after exactly one poll and count calls at the actual auto-delivery boundary.
        def disable_and_stop():
            sched.stopping = True
            return {"scheduler_enabled":False}
        with patch.dict(os.environ, {"SUPERAGENT_DELIVERY_MODE":mode}), \
             patch("superagent.core.scheduler.settings_snapshot", disable_and_stop), \
             patch.object(delivery, "deliver_automatically", new_callable=AsyncMock) as send:
            await sched.poll()
            ticks[mode] = send.await_count
    assert ticks == {"inline":1,"worker":0}
    report["modes"]["scheduler_inline_dispatch_calls"] = ticks
    client = httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url="http://offline.invalid",
                               headers={"Authorization":"Bearer fixture-only"}, trust_env=False)

    async def api(method, path, body=None, status=200, authenticated=True):
        url = path if path == "/health" else "/api/v1" + path
        headers = {} if authenticated else {"Authorization":"Bearer invalid-fixture"}
        response = await client.request(method, url, json=body, headers=headers)
        value = response.json() if response.content else None
        assert response.status_code == status, (method, path, response.status_code, value)
        if status == 405:
            assert value is None and response.headers["allow"] == "POST"
        elif status >= 400:
            assert "detail" in value
        observed_headers = {k:response.headers[k] for k in ("content-type", "allow", "cache-control",
                            "content-disposition") if k in response.headers}
        request = {"method":method,"path":url,"body":body,"authenticated":authenticated}
        records.append({**request, "status":status, "headers":observed_headers,
                        "response_sha256":digest(normalize(value))})
        raw.append({**request, "status":status, "headers":observed_headers, "response":value})
        return value

    async with client:
        report["health"] = await api("GET", "/health")
        await api("GET", "/tasks", status=401, authenticated=False)
        for method in ("GET", "DELETE"):
            await api(method, "/conversation-providers/mcp", status=405)
        settings = await api("GET", "/settings")
        assert all(settings[key] is False for key in INPUT["default_false"])
        assert settings["service_mode"] == "preview" and settings["authentication_required"] is True
        report["default_settings"] = {k: settings[k] for k in INPUT["default_false"]}
        assert (await api("GET", "/field-intake/organizer"))["mode"] == "offline_sample"
        assert (await api("GET", "/field-intake/media-jobs"))["ready"] is False
        old = await api("GET", "/tasks/1")
        group = await api("GET", "/event-groups/1")
        assert group["group"]["worker_id"] == "worker:1" and group["group"]["pending_event_count"] == 1
        artifact, = old["artifacts"]
        assert artifact["attempt_id"] is None and artifact["task_id"] == old["task"]["id"] == 1
        exported = await api("GET", "/tasks/1/export")
        assert all(exported[k] == old[k] for k in ("task", "events", "artifacts", "approvals"))
        assert await api("GET", f"/artifacts/{artifact['id']}/download") == artifact
        manifest = json.loads(artifact["content"])
        images, prompt, root = load_attachments([artifact["content"]])
        assert images == [] and Path(root) == ATTACH and INPUT["attachment"]["text"] in prompt
        file = Path(manifest["local_path"])
        blob = file.read_bytes()
        file.write_bytes(blob.replace(b"A", b"B", 1))
        try:
            load_attachments([artifact["content"]])
        except ValueError as error:
            rejected = str(error)
            assert "校验" in rejected
        else:
            raise AssertionError("Changed attachment accepted")
        finally:
            file.write_bytes(blob)
        report["attachment"] = {"manifest":manifest,"prompt":prompt,"same_size_tamper_error":rejected}
        try:
            load_attachments([json.dumps(dict(manifest, local_path=str(PROJECT / file.name)))])
        except ValueError as error:
            assert "受管目录" in str(error)
            report["attachment"]["outside_root_error"] = str(error)
        else:
            raise AssertionError("Unmanaged attachment path accepted")
        report["legacy_task"] = old["task"]
        report["legacy_group"] = group["group"]
        old_delivery, = await api("GET", "/tasks/1/deliveries")
        assert old_delivery["delivery"]["write_status"] == "unknown"
        assert await api("POST", "/deliveries/1/publish") == old_delivery["delivery"]
        tool, channel = sorted(old["approvals"], key=lambda a:a["id"])
        assert tool["status"] == "pending" and channel["status"] == "approved"
        await api("POST", "/approvals/1/decision", {"decision":"reject","action_hash":"wrong"}, 409)
        acks = []

        class FakeWorker:
            async def respond_approval(self, ident, decision):
                acks.append([ident, decision])

        reject = {"decision":"reject","action_hash":tool["action_hash"]}
        with patch.dict(main.scheduler.clients, {1:FakeWorker()}):
            with patch.dict(os.environ, {"SUPERAGENT_EXECUTION_MODE":"attempt"}):
                await api("POST", "/approvals/1/decision", reject, 409)
                assert not acks
            assert (await api("POST", "/approvals/1/decision", reject))["status"] == "rejected"
            await api("POST", "/approvals/1/decision", reject, 409)
        assert acks == [[17, "reject"]]
        report["tool_acknowledgements"] = acks
        await api("POST", "/identities", dict(INPUT["identity"], project_ids=[1]))
        receipt = await api("POST", "/events", INPUT["event"])
        task_id, event_id = receipt["task_id"], receipt["id"]
        assert task_id and task_id != 1 and receipt["duplicate"] is False, receipt["data"].get("routing_reason")
        repeat = await api("POST", "/events", INPUT["event"])
        assert repeat["id"] == event_id and repeat["task_id"] == task_id and repeat["duplicate"] is True
        tasks = await api("GET", "/tasks")
        assert len(tasks) == 2
        group_path = f"/event-groups/{task_id}"
        group = await api("GET", group_path)
        assert group["group"]["pending_event_count"] == 1 and group["events"][0]["id"] == event_id
        version = group["group"]["state_version"]
        resolution = {"status":"resolved","evidence":"合成收据已核验","expected_state_version":version}
        route = f"{group_path}/events/{event_id}/resolution"
        await api("POST", route, resolution)
        await api("POST", route, resolution, 409)
        after = await api("GET", group_path)
        assert after["group"]["pending_event_count"] == 0 and after["events"][0]["processing"]["status"] == "resolved"
        report["group_check"] = {"before":group["group"],"after":after["group"],"event_id":event_id}
        reply_path = f"/tasks/{task_id}/deliveries"
        draft = await api("POST", reply_path, {"event_id":event_id,"content":INPUT["reply"]})
        approval = draft["approval"]
        assert draft["event_id"] == event_id and approval["id"] == draft["approval_id"]
        assert approval["action"]["target"] == {"issue_id":42,"base_url":INPUT["redmine"]["base_url"]}
        decision = {"action_hash":approval["action_hash"],"decision":"approve"}
        prefix = f"/deliveries/{draft['id']}"
        await api("POST", prefix + "/publish", status=409)
        await api("POST", f"/approvals/{approval['id']}/decision", decision, 409)
        await api("POST", prefix + "/decision", dict(decision, action_hash="wrong"), 409)
        assert (await api("POST", prefix + "/decision", decision))["status"] == "approved"
        await api("POST", prefix + "/publish", status=409)
        assert (await api("GET", reply_path))[0]["delivery"] is None
        await api("PATCH", "/settings", {"external_delivery_enabled":True})
        assert (await api("GET", "/settings"))["external_delivery_enabled"] is True
        await api("POST", prefix + "/publish", status=409)
        await api("PATCH", "/settings", {"external_delivery_enabled":"invalid"}, 422)

        async def fake_receiver(method, path, params, body):
            calls.append([method,path,body])
            return 204, {}

        enabled = dict(INPUT["redmine"], enabled=True)
        env = {"SUPERAGENT_REDMINE_CONFIG":json.dumps(enabled),"HLZJ_REDMINE_API_KEY":"fixture"}
        env.update({"SUPERAGENT_" + k:v for k,v in INPUT["enabled_modes"].items()})
        def fake_client(base_url, key):
            return RedmineClient(base_url, key, transport=fake_receiver)

        with patch.dict(os.environ, env), patch.object(redmine, "RedmineClient", fake_client):
            assert all(f() for f in flags)
            sent = await api("POST", prefix + "/publish")
            assert sent["write_status"] == "succeeded" and sent["action_hash"] == approval["action_hash"]
            assert await api("POST", prefix + "/publish") == sent
            assert await api("POST", "/deliveries/1/publish") == old_delivery["delivery"]
            note = {"task_id":task_id,"project_id":1,"event_id":event_id,"kind":"constraint",
                    "content":"只读核对离线证据"}
            saved = await api("POST", "/decisions", note, 201)
            def active_context_ids():
                with db.Session() as session:
                    view, _ = context.assemble_worker_context(session, session.get(db.Task, task_id))
                    return [item["id"] for item in view["decisions"]]
            assert active_context_ids() == [saved["id"]]
            revoked = await api("POST", f"/decisions/{saved['id']}/revoke", {"reason":"样本核对结束"})
            assert revoked["status"] == "revoked" and active_context_ids() == []
            report["modes"]["context_decision_ids"] = {"active":[saved["id"]],"after_revoke":[]}
        assert calls == [["PUT", "/issues/42.json", {"issue":{"notes":INPUT["reply"]}}]]
        await api("PATCH", "/settings", {"external_delivery_enabled":False})
        assert (await api("GET", "/settings"))["external_delivery_enabled"] is False
        new_delivery, = await api("GET", reply_path)
        assert new_delivery["delivery"] == sent
        report.update(legacy_delivery=old_delivery, new_delivery=new_delivery, fake_receiver=calls,
                      approval=approval, http=records)
    report["sqlite_after_reopen"] = persisted_sample()
    (WORK / "http-raw.json").write_text(json.dumps(raw, ensure_ascii=False, indent=2), "utf-8")
    return report


with asyncio.Runner(loop_factory=OfflineLoop) as runner:
    result = runner.run(create_legacy() if MODE == "legacy" else exercise())
db.engine.dispose()
assert not violations, violations
result["blocked_io_attempts"] = violations
result["runtime"] = {"python":sys.version.split()[0], "sqlite":sqlite3.sqlite_version,
                     "packages":{p:importlib.metadata.version(p) for p in
                                 ("fastapi","starlette","pydantic","SQLAlchemy","httpx","anyio")}}
(WORK / (MODE + ".json")).write_text(json.dumps(normalize(result), ensure_ascii=False), "utf-8")
