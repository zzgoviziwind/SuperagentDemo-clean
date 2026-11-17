"""Offline integration review reproducers. Assertions document observed defects."""

import asyncio
import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from superagent import main
from superagent.core import db, governance, ingestion
from superagent.runtime.codex import CodexAppServer


def store(monkeypatch, tmp_path):
    engine = create_engine("sqlite://", poolclass=StaticPool)
    sessions = sessionmaker(engine, expire_on_commit=False)
    db.Base.metadata.create_all(engine)
    monkeypatch.setattr(db, "Session", sessions)
    monkeypatch.setattr(main, "Session", sessions)
    monkeypatch.setenv("SUPERAGENT_USERS_JSON", json.dumps([
        {"user_id": "alice", "role": "admin", "token": "offline-only"}
    ]))
    request = SimpleNamespace(state=SimpleNamespace(principal=governance.Principal("alice", "admin")))
    with sessions.begin() as session:
        project = db.Project(name="offline", repo_path=str(tmp_path), allowed_paths=["."], dingtalk_chat_ids=["chat"])
        session.add(project)
        session.flush()
        project_id = project.id
    return sessions, request, project_id


@pytest.mark.parametrize("response_fails", [False, True])
def test_approval_response_preserves_new_revision(monkeypatch, tmp_path, response_fails):
    sessions, request, project_id = store(monkeypatch, tmp_path)
    with sessions.begin() as session:
        task = db.Task(title="first", goal="first", project_id=project_id,
                       status="waiting_approval", owner_id="alice", workspace_path=str(tmp_path))
        session.add(task)
        session.flush()
        task_id = task.id
        session.add(ingestion.TaskRoute(project_id=project_id, route_key="issue:42", task_id=task_id))
        approval = db.Approval(task_id=task_id, revision=1, control_version=1,
                               action_hash="offline", action={
                                   "method": "item/commandExecution/requestApproval", "request_id": 10})
        session.add(approval)
        session.flush()
        approval_id = approval.id

    class RacingClient:
        async def respond_approval(self, *_):
            receipt = ingestion.ingest_event({
                "source": "dingtalk", "external_id": "new-direction", "actor_id": "external-alice",
                "event_type": "message.received", "project_external_id": "chat",
                "thread_id": "chat", "content": "请修复 #42，采用新的实现方向",
            }, session_factory=sessions, actor_resolver=lambda *_: {
                "user_id": "alice", "role": "admin", "project_ids": [project_id], "permissions": ["request"]})
            with sessions() as session:
                task = session.get(db.Task, task_id)
                assert receipt["task_id"] == task_id
                assert task.revision == 2
                assert task.status == "waiting_input"
            if response_fails:
                raise RuntimeError("offline response delivery failed after newer request")

    monkeypatch.setitem(main.scheduler.clients, task_id, RacingClient())
    with pytest.raises(HTTPException) as error:
        asyncio.run(main.decide(approval_id, main.DecisionIn(decision="approve", action_hash="offline"), request))
    assert error.value.status_code == (503 if response_fails else 409)
    with sessions() as session:
        task = session.get(db.Task, task_id)
        approval = session.get(db.Approval, approval_id)
        print("RACE_RESULT", task.status, task.revision, approval.status, approval.revision)
        if response_fails:
            assert task.status == "waiting_input"
            assert task.revision == 2
            assert task.outcome_unknown
            assert approval.status == "unknown"
        else:
            assert (task.status, task.revision, approval.status, approval.revision) == ("waiting_input", 2, "expired_after_dispatch", 1)


def test_review_ready_supplement_can_be_accepted_without_execution(monkeypatch, tmp_path):
    sessions, request, project_id = store(monkeypatch, tmp_path)
    with sessions.begin() as session:
        task = db.Task(title="analysis", goal="analyze", kind="analysis", project_id=project_id,
                       status="review_ready", owner_id="alice")
        session.add(task)
        session.flush()
        task_id = task.id

    asyncio.run(main.message(task_id, main.MessageIn(content="请补充检查线程安全，完成后才能验收"), request))
    with pytest.raises(HTTPException) as error:
        main.accept(task_id, main.AcceptanceIn(accepted=True, revision=1), request)
    assert error.value.status_code == 409
    with sessions() as session:
        task = session.get(db.Task, task_id)
        assert task.status == "waiting_input"
        assert task.revision == 2


def test_analysis_acceptance_rechecks_read_only_workspace(monkeypatch, tmp_path):
    import subprocess
    from superagent.runtime.workspace import collect_changes
    sessions, request, project_id = store(monkeypatch, tmp_path)
    def git(*args):
        return subprocess.check_output(['git', '-C', str(tmp_path), *args], stderr=subprocess.STDOUT)
    git('init', '-b', 'main')
    git('config', 'user.name', '离线验收')
    git('config', 'user.email', 'offline@example.invalid')
    (tmp_path / 'code.txt').write_text('original', encoding='utf-8')
    git('add', 'code.txt')
    git('commit', '-m', 'test（common）：创建只读验收基线')
    evidence = collect_changes(tmp_path)
    with sessions.begin() as session:
        task = db.Task(title='read only', goal='analyze', kind='analysis', project_id=project_id,
                       status='review_ready', owner_id='alice', workspace_path=str(tmp_path))
        session.add(task)
        session.flush()
        task_id = task.id
        session.add(db.Artifact(task_id=task_id, revision=1, kind='changes', content=json.dumps(evidence)))
    (tmp_path / 'code.txt').write_text('changed after analysis', encoding='utf-8')
    with pytest.raises(HTTPException) as error:
        main.accept(task_id, main.AcceptanceIn(accepted=True, revision=1), request)
    assert error.value.status_code == 409
    with sessions() as session:
        assert session.get(db.Task, task_id).status == 'review_ready'
    (tmp_path / 'code.txt').write_text('original', encoding='utf-8')
    assert main.accept(task_id, main.AcceptanceIn(accepted=True, revision=1), request)['status'] == 'completed'


def test_analysis_cannot_approve_expanded_execution(monkeypatch, tmp_path):
    sessions, request, project_id = store(monkeypatch, tmp_path)
    with sessions.begin() as session:
        task = db.Task(title='read only', goal='analyze', kind='analysis', project_id=project_id,
                       status='waiting_approval', owner_id='alice', workspace_path=str(tmp_path))
        session.add(task)
        session.flush()
        approval = db.Approval(task_id=task.id, revision=1, control_version=1, action_hash='offline',
                               action={'method':'item/commandExecution/requestApproval','request_id':11})
        session.add(approval)
        session.flush()
        approval_id = approval.id
    with pytest.raises(HTTPException) as error:
        asyncio.run(main.decide(approval_id, main.DecisionIn(decision='approve', action_hash='offline'), request))
    assert error.value.status_code == 409
    with sessions() as session:
        assert session.get(db.Approval, approval_id).status == 'pending'


def test_codex_process_does_not_inherit_control_credentials(monkeypatch, tmp_path):
    monkeypatch.setenv("SUPERAGENT_CODEX_HOME", str(tmp_path / "service-home"))
    monkeypatch.setenv("SUPERAGENT_API_TOKEN", "offline-admin-sentinel")
    monkeypatch.setenv("SUPERAGENT_USERS_JSON", "offline-users-sentinel")
    monkeypatch.setenv("HLZJ_REDMINE_API_KEY", "offline-redmine-sentinel")

    async def scenario():
        server = Path(__file__).with_name("fake_env_server.py")
        client = CodexAppServer([sys.executable, str(server)], str(tmp_path))
        try:
            await client.start()
            thread = await client.start_thread(str(tmp_path))
            inherited = thread["control_credentials_inherited"]
            print("CONTROL_CREDENTIALS_INHERITED", inherited)
            assert not any(inherited.values())
        finally:
            await client.close()

    asyncio.run(scenario())
