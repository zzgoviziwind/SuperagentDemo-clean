"""Interrupt TS with one synthetic receipt, prepare twice and reconcile over frozen Python HTTP."""
import argparse
import asyncio
from contextlib import closing
import json
import os
from pathlib import Path
import socket
import sqlite3
import subprocess
import sys
import tempfile

HERE = Path(__file__).resolve().parent
ORACLE = HERE.parents[2] / ".rewrite-oracle"


async def frozen_http(profile):
    work = Path.cwd()
    database = work / "service.db"
    assert database.is_file() and os.environ["SUPERAGENT_STATE_ROOT"] == str(work)
    sys.path.insert(0, str(ORACLE))

    def local_only(event, args):
        if event in {"socket.connect", "socket.bind", "socket.getaddrinfo"}:
            address = args[0] if event == "socket.getaddrinfo" else args[1][0]
            if address not in {"127.0.0.1", "localhost", "::1"}:
                raise RuntimeError("Unexpected network address")

    sys.addaudithook(local_only)
    import httpx
    import uvicorn
    from superagent import main
    from superagent.core import db, execution
    assert Path(main.__file__).resolve() == ORACLE / "superagent/main.py"
    assert Path(db.engine.url.database).resolve() == database
    assert execution.enabled() == (profile == "default")
    assert "SUPERAGENT_LEDGER_MODE" not in os.environ
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        server = uvicorn.Server(uvicorn.Config(main.app, lifespan="on", log_level="error"))
        run = asyncio.create_task(server.serve(sockets=[sock]))
        try:
            async with asyncio.timeout(20):
                while not server.started:
                    if run.done():
                        await run
                        raise RuntimeError("Frozen host exited before startup")
                    await asyncio.sleep(.05)
            async with httpx.AsyncClient(base_url=f"http://127.0.0.1:{sock.getsockname()[1]}/api/v1/",
                    headers={"Authorization":"Bearer fixture-only"}, trust_env=False, timeout=5) as api:
                async def post(path, body, status):
                    response = await api.post(path, json=body)
                    assert response.status_code == status, (path, response.status_code, response.text)
                    return response.json()

                detail = (await api.get("tasks/1")).raise_for_status().json()
                approvals = {row["id"]:row for row in detail["approvals"]}
                assert [approvals[i]["status"] for i in range(1, 6)] == [
                    "approved", "rejected", "expired_on_restart", "unknown", "approved"]
                task = detail["task"]
                assert task["outcome_unknown"] and task["status"] == "waiting_resource"
                await post("approvals/4/decision", {"decision":"approve", "action_hash":approvals[4]["action_hash"]}, 409)
                stopped = {"outcome":"stopped", "evidence":"offline worker exited with code 73",
                           "expected_state_version":task["state_version"]}
                await post("tasks/1/reconcile", {**stopped, "expected_state_version":0}, 409)
                result = await post("tasks/1/reconcile", stopped, 200)
                assert result["status"] == "paused" and not result["outcome_unknown"]
                await post("tasks/1/reconcile", {**stopped, "expected_state_version":result["state_version"]}, 409)
                ledger, = (await api.get("tasks/1/deliveries")).raise_for_status().json()
                assert ledger["delivery"]["write_status"] == "unknown"
                receipt = (work / "receipt.txt").read_text().splitlines()
                assert receipt == [ledger["delivery"]["action_id"]]
                verified = {"outcome":"succeeded", "evidence":"One offline receipt for " + receipt[0]}
                delivery = await post("deliveries/1/reconcile", verified, 200)
                assert delivery["write_status"] == "succeeded"
                await post("deliveries/1/reconcile", verified, 409)
                assert (await api.get("tasks/1/deliveries")).raise_for_status().json()[0]["delivery"] == delivery
        finally:
            server.should_exit = True
            await asyncio.wait_for(run, 10)
            db.engine.dispose()


def scenario(node, profile):
    with tempfile.TemporaryDirectory(prefix="superagent-handoff-") as temp:
        work = Path(temp).resolve()
        env = {k:os.environ[k] for k in ("SYSTEMROOT","SYSTEMDRIVE","WINDIR","PROCESSOR_ARCHITECTURE") if k in os.environ}
        env.update({k:str(work) for k in ("TEMP","TMP","HOME","USERPROFILE","LOCALAPPDATA","APPDATA","CODEX_HOME")})
        def ts(mode):
            return subprocess.run([node, HERE / "handoff.ts", mode], cwd=work, env=env,
                                  stdout=subprocess.PIPE, text=True, timeout=12)
        assert ts("interrupt").returncode == 73
        with closing(sqlite3.connect(work / "service.db")) as conn:
            assert conn.execute("SELECT status FROM approvals ORDER BY id").fetchall() == [
                ("approved",), ("rejected",), ("pending",), ("dispatching",), ("approved",)]
            assert conn.execute("SELECT json_extract(result,'$.write_status') FROM delivery_records").fetchone() == ("dispatching",)
            initial = conn.execute("SELECT state_version FROM tasks").fetchone()[0]
        receipt = (work / "receipt.txt").read_bytes()
        for i in (1, 0):
            proc = ts("prepare")
            proc.check_returncode()
            recovery = json.loads(proc.stdout)["recovery"]
            assert [recovery[k] for k in ("approvals_unknown","approvals_expired","dispatches_unknown","unknown")] == [i]*4
        with closing(sqlite3.connect(work / "service.db")) as conn:
            assert conn.execute("SELECT state_version FROM tasks").fetchone() == (initial+1,)
            assert conn.execute("SELECT status FROM execution_attempts").fetchone() == ("unknown",)
            assert conn.execute("SELECT claim_token FROM delivery_records").fetchone() == (None,)
        env.update(SUPERAGENT_SERVICE_MODE="preview", SUPERAGENT_STATE_ROOT=str(work), SUPERAGENT_API_TOKEN="fixture-only",
                   SUPERAGENT_FEISHU_ENABLED="0", SUPERAGENT_DATABASE_URL="sqlite:///" + (work / "service.db").as_posix())
        if profile == "default":
            env["SUPERAGENT_EXECUTION_MODE"] = "attempt"
        subprocess.run([sys.executable, "-IB", "-X", "utf8", __file__, "--serve", profile],
                       cwd=work, env=env, check=True, timeout=50)
        with closing(sqlite3.connect(work / "service.db")) as conn:
            for event in ("approval_response_unknown","execution_reconciled","delivery.reconciled"):
                assert conn.execute("SELECT COUNT(*) FROM events WHERE event_type=?", (event,)).fetchone() == (1,)
            assert conn.execute("SELECT status FROM approvals WHERE id=4").fetchone() == ("unknown",)
            assert conn.execute("PRAGMA integrity_check").fetchone() == ("ok",)
        assert (work / "receipt.txt").read_bytes() == receipt
        print(f"PASS {profile}: worker unknown, task 200/409, delivery 200/409, 1 receipt")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--node", type=Path)
    group.add_argument("--serve", choices=["default","stock"])
    args = parser.parse_args()
    if args.serve:
        asyncio.run(frozen_http(args.serve))
    else:
        for profile in ("default","stock"):
            scenario(args.node.resolve(), profile)
