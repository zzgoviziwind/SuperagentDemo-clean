"""Run scheduler, ownership and rollback checks against the pinned process and one private SQLite file."""
import argparse
from collections import Counter
from contextlib import closing
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import phase1
import replay119 as base
import replay_bundle
import stage0


def owners(port, work):
    expected = {"admin": {1, 10, 11, 12, 13, 14, 15}, "alice": {1}, "bob": {15}, "viewer": set()}
    results = {}
    for role, visible in expected.items():
        def get(path):
            return base.request_http(port, "GET", path, None, role, work)
        listing = get("/tasks")
        assert listing["status"] == 200 and {r["id"] for r in listing["body"]} == visible
        stats = get("/overview")
        counts = dict(Counter(r["status"] for r in listing["body"]))
        assert stats["status"] == 200 and stats["body"]["counts"] == counts
        checks = {}
        for task, paths in [(1, ["/tasks/1", "/tasks/1/export", "/artifacts/1", "/artifacts/1/download"]),
                            (15, ["/tasks/15", "/tasks/15/export"])]:
            for path in paths:
                res = get(path)
                checks[path] = res["status"]
                if task in visible:
                    assert res["status"] == 200
                else:
                    assert res["status"] in (403, 404) and set(res["body"]) == {"detail"}
        results[role] = {"tasks": sorted(visible), "counts": counts, "statuses": checks}
    return results


def cli(node, work):
    cmd = [node, work/"host-dist/main.js", "--prepare-python-rollback"]
    env = base.environment(work) | {"SUPERAGENT_DATA_DIR": str(work), "SUPERAGENT_DRIVER": "fixture"}
    return subprocess.run(cmd, cwd=work, env=env, capture_output=True, encoding="utf-8", errors="replace",
                          timeout=15, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--seed-run", required=True, type=Path)
    parser.add_argument("--node", required=True, type=Path)
    args = parser.parse_args()
    bundle = replay_bundle.load_run(args.seed_run)
    with replay_bundle.publish(bundle,"recovery") as output:
        passed = run_recovery(args,bundle,output)
    if not passed:
        raise SystemExit("Rollback state differs; see " + str(bundle.archive()/"recovery/recovery.json"))


def run_recovery(args,bundle,output):
    seedrun = bundle.work
    work = Path(tempfile.mkdtemp(dir=HERE, prefix="phase1-run-119-recovery-"))/"python"
    base.clone(seedrun/"seed", work)
    file = work/"superagent.db"
    identity = file.stat().st_ino
    print("Recovery root", work, flush=True)
    with closing(sqlite3.connect(file)) as db:
        db.execute("UPDATE tasks SET owner_id='local-admin' WHERE id=1")
        db.execute("UPDATE governance_task_owners SET user_id='alice' WHERE task_id=1")
        db.execute("UPDATE tasks SET status='waiting_resource', outcome_unknown=0 WHERE id=15")
        db.commit()
    report = {"entry_sha256": bundle.files["main.js"], "dist_sha256":bundle.digest,
              "seed_sha256":base.read(seedrun/"run.json")["seed_sha256"], "root": str(work)}
    with base.service("ts", work, args.node, report,bundle) as port:
        report["owners"] = owners(port, work)
        busy = cli(args.node, work)
        assert busy.returncode and "租约仍有效" in busy.stderr and not (work/"rollback-backups").exists(), busy.stderr[-800:]
        report["live_rollback"] = {"exit": busy.returncode, "backup_files": 0, "reason": "原控制器的租约仍有效"}
        settings = base.request_http(port, "PATCH", "/settings", {"watchdog_enabled": True}, "admin", work)
        assert settings["status"] == 200
        query = """SELECT id,status,tree_exited,evidence_source,thread_id,turn_id FROM workbench_model_runs
                   WHERE kind='watchdog' AND scope_id=15 AND status IN ('completed','failed','unknown')"""
        run = phase1.wait_for(lambda: phase1.sqlite_read(work, query), 40)[0]
        assert run[1:4] == ("completed", 1, "offline-codex-fixture") and run[4] and run[5], run
        res = base.request_http(port, "GET", "/operations/watchdog?task_id=15", None, "admin", work)
        rec = next(row for row in res["body"]["items"] if row["id"] == run[0])
        assert res["status"] == 200 and rec["status"] == "completed" and rec["conclusion"]["action"] == "observe"
        report["timer"] = {"model_run": run, "watchdog": rec, "manual_run_calls": 0}
        assert base.request_http(port, "PATCH", "/settings", {"watchdog_enabled": False}, "admin", work)["status"] == 200
    # Two unfinished records represent a stopped controller. The backup must preserve both original states.
    with closing(sqlite3.connect(file)) as db:
        db.execute("""INSERT INTO workbench_model_runs(id,kind,scope_id,lease_epoch,phase,status,evidence_source,created_at,updated_at)
                      VALUES('recovery-sample','watchdog',15,1,'turn_intent','running','fixture',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)""")
        db.execute("""INSERT INTO conversation_bridge_operations(actor_id,request_key,payload_hash,status,created_at,updated_at)
                      VALUES('admin','recovery-sample','fixture','pending',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)""")
        db.commit()
    prepared = cli(args.node, work)
    assert prepared.returncode == 0, prepared.stderr[-1000:]
    payload = json.loads(prepared.stdout)
    backup = Path(payload["backup"]).resolve()
    assert payload["prepared"] and Path(payload["database"]) == file and backup.parent == work/"rollback-backups"
    snapshots = {}
    for name, path in [("backup", backup), ("live", file)]:
        with closing(sqlite3.connect(path.as_uri()+"?mode=ro", uri=True)) as db:
            row = db.execute("SELECT status,phase FROM workbench_model_runs WHERE id='recovery-sample'").fetchone()
            op = db.execute("SELECT status FROM conversation_bridge_operations WHERE request_key='recovery-sample'").fetchone()[0]
            assert db.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
            snapshots[name] = [*row, op]
    expected = {"backup": ["running","turn_intent","pending"], "live": ["unknown","turn_intent","unknown"]}
    report["rollback"] = {"output":payload, "states":snapshots, "expected":expected, "frozen":snapshots == expected,
                          "backup_sha256":stage0.sha(backup.read_bytes())}
    with base.service("python", work, args.node, report,bundle) as port:
        status = base.request_http(port, "GET", "/operations/watchdog?task_id=15", None, "admin", work)
        assert status["status"] == 200 and any(r["id"] == run[0] for r in status["body"]["items"])
        task = base.request_http(port, "GET", "/tasks/15", None, "admin", work)
        assert task["status"] == 200 and task["body"]["task"]["id"] == 15 and file.stat().st_ino == identity
        report["python_readback"] = {"file_id":str(identity),"watchdog_id":run[0],"task_id":15,"integrity":base.sqlite_check(work)}
    report["external_receipts"] = len(list((work/"fake-channel-receipts").glob("*.json")))
    assert report["external_receipts"] == 0
    stage0.save(output/"recovery.json", report)
    print("PASS timer, owners, active-lease refusal, backup and Python same-file readback")
    return snapshots == expected


if __name__ == "__main__":
    main()
