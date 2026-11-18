"""Exercise rollback refusal on one synthetic unfinished row and the daemon handover on the same file."""
import argparse
from contextlib import closing
import json
from pathlib import Path
import sqlite3
import sys
import tempfile

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import replay119 as base
import replay_bundle
from replay_recovery import cli
import stage0


def node_calls(port, work):
    return {name:base.request_http(port,"POST","/operations/daemon/"+name,payload,"admin",work)
            for name,payload in [("poll",{"boot_id":"postcheck-synthetic-boot"}),("exchange",{"events":[]})]}


def run(bundle, node, output):
    work = Path(tempfile.mkdtemp(dir=HERE,prefix="phase1-run-119-postcheck-"))/"python"
    base.clone(bundle.work/"seed",work)
    database = work/"superagent.db"
    file_id = database.stat().st_ino
    info = {"entry_sha256":bundle.files["main.js"],"dist_sha256":bundle.digest,"root":str(work)}
    with base.service("ts",work,node,info,bundle) as port:
        before = base.table_image(work)
        ts = node_calls(port,work)
        assert all(r["status"]==503 and r["body"]["execution_host"]=="python" for r in ts.values())
        assert not base.delta(before,base.table_image(work))
    with closing(sqlite3.connect(database)) as db:
        db.execute("""INSERT INTO conversation_bridge_operations(actor_id,request_key,payload_hash,status,created_at,updated_at)
                      VALUES ('admin','postcheck-intent','fixture','pending',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)""")
        # Simulate storage retaining just this synthetic row during recovery.
        db.execute("""CREATE TRIGGER keep_sample_pending BEFORE UPDATE OF status ON conversation_bridge_operations
                      WHEN OLD.request_key='postcheck-intent' AND NEW.status='unknown' BEGIN SELECT RAISE(IGNORE); END""")
        db.commit()
    refused = cli(node,work)
    reason = "仍有未完成恢复的派发记录"
    assert refused.returncode != 0 and not refused.stdout.strip() and reason in refused.stderr
    with closing(sqlite3.connect(database)) as db:
        status = db.execute("SELECT status FROM conversation_bridge_operations WHERE request_key='postcheck-intent'").fetchone()[0]
        assert status == "pending"
        db.execute("DROP TRIGGER keep_sample_pending")
        db.commit()
    prepared = cli(node,work)
    assert prepared.returncode == 0, prepared.stderr[-1000:]
    payload = json.loads(prepared.stdout)
    assert payload["prepared"] and Path(payload["database"]) == database
    with closing(sqlite3.connect(database.as_uri()+"?mode=ro",uri=True)) as db:
        assert db.execute("SELECT status FROM conversation_bridge_operations WHERE request_key='postcheck-intent'").fetchone() == ("unknown",)
    with base.service("python",work,node,info,bundle) as port:
        before = base.table_image(work)
        py = node_calls(port,work)
        changes = base.delta(before,base.table_image(work))
        assert py["poll"]["status"] == py["exchange"]["status"] == 200
        assert py["poll"]["body"]["operation"] is None and py["exchange"]["body"]["accepted"] is True
        assert len(changes["execution_nonces"]) == 2
    assert file_id == database.stat().st_ino and base.sqlite_check(work) == "ok"
    assert not list((work/"fake-channel-receipts").glob("*.json"))
    info.update(ts=ts,python=py,python_db_changes=changes,ts_db_changes={},file_id=str(file_id),receipts=0,
                residual={"cli_exit":refused.returncode,"reason":reason,"success_output":False,"bridge_state":status},
                repaired={"cli_exit":prepared.returncode,"bridge_state":"unknown","output":payload})
    stage0.save(output/"postcheck.json",info)


if __name__=="__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--node",required=True,type=Path)
    parser.add_argument("--seed-run",required=True,type=Path)
    args = parser.parse_args()
    bundle = replay_bundle.load_run(args.seed_run)
    with replay_bundle.publish(bundle,"postcheck") as output:
        run(bundle,args.node,output)
    print("PASS residual-state refusal, successful retry and same-file Python daemon takeover")
