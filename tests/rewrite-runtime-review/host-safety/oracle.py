"""Run frozen Python recovery or stop a synthetic writer at the durable dispatch boundary."""
import json
import os
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[3]
work = Path(sys.argv[2]).resolve()
assert Path(__file__).resolve().parent in work.parents
source = root / ".rewrite-oracle"
filename = work / "superagent.db"
mode = sys.argv[1]
prepared = mode.startswith("prepared-")
mode = mode.removeprefix("prepared-")
os.environ.update(SUPERAGENT_DATABASE_URL="sqlite:///" + filename.as_posix(),
                  SUPERAGENT_STATE_ROOT=str(work), SUPERAGENT_EXECUTION_MODE="attempt",
                  SUPERAGENT_SERVICE_MODE="preview", SUPERAGENT_API_TOKEN="test-local")
if mode == "stock":
    os.environ.pop("SUPERAGENT_EXECUTION_MODE")
if mode not in ("default","stock"):
    os.environ["SUPERAGENT_LEDGER_MODE"] = "v2"
sys.path.insert(0, str(source))
from superagent.core import db, delivery, execution
from superagent.core import governance  # Register the frozen permission tables.

assert Path(delivery.__file__).resolve().is_relative_to(source)
assert Path(db.engine.url.database).resolve() == filename
db.init_db()
lease = execution.ControllerLease("fixture-python", db.Session)
if mode != "stock" and not prepared:
    lease.acquire()


def sync(coro):
    """These ledger methods only use synchronous SQLite and never suspend for I/O."""
    try:
        coro.send(None)
    except StopIteration as finished:
        return finished.value
    raise AssertionError("Unexpected asynchronous operation")


if mode == "crash":
    with db.Session.begin() as session:
        project = db.Project(name="sample", repo_path=str(work), allowed_paths=["."])
        session.add(project)
        session.flush()
        task = db.Task(project_id=project.id, title="sample", goal="sample", kind="repair", owner_id="owner",
                       status="queued", source="redmine")
        session.add(task)
        session.flush()
        event = db.Event(task_id=task.id, source="redmine", external_id="sample", event_type="issue.comment",
                         content="sample", data={"routing_status": "routed", "issue_id": "33",
                                                "metadata": {"redmine_endpoint": "https://offline.invalid"}})
        session.add(event)
        session.flush()
        task_id, event_id = task.id, event.id
    settings = {"connectors.redmine": {"base_url": "https://offline.invalid", "user_id": 7, "enabled": True},
                "external_delivery_enabled": True}.get
    draft = delivery.create_draft(task_id, event_id, "sample", settings=settings)
    approval = draft["approval"]
    delivery.decide_draft(draft["id"], "approve", approval["action_hash"])
    ledger = delivery.PersistentActionLedger(settings=settings)
    action_id = "reply-" + str(approval["id"])
    assert sync(ledger.claim(action_id, approval["action_hash"]))
    assert sync(ledger.mark_dispatching(action_id))
    attempt = execution.claim_task(task_id, lease.owner, lease=lease)
    with db.Session.begin() as session:
        assert execution.begin_attempt(session, task_id, attempt, lease.owner)
        assert execution.set_attempt(session, attempt, lease.owner, status="waiting_approval", phase="turn",
                                     thread_id="t1", turn_id="v1")
        execution.advance_task(session, session.get(db.Task, task_id), status="waiting_approval")
        session.add(db.Approval(task_id=task_id, revision=1, control_version=1, status="dispatching",
                                action={"method": "item/commandExecution/requestApproval"}, action_hash="sample"))
    with (work / "receipt.txt").open("x", encoding="utf-8") as receipt:
        receipt.write("one simulated write\n")
    os._exit(73)

try:
    if mode == "stock" or prepared:
        import asyncio
        from unittest.mock import patch
        from superagent import main
        class AfterRecovery(Exception):
            pass
        async def stop_before_background_services():
            raise AfterRecovery
        with patch.object(main.operations, "start", stop_before_background_services):
            try:
                asyncio.run(main.lifespan(main.app).__aenter__())
            except AfterRecovery:
                pass
            else:
                raise AssertionError("Frozen Host did not reach the post-recovery checkpoint")
        counts = None
    else:
        with db.Session.begin() as session:
            lease.check(session)
            counts = execution.recover_startup(session)
        delivery.recover_claimed(session_factory=db.Session, exclusive=True)
    with db.Session.begin() as session:
        task = session.get(db.Task, 1)
        attempt = session.query(db.ExecutionAttempt).one()
        tool = next(a for a in session.query(db.Approval) if "method" in a.action)
        record = session.query(delivery.DeliveryRecord).one()
        action_id, action_hash = record.action_id, record.action_hash
        result = {"task": task.status, "unknown": bool(task.outcome_unknown), "attempt": attempt.status,
                  "approval": tool.status, "ledger": record.result["write_status"], "token_cleared": record.claim_token is None,
                  "counts": counts, "mode": mode}
    assert execution.claim_task(1, lease.owner, lease=None if mode == "stock" or prepared else lease) is None
    assert not sync(delivery.PersistentActionLedger().claim(action_id, action_hash))
    if result["ledger"] == "dispatching":
        try:
            delivery.reconcile_delivery(1, "succeeded", "one synthetic receipt")
        except ValueError as error:
            result["manual_reconciliation"] = str(error)
        else:
            raise AssertionError("Reconciliation unexpectedly changed a dispatching ledger")
    if prepared:
        import httpx
        async def manual():
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app),
                    base_url="http://localhost",headers={"authorization":"Bearer test-local"}) as api:
                observation = (await api.get("/api/v1/tasks/1/deliveries")).json()[0]["delivery"]
                assert observation["write_status"] == "unknown"
                evidence = "offline receipt " + sys.argv[3]
                answer = await api.post("/api/v1/deliveries/1/reconcile",json={"outcome":"succeeded","evidence":evidence})
                assert answer.status_code == 200, (answer.status_code,answer.text)
                assert answer.json()["reconciliation_evidence"] == evidence
                replay = await api.post("/api/v1/deliveries/1/publish")
                assert replay.status_code == 200 and replay.json() == answer.json()
                return {"before":observation["write_status"],"http":answer.status_code,
                        "after":answer.json()["write_status"],"replay_http":replay.status_code}
        result["manual"] = asyncio.run(manual())
    print(json.dumps(result))
finally:
    lease.release()
