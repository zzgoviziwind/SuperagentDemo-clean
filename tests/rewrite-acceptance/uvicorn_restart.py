"""Start the verified oracle four times, with full lifespan on private loopback ports."""
from contextlib import closing
import http.client
import json
import os
import secrets
from pathlib import Path
import shutil
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import stage0


def serve():
    work = Path.cwd().resolve()
    assert HERE in work.parents and Path(os.environ["SUPERAGENT_STATE_ROOT"]).parent == work
    def local_only(event, args):
        if event in {"socket.connect", "socket.bind", "socket.getaddrinfo"}:
            host = args[0] if event == "socket.getaddrinfo" else args[1][0]
            if host not in ("127.0.0.1", "::1", "localhost"):
                raise RuntimeError("Service attempted non-loopback I/O")
    sys.addaudithook(local_only)
    sys.path.insert(0, str(stage0.ORACLE))
    import uvicorn
    from superagent import main
    assert Path(main.__file__).resolve() == stage0.ORACLE / "superagent/main.py"

    class LocalServer(uvicorn.Server):
        async def on_tick(self, counter):
            return await super().on_tick(counter) or (work / "stop").is_file()

    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        for _ in range(100):
            try:
                sock.bind(("127.0.0.1", 49152 + secrets.randbelow(16384)))
                break
            except OSError:
                continue
        else:
            raise RuntimeError("Could not reserve a private high loopback port")
        port = sock.getsockname()[1]
        assert port > 1024 and port not in (8765, 8876, 8877)
        (work / "port").write_text(str(port), "ascii")
        (work / "service-pid").write_text(str(os.getpid()), "ascii")
        config = uvicorn.Config(main.app, host="127.0.0.1", port=port, lifespan="on",
                                access_log=False, timeout_graceful_shutdown=8)
        LocalServer(config).run(sockets=[sock])


def request(port, path, body=None):
    with closing(http.client.HTTPConnection("127.0.0.1", port, timeout=3)) as conn:
        payload = json.dumps(body).encode() if body is not None else None
        conn.request("POST" if payload else "GET", path, payload,
                     {"Authorization":"Bearer fixture-only", "Content-Type":"application/json"})
        response = conn.getresponse()
        detail = json.loads(response.read())
        assert response.status == 200, (path, response.status, detail)
        return detail


def launch(work, profile, startup):
    for name in ("port", "stop"):
        (work / name).unlink(missing_ok=True)
    env = {k:os.environ[k] for k in ("SYSTEMROOT","WINDIR","SYSTEMDRIVE","PROCESSOR_ARCHITECTURE")
           if k in os.environ}
    env.update({k:str(work) for k in ("TEMP","TMP","HOME","USERPROFILE","APPDATA","LOCALAPPDATA","CODEX_HOME")})
    env.update(SUPERAGENT_STATE_ROOT=str(work / "state"), SUPERAGENT_API_TOKEN="fixture-only",
               SUPERAGENT_WORKSPACES_ROOT=str(work / "workspaces"), SUPERAGENT_SERVICE_MODE="preview",
               SUPERAGENT_ALLOWED_REPO_ROOTS=str(work / "含空格 项目"), SUPERAGENT_FEISHU_ENABLED="0",
               SUPERAGENT_ATTACHMENTS_ROOT=str(work / "attachments"),
               SUPERAGENT_DATABASE_URL="sqlite:///" + (work / "service.db").as_posix())
    if profile == "wp":
        env.update({"SUPERAGENT_" + k:v for k,v in stage0.INPUT["enabled_modes"].items()})
    log_path = work / f"boot-{startup}.log"
    with log_path.open("wb") as log:
        proc = subprocess.Popen([sys.executable, "-IB", "-X", "utf8", __file__, "--serve"],
                                cwd=work, env=env, stdout=log, stderr=subprocess.STDOUT)
        try:
            deadline = time.monotonic() + 24
            while time.monotonic() < deadline and proc.poll() is None:
                try:
                    port = int((work / "port").read_text("ascii"))
                    health = request(port, "/health")
                    break
                except (FileNotFoundError, ValueError, OSError):
                    time.sleep(.15)
            else:
                raise RuntimeError("Uvicorn did not become healthy: " + log_path.read_text("utf-8",errors="replace")[-2500:])
            assert health == {"status":"ok","version":"0.1.0"}
            settings = request(port, "/api/v1/settings")
            assert all(settings[k] is False for k in stage0.INPUT["default_false"])
            connectors = request(port, "/api/v1/connectors")
            assert {r["id"] for r in connectors} == {"redmine","dingtalk"}
            assert all(r["enabled"] is False and r["status"] == "disabled" for r in connectors)
            old = request(port, "/api/v1/tasks/1")
            assert old["task"]["outcome_unknown"] and old["task"]["status"] == "waiting_resource"
            ledger, = request(port, "/api/v1/tasks/1/deliveries")
            assert ledger["delivery"]["write_status"] == "unknown"
            assert old["approvals"][0]["status"] == ("expired_on_restart" if profile == "wp" else "pending")
            if startup == 1:
                new = request(port, "/api/v1/tasks", {"title":"重启留存样本","goal":"核对运行中断","project_id":1})
                assert new["id"] == 2 and new["status"] == "queued"
            else:
                new = request(port, "/api/v1/tasks/2")["task"]
                assert new["outcome_unknown"] and new["status"] == "waiting_resource"
            evidence = {"pid":int((work / "service-pid").read_text("ascii")), "port":port, "health":health,
                        "channels":{r["id"]:r["status"] for r in connectors},
                        "old_approval":old["approvals"][0]["status"], "old_delivery":"unknown",
                        "old_task":old["task"]["status"], "task_2":new["status"],
                        "task_2_unknown":new["outcome_unknown"], "task_2_version":new["state_version"]}
            (work / "stop").touch()
            assert proc.wait(15) == 0
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.wait(8)
    log_text = log_path.read_text("utf-8",errors="replace")
    assert "Application startup complete" in log_text and "Application shutdown complete" in log_text, log_text
    evidence["lifespan_log"] = log_text.splitlines()
    return evidence


def scenario(root, source, profile):
    work = root / profile
    work.mkdir()
    stage0.worker("legacy", source, work)
    shutil.copyfile(work / "legacy.db", work / "service.db")
    boots = [launch(work, profile, 1)]
    with closing(sqlite3.connect(work / "service.db")) as conn:
        # While the service is stopped, model the persisted state of an interrupted turn.
        assert conn.execute("UPDATE tasks SET status='running' WHERE id=2 AND status='queued'").rowcount == 1
        if profile == "wp":
            conn.execute("""INSERT INTO execution_attempts(id,task_id,attempt_no,status,phase,owner,revision,
                         control_version,turn_id,updated_at) VALUES('test-attempt',2,1,'running','turn',
                         'fixture-owner',1,1,'fixture-turn','2026-11-17T08:00:00+00:00')""")
        conn.commit()
    boots.append(launch(work, profile, 2))
    assert boots[0]["pid"] != boots[1]["pid"]
    with closing(sqlite3.connect((work / "service.db").as_uri()+"?mode=ro",uri=True)) as conn:
        epoch = conn.execute("SELECT epoch FROM controller_leases").fetchall()
        attempts = conn.execute("SELECT status FROM execution_attempts").fetchall()
        assert epoch == ([(2,)] if profile == "wp" else [])
        assert attempts == ([("unknown",)] if profile == "wp" else [])
        assert conn.execute("SELECT count(*) FROM delivery_records").fetchone()[0] == 1
        assert conn.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
    return {"boots":boots, "post_restart_epoch":epoch, "post_restart_attempts":attempts}


def main():
    assert __debug__
    provenance = stage0.verify_source()
    with tempfile.TemporaryDirectory(prefix="stage0-uvicorn-", dir=HERE) as tmp:
        root = Path(tmp)
        baseline = root / "baseline"
        stage0.legacy_source(baseline)
        result = {k:scenario(root, baseline, k) for k in ("default", "wp")}
    assert stage0.verify_source() == provenance
    stage0.save(HERE / "uvicorn-results.json", {"source":provenance, "profiles":result})
    print("PASS 4 Uvicorn boots, 2 full-lifespan restarts")


if __name__ == "__main__":
    serve() if sys.argv[1:] == ["--serve"] else main()
