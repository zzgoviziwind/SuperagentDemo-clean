"""Independently check the three rollback states against a supplied release. Never overwrite prior results."""
import argparse
from contextlib import closing
from datetime import datetime, timezone
import gzip
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import uuid

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from candidate import canonical_digest, file_sha, materialize, sha, tree

STAMP = "2026-01-01T00:00:00.000000+00:00"
SCHEMA = """CREATE TABLE workbench_model_runs (
 id TEXT PRIMARY KEY, kind TEXT NOT NULL, scope_id INTEGER NOT NULL, item_id INTEGER,
 lease_epoch INTEGER NOT NULL, phase TEXT NOT NULL, status TEXT NOT NULL, evidence_source TEXT NOT NULL,
 thread_id TEXT, turn_id TEXT, reservation_id INTEGER, tree_exited INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_error TEXT)"""


def snapshot(path):
    with closing(sqlite3.connect(path.as_uri()+"?mode=ro", uri=True)) as db:
        db.row_factory = sqlite3.Row
        def lookup(sql):
            return [dict(row) for row in db.execute(sql)]
        has_runs = bool(lookup("SELECT 1 FROM sqlite_schema WHERE name='workbench_model_runs'"))
        return {
            "integrity": db.execute("PRAGMA integrity_check").fetchone()[0],
            "task": lookup("SELECT id,status,outcome_unknown FROM tasks WHERE id=1")[0],
            "attempt": lookup("SELECT id,status FROM execution_attempts WHERE task_id=1")[0],
            "tool": lookup("""SELECT id,status,action_hash FROM approvals WHERE json_extract(action,'$.method') IS NOT NULL""")[0],
            "decision": lookup("""SELECT content,json_extract(data,'$.approval_id') approval_id,
                json_extract(data,'$.attempt_id') attempt_id FROM events WHERE event_type='approval_decision'"""),
            "unknown_events": lookup("""SELECT json_extract(data,'$.approval_id') approval_id,
                json_extract(data,'$.attempt_id') attempt_id FROM events WHERE event_type='approval_response_unknown'"""),
            "bridge": lookup("SELECT request_key,status,result,payload_hash FROM conversation_bridge_operations ORDER BY request_key"),
            "runs": lookup("SELECT id,kind,scope_id,phase,status,tree_exited FROM workbench_model_runs ORDER BY id") if has_runs else [],
            "ledger": lookup("SELECT action_id,json_extract(result,'$.write_status') status FROM delivery_records")[0],
        }


def environment(path):
    env = {k: os.environ[k] for k in ("SystemRoot","SystemDrive","WINDIR","ComSpec","PATHEXT","PROCESSOR_ARCHITECTURE") if k in os.environ}
    env.update({k:str(path) for k in ("TEMP","TMP","HOME","USERPROFILE","APPDATA","LOCALAPPDATA","CODEX_HOME","SUPERAGENT_DATA_DIR")})
    return env


def prepare(node, entry, work):
    log = work / "disallowed-calls.txt"
    env = environment(work) | {"NODE_OPTIONS":'--require="'+(HERE.parent/"prepare-guard.cjs").as_posix()+'"',
                               "REVIEW_SIDE_EFFECTS":str(log)}
    result = subprocess.run([node,entry,"--prepare-python-rollback"],cwd=work,env=env,capture_output=True,
                            encoding="utf-8",errors="replace",timeout=25)
    if result.returncode or log.exists():
        raise RuntimeError(result.stderr[-1600:] if not log.exists() else log.read_text("utf-8"))
    report = json.loads(result.stdout)
    backup = Path(report["backup"])
    assert report["prepared"] is True and Path(report["database"]).samefile(work/"superagent.db")
    assert backup.resolve().parent == work/"rollback-backups"
    report.update(database="superagent.db",backup=backup.relative_to(work).as_posix())
    return report, backup


def exercise(node, entry, work, raw, with_run):
    work.mkdir()
    dbfile = work/"superagent.db"
    dbfile.write_bytes(raw)
    if with_run:
        with closing(sqlite3.connect(dbfile)) as db:
            db.execute(SCHEMA)
            db.execute("""INSERT INTO tasks(id,title,kind,owner_id,outcome_unknown,goal,project_id,status,revision,state_version,
                control_version,source,acceptance_criteria,created_at,updated_at)
                VALUES(15,'sample','analysis','admin',0,'sample',1,'waiting_resource',1,1,1,'web','',?,?)""",(STAMP,STAMP))
            db.executemany("""INSERT INTO workbench_model_runs
                (id,kind,scope_id,lease_epoch,phase,status,evidence_source,tree_exited,created_at,updated_at)
                VALUES(?,'watchdog',15,1,?,?,'fixture',?,?,?)""",[
                    ("recovery-sample","turn_intent","running",0,STAMP,STAMP),
                    ("completed-control","finished","completed",1,STAMP,STAMP)])
            db.commit()
    before = snapshot(dbfile)
    assert before["integrity"]=="ok" and before["tool"]["status"]=="dispatching"
    decision = before["decision"]
    key = {"attempt_id":before["attempt"]["id"],"approval_id":before["tool"]["id"]}
    assert decision == [key|{"content":"approve"}] and before["unknown_events"]==[]
    assert before["bridge"][1]["status"]=="pending" and before["ledger"]["status"]=="dispatching"
    if with_run:
        assert (before["runs"][1]["phase"],before["runs"][1]["status"])==("turn_intent","running")
    identity = dbfile.stat().st_ino
    cli, backup = prepare(node,entry,work)
    after = snapshot(dbfile)
    first_copy = snapshot(backup)
    python = subprocess.run([sys.executable,"-IB","-X","utf8",HERE/"stock.py",work],
                            cwd=work,env=environment(work),capture_output=True,encoding="utf-8",errors="replace",timeout=35)
    if python.returncode:
        raise RuntimeError(python.stderr[-1600:])
    stock = json.loads(python.stdout.strip().splitlines()[-1])
    readback = snapshot(dbfile)
    repeat, second_backup = prepare(node,entry,work)
    repeated = snapshot(dbfile)
    checks = {
        "backup_before_recovery":first_copy==before and backup!=second_backup and snapshot(second_backup)==readback,
        "dispatched_approval":after["tool"]==before["tool"]|{"status":"unknown"} and after["unknown_events"]==[key]
                              and after["decision"]==decision and after["attempt"]["status"]=="unknown"
                              and after["task"]["outcome_unknown"]==1,
        "pending_bridge":after["bridge"]==[before["bridge"][0],before["bridge"][1]|{"status":"unknown"}],
        "delivery":after["ledger"]==before["ledger"]|{"status":"unknown"} and cli["unknown_delivery_ids"]==[before["ledger"]["action_id"]],
        "python_stock_same_db":dbfile.stat().st_ino==identity and after==readback and stock["approval"]==after["tool"]["status"]
                              and stock["bridge"]==after["bridge"][1]["status"] and stock["read_file_id"]==str(identity),
        "repeat_stable":repeated==readback,
        "no_external_receipts":not list((work/"fake-channel-receipts").glob("*")),
        "sqlite_integrity":after["integrity"]=="ok",
    }
    if with_run:
        checks["workbench_run"]=after["runs"]==[before["runs"][0],before["runs"][1]|{"status":"unknown"}]
    return {"checks":checks,"before":before,"backup":first_copy,"after":after,"python_stock":stock,
            "readback":readback,"after_repeat":repeated,"cli":cli,"repeat_cli":repeat,
            "database_file_id":str(identity),"initial_backup_sha256":file_sha(backup)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dist",type=Path,required=True,help="release ZIP, standalone dist ZIP, or dist directory")
    parser.add_argument("--node",type=Path,help="Node 24 for a standalone dist; release ZIP uses its own node.exe")
    parser.add_argument("--expect-main")
    parser.add_argument("--expect-dist")
    parser.add_argument("--expect-zip")
    parser.add_argument("--seed",type=Path,default=HERE/"seed.sqlite.gz")
    args = parser.parse_args()
    if not __debug__:
        parser.error("assertions must be enabled")
    raw = gzip.decompress(args.seed.read_bytes())
    with tempfile.TemporaryDirectory(prefix="r-",dir=HERE) as tmp:
        work = Path(tmp)
        dist,node,info = materialize(args.dist, work, args.node.resolve() if args.node else None,args.expect_zip)
        for key,expected in [("main_sha256",args.expect_main),("dist_sha256",args.expect_dist)]:
            if expected and info[key] != expected.lower():
                raise ValueError(key+" mismatch: "+info[key])
        version = subprocess.check_output([node,"--version"],cwd=work,env=environment(work),text=True).strip()
        assert version.startswith("v24."),version
        stamp = datetime.now(timezone.utc)
        run_id=stamp.strftime("%Y%m%dT%H%M%SZ")+"-"+uuid.uuid4().hex[:8]
        evidence_dir = HERE/"evidence"/info["dist_sha256"]/run_id
        evidence_dir.mkdir(parents=True)
        report = {"candidate":info,"utc":stamp.isoformat(),"node":version,"python":sys.version.split()[0],
                  "seed_sha256":sha(raw),"seed_storage_commit":"30bceacbf141cfb143bc0eab9d004761f23201ba",
                  "runner_files":{p.name:file_sha(p) for p in [Path(__file__),HERE/"candidate.py",HERE/"stock.py",HERE.parent/"prepare-guard.cjs"]},
                  "cases":{}}
        for name,with_run in [("reported_119",True),("bridge_without_model_table",False)]:
            try:
                case = exercise(node,dist/"main.js",work/name,raw,with_run)
                case["pass"]=all(case["checks"].values())
            except Exception as error:
                import traceback
                case={"pass":False,"runner_error":traceback.format_exc().replace(tmp,"<scratch>")}
            report["cases"][name]=case
            print(name,case.get("checks",case.get("runner_error")),flush=True)
        report["dist_unchanged"] = canonical_digest(tree(dist))==info["dist_sha256"]
        report["pass"]=report["dist_unchanged"] and all(c["pass"] for c in report["cases"].values())
        with (evidence_dir/"recovery.json").open("x",encoding="utf-8") as f:
            json.dump(report,f,ensure_ascii=False,indent=2)
            f.write("\n")
        print(evidence_dir/"recovery.json",flush=True)
        return int(not report["pass"])


if __name__=="__main__":
    sys.exit(main())
