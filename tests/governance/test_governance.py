import json
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from starlette.requests import Request

from superagent.core import db, governance as g
from superagent.api.governance import router
from superagent.core.ingestion import ingest_event


@pytest.fixture
def store(tmp_path, monkeypatch):
    engine = create_engine(f"sqlite:///{tmp_path / 'governance.db'}", connect_args={"check_same_thread": False, "timeout": 30})
    db.Base.metadata.create_all(engine)
    monkeypatch.setattr(db, "Session", sessionmaker(engine, expire_on_commit=False))
    monkeypatch.delenv("SUPERAGENT_API_TOKEN", raising=False)
    monkeypatch.delenv("SUPERAGENT_USERS_JSON", raising=False)
    yield
    engine.dispose()


def request(host="localhost:8765", origin=None, client="127.0.0.1", token=None):
    headers = [(b"host", host.encode())]
    if origin:
        headers.append((b"origin", origin.encode()))
    if token:
        headers.append((b"authorization", ("Bearer " + token).encode()))
    return Request({"type": "http", "headers": headers, "client": (client, 123)})


@pytest.mark.parametrize("host,origin,client", [
    ("evil.example", None, "127.0.0.1"),
    ("localhost.evil.example", None, "127.0.0.1"),
    ("localhost", "https://evil.example", "127.0.0.1"),
    ("localhost", "null", "127.0.0.1"),
    ("localhost", None, "10.0.0.3"),
    ("localhost@evil.example", None, "127.0.0.1"),
    ("localhost", "http://evil@localhost", "127.0.0.1"),
    ("[::1]:broken", None, "::1"),
])
def test_local_rebinding_rejected(store, host, origin, client):
    with pytest.raises(HTTPException):
        g.authenticate_request(request(host, origin, client))


def test_auth_roles_fail_closed(store, monkeypatch):
    assert g.authenticate_request(request("[::1]:8765", "http://localhost:5173", "::1")).role == "admin"
    monkeypatch.setenv("SUPERAGENT_API_TOKEN", "test-admin")
    assert g.authenticate_request(request(client="10.0.0.3", token="test-admin")).role == "admin"
    with pytest.raises(HTTPException):
        g.authenticate_request(request())
    monkeypatch.setenv("SUPERAGENT_USERS_JSON", "invalid")
    with pytest.raises(HTTPException) as error:
        g.authenticate_request(request(token="test-admin"))
    assert error.value.status_code == 503


@pytest.mark.parametrize("role,action,owner,allowed", [
    ("viewer", "read", None, True), ("viewer", "task.create", None, False),
    ("viewer", "settings.write", None, False), ("member", "project.write", None, False),
    ("member", "task.create", None, True), ("member", "task.control", "alice", True),
    ("member", "task.approve", "bob", False), ("member", "task.write", None, False),
    ("member", "identity.write", "alice", False), ("admin", "task.control", None, True),
    ("admin", "invented.action", None, False),
])
def test_permissions(role, action, owner, allowed):
    principal = g.Principal("alice", role)
    if allowed:
        g.require_permission(principal, action, owner)
    else:
        with pytest.raises(HTTPException) as error:
            g.require_permission(principal, action, owner)
        assert error.value.status_code == 403


def test_routes_settings_identities_audit(store, monkeypatch):
    users = [{"user_id": name, "role": role, "token": f"test-{name}"} for name, role in [("root", "admin"), ("alice", "member"), ("reader", "viewer")]]
    monkeypatch.setenv("SUPERAGENT_USERS_JSON", json.dumps(users))
    app = FastAPI()
    app.include_router(router)
    with TestClient(app) as client:
        root = {"Authorization": "Bearer test-root"}
        viewer = {"Authorization": "Bearer test-reader"}
        assert client.get("/api/v1/settings").status_code == 401
        assert client.patch("/api/v1/settings", headers=viewer, json={"scheduler_enabled": True}).status_code == 403
        assert client.patch("/api/v1/settings", headers=root, json={"api_token": "forbidden"}).status_code == 422
        assert client.patch("/api/v1/settings", headers=root, json={"scheduler_enabled": "false"}).status_code == 422
        assert client.patch("/api/v1/settings", headers=root, json={"scheduler_enabled": True, "unknown": 2}).status_code == 422
        assert not g.get_setting("scheduler_enabled", False)
        assert client.patch("/api/v1/settings", headers=root, json={"scheduler_enabled": True}).status_code == 200
        assert g.get_setting("scheduler_enabled") is True
        assert client.get("/api/v1/auth/me", headers=viewer).json()["role"] == "viewer"
        body = {"source": "dingtalk", "actor_id": "actor-1", "user_id": "alice"}
        assert client.post("/api/v1/identities", headers=viewer, json=body).status_code == 403
        response = client.post("/api/v1/identities", headers=root, json=body)
        assert response.status_code == 200
        assert g.resolve_actor("dingtalk", "actor-1")["role"] == "member"
        assert g.resolve_actor("redmine", "actor-1") is None
        client.delete(f"/api/v1/identities/{response.json()['id']}", headers=root)
        assert g.resolve_actor("dingtalk", "actor-1") is None
        assert client.get("/api/v1/audit", headers=viewer).status_code == 403
        payload = client.get("/api/v1/audit", headers=root).text
        assert "test-root" not in payload and "test-alice" not in payload and "forbidden" not in payload
        assert len(json.loads(payload)) == 3


def test_owner_persistence(store, monkeypatch):
    monkeypatch.setenv("SUPERAGENT_USERS_JSON", json.dumps([{"user_id": "alice", "role": "member", "token": "test-alice"}]))
    with db.Session.begin() as session:
        task = db.Task(title="test", goal="test", project_id=1)
        session.add(task)
        session.flush()
        task_id = task.id
        g.assign_task_owner(task_id, "alice", session=session)
    assert g.task_owner(task_id) == "alice"
    g.require_permission(g.Principal("alice", "member"), "task.control", g.task_owner(task_id))


def test_budget_concurrent_atomic_limit_and_idempotency(store):
    g.configure_budget("global", 100)
    def reserve(index):
        try:
            return g.reserve_budget("global", str(index), 30, "explicit test estimate")
        except HTTPException as error:
            assert error.status_code == 409
            return None
    with ThreadPoolExecutor(max_workers=12) as pool:
        results = list(pool.map(reserve, range(24)))
    accepted = [row for row in results if row]
    assert len(accepted) == 3
    with ThreadPoolExecutor(max_workers=12) as pool:
        duplicate = list(pool.map(lambda _: g.reserve_budget("global", accepted[0]["request_key"], 30, "explicit test estimate"), range(24)))
    assert len({row["id"] for row in duplicate}) == 1
    with db.Session() as session:
        account = session.get(g.BudgetAccount, "global")
        assert account.reserved_micros == 90 and account.spent_micros == 0
        assert len(session.scalars(select(g.BudgetReservation)).all()) == 3


def test_budget_unknown_and_concurrent_settlement(store):
    g.configure_budget("global", 100)
    reservation = g.reserve_budget("global", "turn-1", 70, "token estimate with price table v1")
    assert g.settle_budget(reservation["id"])["status"] == "unknown"
    with pytest.raises(HTTPException):
        g.reserve_budget("global", "turn-2", 40, "explicit estimate")
    usage = {"input_tokens": 30, "output_tokens": 10, "source": "codex usage", "pricing_version": "v1"}
    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(lambda _: g.settle_budget(reservation["id"], 110, usage), range(16)))
    assert all(row["status"] == "settled" for row in results)
    with db.Session() as session:
        account = session.get(g.BudgetAccount, "global")
        assert account.reserved_micros == 0 and account.spent_micros == 110
    with pytest.raises(HTTPException):
        g.reserve_budget("global", "turn-3", 1, "explicit estimate")
    with pytest.raises(HTTPException):
        g.settle_budget(reservation["id"], 100, usage)
    with pytest.raises(HTTPException):
        g.configure_budget("global", 200, currency="CNY")


@pytest.mark.parametrize("amount,basis", [(None, "unknown"), (0, "unknown"), (-1, "test"), (True, "test"), (1, "")])
def test_budget_invalid_estimates(store, amount, basis):
    g.configure_budget("global", 100)
    with pytest.raises(HTTPException):
        g.reserve_budget("global", "turn-1", amount, basis)


def test_budget_requires_usage_and_rejects_secrets(store):
    g.configure_budget("global", 100)
    row = g.reserve_budget("global", "turn-1", 10, "explicit estimate")
    for usage in [None, {}, {"api_token": "secret"}]:
        with pytest.raises(HTTPException):
            g.settle_budget(row["id"], 5, usage)
    assert g.get_setting("missing", "fallback") == "fallback"


def test_browser_login_cookie_roles_logout_and_rotation(store, monkeypatch):
    users = [{"user_id": "alice", "role": "member", "token": "login-test-token"}]
    monkeypatch.setenv("SUPERAGENT_USERS_JSON", json.dumps(users))
    app = FastAPI()
    app.include_router(router)
    with TestClient(app, base_url="https://service.example") as client:
        assert client.post("/api/v1/auth/login", json={"token": "wrong"}).status_code == 401
        bad = client.post("/api/v1/auth/login", json={"token": {"secret": "do-not-echo"}})
        assert bad.status_code == 422 and "do-not-echo" not in bad.text
        assert client.post("/api/v1/auth/login", headers={"Origin": "https://evil.example"}, json={"token": "login-test-token"}).status_code == 403
        response = client.post("/api/v1/auth/login", headers={"Origin": "https://service.example"}, json={"token": "login-test-token"})
        assert response.status_code == 200
        header = response.headers["set-cookie"]
        assert "HttpOnly" in header and "SameSite=strict" in header and "Secure" in header and "Max-Age=3600" in header
        assert "login-test-token" not in response.text + header
        assert client.get("/api/v1/auth/me").json() == {"user_id": "alice", "role": "member", "authentication": "session"}
        assert client.patch("/api/v1/settings", json={"scheduler_enabled": True}).status_code == 403
        assert client.patch("/api/v1/settings", headers={"Origin": "https://evil.example"}, json={}).status_code == 403
        users[0]["role"] = "viewer"
        monkeypatch.setenv("SUPERAGENT_USERS_JSON", json.dumps(users))
        assert client.get("/api/v1/auth/me").json()["role"] == "viewer"
        assert client.post("/api/v1/auth/logout", headers={"Origin": "https://evil.example"}).status_code == 403
        assert client.post("/api/v1/auth/logout", headers={"Origin": "https://service.example"}).status_code == 200
        assert client.get("/api/v1/auth/me").status_code == 401
        client.post("/api/v1/auth/login", json={"token": "login-test-token"})
        users[0]["token"] = "rotated-token"
        monkeypatch.setenv("SUPERAGENT_USERS_JSON", json.dumps(users))
        assert client.get("/api/v1/auth/me").status_code == 401


def test_session_tampering_expiry_and_https_required(store, monkeypatch):
    monkeypatch.setenv("SUPERAGENT_API_TOKEN", "test-session-token")
    cookie, principal = g.issue_session("test-session-token")
    assert principal.role == "admin"
    with pytest.raises(HTTPException):
        g._authenticate_session(cookie + "x")
    monkeypatch.setattr(g.time, "time", lambda: 999999999999)
    with pytest.raises(HTTPException):
        g._authenticate_session(cookie)
    app = FastAPI()
    app.include_router(router)
    with TestClient(app, base_url="http://external.example") as client:
        assert client.post("/api/v1/auth/login", json={"token": "test-session-token"}).status_code == 400


def test_local_cookie_and_explicit_origin_allowlist(store, monkeypatch):
    monkeypatch.setenv("SUPERAGENT_API_TOKEN", "test-session-token")
    app = FastAPI()
    app.include_router(router)
    with TestClient(app, base_url="http://localhost:8765") as client:
        origin = {"Origin": "http://localhost:5173"}
        assert client.post("/api/v1/auth/login", headers=origin, json={"token": "test-session-token"}).status_code == 403
        monkeypatch.setenv("SUPERAGENT_ALLOWED_ORIGINS", "http://localhost:5173")
        response = client.post("/api/v1/auth/login", headers=origin, json={"token": "test-session-token"})
        assert response.status_code == 200
        assert "Secure" not in response.headers["set-cookie"]
        assert client.get("/api/v1/auth/me").status_code == 200
        assert client.patch("/api/v1/settings", headers=origin, json={"scheduler_enabled": True}).status_code == 200


def test_real_identity_grants_route_only_authorized_projects(store, monkeypatch):
    users = [{"user_id": "alice", "role": "member", "token": "test-member"}]
    monkeypatch.setenv("SUPERAGENT_USERS_JSON", json.dumps(users))
    with db.Session.begin() as session:
        project = db.Project(name="test", repo_path="unused", dingtalk_chat_ids=["chat-1"])
        session.add(project)
        session.flush()
        project_id = project.id
    g.map_actor("dingtalk", "actor-1", "alice")
    def emit(external_id):
        return ingest_event({"source": "dingtalk", "actor_id": "actor-1", "external_id": external_id,
                             "project_external_id": "chat-1", "event_type": "message.received", "content": "请分析项目问题"}, session_factory=db.Session)
    assert emit("default-denied")["data"]["routing_status"] == "pending_confirmation"
    g.map_actor("dingtalk", "actor-1", "alice", project_ids=[project_id])
    assert emit("no-request")["data"]["routing_status"] == "pending_confirmation"
    g.map_actor("dingtalk", "actor-1", "alice", project_ids=[project_id], permissions=["request"])
    result = emit("authorized")
    assert result["data"]["routing_status"] == "routed"
    assert g.task_owner(result["task_id"]) == "alice"
    users[0]["role"] = "viewer"
    monkeypatch.setenv("SUPERAGENT_USERS_JSON", json.dumps(users))
    assert emit("viewer-denied")["data"]["routing_status"] == "pending_confirmation"
    with pytest.raises(HTTPException):
        g.map_actor("dingtalk", "actor-1", "alice", project_ids=[999999], permissions=["request"])
    with pytest.raises(HTTPException):
        g.map_actor("dingtalk", "actor-1", "alice", project_ids=[project_id], permissions=["admin"])


def test_global_budget_setting_updates_account_atomically(store):
    g.set_setting("budget_hard_limit_micros", 100)
    g.reserve_budget("global", "one", 60, "explicit estimate")
    g.set_setting("budget_hard_limit_micros", 50)
    with pytest.raises(HTTPException):
        g.reserve_budget("global", "two", 1, "explicit estimate")
    g.configure_budget("global", 200)
    assert g.get_setting("budget_hard_limit_micros") == 200


def test_settings_roundtrip_real_connection_manager(store, monkeypatch):
    from superagent.core.connections import ConnectionManager
    monkeypatch.setenv("TEST_REDMINE_CREDENTIAL", "never-return-this-secret")
    monkeypatch.setenv("SUPERAGENT_API_TOKEN", "test-token")
    app = FastAPI()
    app.include_router(router)
    redmine = {"enabled": True, "base_url": "https://redmine.example", "project_ids": [7],
               "user_id": 12, "api_key_env": "TEST_REDMINE_CREDENTIAL", "poll_seconds": 45,
               "initial_since": "2026-11-13T00:00:00Z", "account_map": {"alice": [12]}}
    dingtalk = {"enabled": True, "executable": "dws", "profile": "work", "self_ids": ["self-open-id"],
                "kind": "group", "chat_id": "chat-7"}
    with TestClient(app, headers={"Authorization": "Bearer test-token"}) as client:
        response = client.patch("/api/v1/settings", json={"connectors.redmine": redmine, "connectors.dingtalk": dingtalk,
                                                        "codex_model": "gpt-6.1-sol", "codex_effort": "high", "scheduler_enabled": True,
                                                        "max_concurrent_tasks": 3, "budget_hard_limit_micros": 1000,
                                                        "budget_reservation_estimate_micros": 100})
        assert response.status_code == 200
        assert response.json()["connectors.redmine"] == redmine
        manager = ConnectionManager(session_factory=db.Session)
        assert manager.config("redmine") == redmine
        assert manager.config("dingtalk") == dingtalk
        assert manager.configured("redmine") and manager.configured("dingtalk")
        assert g.get_setting("scheduler_enabled") is True
        assert g.get_setting("codex_model") == "gpt-6.1-sol"
        assert g.get_setting("codex_effort") == "high"
        assert g.get_setting("budget_reservation_estimate_micros") == 100
        assert "never-return-this-secret" not in response.text
        assert client.patch("/api/v1/settings", json={"redmine_enabled": False}).status_code == 200
        assert manager.config("redmine") == redmine | {"enabled": False}
        assert not client.get("/api/v1/settings").json()["redmine_enabled"]
        assert client.patch("/api/v1/settings", json={"redmine_enabled": True, "connectors.redmine": redmine | {"enabled": False}}).status_code == 422
        audit = client.get("/api/v1/audit").text
        assert "never-return-this-secret" not in audit


def test_dingtalk_history_configuration_via_settings_matches_manager(store, monkeypatch):
    from superagent.core.connections import ConnectionManager
    monkeypatch.setenv("SUPERAGENT_API_TOKEN", "test-token")
    config = {
        "enabled": False,
        "executable": "dws",
        "profile": "work",
        "self_ids": ["self-open-id"],
        "kind": "group",
        "chat_id": "chat-7",
        "history": {
            "chat_ids": ["chat-7"],
            "initial_since": "2026-11-13T00:00:00Z",
            "history_timezone": "+08:00",
            "sender_map": {"history-user-id": "external-open-id"},
            "page_limit": 20,
            "timeout": 60,
        },
    }
    app = FastAPI()
    app.include_router(router)
    with TestClient(app, headers={"Authorization": "Bearer test-token"}) as client:
        saved = client.patch("/api/v1/settings", json={"connectors.dingtalk": config})
        assert saved.status_code == 200
        assert saved.json()["connectors.dingtalk"] == config
        snapshot = client.get("/api/v1/settings").json()
        assert snapshot["connectors.dingtalk"] == config
        assert snapshot["codex_effort"] == "medium"
        assert "codex_reasoning_effort" not in snapshot
        assert set(snapshot) == set(g.SETTING_DEFAULTS) | {"authentication_required"}
        manager = ConnectionManager(session_factory=db.Session)
        assert manager.config("dingtalk") == config
        assert manager.configured("dingtalk")
        assert not manager.instances  # Saving configuration never starts a real account.


@pytest.mark.parametrize("key,value", [
    ("connectors.redmine", {"api_key": "forbidden-secret"}),
    ("connectors.redmine", {"base_url": "https://user:password@redmine.example"}),
    ("connectors.redmine", {"base_url": "https://redmine.example?token=forbidden-secret"}),
    ("connectors.redmine", {"api_key_env": "not a variable"}),
    ("connectors.redmine", {"poll_seconds": 0}),
    ("connectors.redmine", {"poll_seconds": True}),
    ("connectors.redmine", {"project_ids": [True]}),
    ("connectors.redmine", {"user_id": "12"}),
    ("connectors.redmine", {"initial_since": "2026-11-13T00:00:00"}),
    ("connectors.redmine", {"account_map": {"alice": "12"}}),
    ("connectors.redmine", {"enabled": True}),
    ("connectors.dingtalk", {"executable": ["dws", "--token=forbidden-secret"]}),
    ("connectors.dingtalk", {"self_ids": []}),
    ("connectors.dingtalk", {"kind": "group"}),
    ("connectors.dingtalk", {"kind": "at-me", "chat_id": "unexpected"}),
    ("connectors.dingtalk", {"enabled": "false"}),
    ("codex_model", "model with spaces"),
    ("codex_effort", []),
    ("codex_effort", "unsupported"),
    ("max_concurrent_tasks", 5),
])
def test_invalid_runtime_configuration_is_atomic(store, key, value):
    with pytest.raises(HTTPException) as error:
        g.update_settings({"scheduler_enabled": True, key: value})
    assert error.value.status_code == 422
    assert "forbidden-secret" not in str(error.value.detail)
    assert g.get_setting("scheduler_enabled", False) is False


def test_environment_connector_settings_filtered_and_alias_preserved(store, monkeypatch):
    config = {"enabled": False, "executable": "dws", "profile": "work", "self_ids": ["self"]}
    monkeypatch.setenv("SUPERAGENT_DINGTALK_CONFIG", json.dumps(config))
    assert g.settings_snapshot()["connectors.dingtalk"] == config
    g.set_setting("dingtalk_enabled", True)
    assert g.get_setting("connectors.dingtalk") == config | {"enabled": True}
    monkeypatch.setenv("SUPERAGENT_REDMINE_CONFIG", json.dumps({"base_url": "https://user:forbidden-secret@example.com"}))
    assert g.settings_snapshot()["connectors.redmine"] == {"enabled": False}


def test_codex_defaults_and_unknown_alias_rejected(store):
    snapshot = g.settings_snapshot()
    assert snapshot["codex_model"] == "gpt-6.1-sol"
    assert snapshot["codex_effort"] == "medium"
    g.set_setting("codex_effort", "high")
    assert g.get_setting("codex_effort") == "high"
    with pytest.raises(HTTPException):
        g.update_settings({"codex_reasoning_effort": "low", "codex_effort": "ultra"})


def test_manual_budget_reconciliation_http_permissions_audit_idempotency(store, monkeypatch):
    monkeypatch.setenv("SUPERAGENT_USERS_JSON", json.dumps([
        {"user_id": "root", "role": "admin", "token": "test-root"},
        {"user_id": "alice", "role": "member", "token": "test-member"},
    ]))
    g.configure_budget("global", 1000)
    reservation = g.reserve_budget("global", "turn", 100, "explicit manual reservation")
    g.settle_budget(reservation["id"])
    app = FastAPI()
    app.include_router(router)
    path = f"/api/v1/budget-reservations/{reservation['id']}/reconcile"
    body = {"actual_micros": 60, "evidence": "供应商账单 line 12，确认金额 0.000060 USD"}
    with TestClient(app) as client:
        root = {"Authorization": "Bearer test-root"}
        member = {"Authorization": "Bearer test-member"}
        assert client.get("/api/v1/budget-reservations", headers=member).status_code == 403
        assert client.post(path, headers=member, json=body).status_code == 403
        assert client.post(path, headers=root, json={"actual_micros": 60}).status_code == 422
        assert client.post(path, headers=root, json={"actual_micros": 60, "evidence": " "}).status_code == 422
        assert client.post(path, headers=root, json=body | {"actual_micros": True}).status_code == 422
        rows = client.get("/api/v1/budget-reservations?account_id=global&status=unknown", headers=root).json()
        assert [row["id"] for row in rows] == [reservation["id"]]
        assert rows[0]["actual_micros"] is None
        first = client.post(path, headers=root, json=body)
        assert first.status_code == 200 and first.json()["actual_micros"] == 60
        assert client.post(path, headers=root, json=body).json() == first.json()
        assert client.post(path, headers=root, json=body | {"actual_micros": 80}).status_code == 409
        assert client.post(path, headers=root, json=body | {"evidence": "其他依据"}).status_code == 409
        accounts = client.get("/api/v1/budgets", headers=root).json()
        assert accounts[0]["spent_micros"] == 60 and accounts[0]["reserved_micros"] == 0
        audits = client.get("/api/v1/audit", headers=root).json()
        settlements = [row for row in audits if row["action"] == "budget.settle"]
        assert len(settlements) == 1
        assert settlements[0]["actor"] == "root"
        assert settlements[0]["details"]["usage"]["evidence"] == body["evidence"]
