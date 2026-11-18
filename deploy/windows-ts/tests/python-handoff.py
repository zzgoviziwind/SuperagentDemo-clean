"""Verify the installed rollback action against the frozen real Python service."""

import argparse
import ctypes
from contextlib import closing
import http.client
import json
import os
from pathlib import Path
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time


def serve(oracle: Path, port: int, stop: Path):
    def loopback_only(event, args):
        if event in {"socket.connect", "socket.bind", "socket.getaddrinfo"}:
            host = args[0] if event == "socket.getaddrinfo" else args[1][0]
            if host not in {"127.0.0.1", "::1", "localhost"}:
                raise RuntimeError("Python verification is limited to loopback")
        if event == "subprocess.Popen":
            raise RuntimeError("Python verification cannot launch adapters or agents")

    sys.addaudithook(loopback_only)
    sys.path.insert(0, str(oracle))
    import uvicorn
    from superagent import main

    assert Path(main.__file__).resolve() == oracle / "superagent" / "main.py"

    class LocalServer(uvicorn.Server):
        async def on_tick(self, counter):
            return await super().on_tick(counter) or stop.is_file()

    LocalServer(uvicorn.Config(main.app, host="127.0.0.1", port=port,
                               access_log=False, timeout_graceful_shutdown=8)).run()


def request(port, path, payload=None, token=None):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = "Bearer " + token
    with closing(http.client.HTTPConnection("127.0.0.1", port, timeout=3)) as connection:
        connection.request("POST" if payload is not None else "GET", path,
                           None if payload is None else json.dumps(payload).encode(), headers)
        response = connection.getresponse()
        body = response.read()
        if response.status != 200:
            raise RuntimeError(f"Unexpected HTTP {response.status} on {path}: {body!r}")
        return json.loads(body)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--installer", type=Path, required=True)
    parser.add_argument("--oracle", type=Path, required=True)
    parser.add_argument("--evidence", type=Path, required=True)
    options = parser.parse_args()
    if ctypes.windll.shell32.IsUserAnAdmin():
        raise RuntimeError("Run the handoff test without elevation")
    assert options.installer.is_file()
    assert (options.oracle / "superagent" / "main.py").is_file()
    shell = Path(os.environ["SystemRoot"]) / "System32/WindowsPowerShell/v1.0/powershell.exe"
    run = Path(tempfile.mkdtemp(dir=options.evidence.resolve(), prefix="handoff-"))
    instance = run / "安装 实例"
    root = run / "project"
    root.mkdir()
    with socket.socket() as listener:
        for _ in range(50):
            import secrets
            port = 49152 + secrets.randbelow(16384)
            try:
                listener.bind(("127.0.0.1", port))
                break
            except OSError:
                continue
        else:
            raise RuntimeError("Could not reserve a high loopback port")
    env = {key: os.environ[key] for key in ("SystemRoot", "SystemDrive", "WINDIR", "ComSpec", "PATH")
           if key in os.environ}
    env.update({key: str(run) for key in ("TEMP", "TMP", "USERPROFILE", "HOME", "APPDATA", "LOCALAPPDATA", "CODEX_HOME")})
    command = [str(shell), "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(instance / "SuperAgent.ps1")]

    def call(args, expected=None):
        result = subprocess.run(args, cwd=run, env=env, text=True, encoding="utf-8", errors="replace",
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=300, check=False)
        if expected:
            assert result.returncode and expected in result.stderr + result.stdout, (args, result)
        elif result.returncode:
            raise RuntimeError(result.stdout + result.stderr)
        return result.stdout

    def manage(action, *args, expected=None):
        return call([*command, "-Action", action, *args], expected)

    print(f"Evidence directory: {run}\nTemporary port: {port}", flush=True)
    try:
        call([str(options.installer.resolve()), "-InstallRoot", str(instance), "-Port", str(port)])
        assert request(port, "/health")["implementation"] == "typescript"
        project = request(port, "/api/v1/projects", {"name": "Synthetic handoff", "repo_path": str(root)})["id"]
        task = request(port, "/api/v1/tasks", {"project_id": project, "title": "Synthetic interrupted analysis",
                                               "goal": "Check handoff", "kind": "analysis"})["id"]
        manage("PreparePythonRollback", expected="Stop the installed TypeScript service")
        assert request(port, "/health")["implementation"] == "typescript"
        manage("Stop")
        data = instance / "data"
        database = data / "superagent.db"
        original_file = database.stat()
        with closing(sqlite3.connect(database)) as connection:
            assert connection.execute("UPDATE tasks SET status='running' WHERE id=?", (task,)).rowcount == 1
            connection.commit()

        report = json.loads(manage("PreparePythonRollback"))
        assert report["prepared"] and Path(report["database"]).samefile(database)
        assert task in report["unknown_task_ids"]
        (run / "rollback-report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
        backup = Path(report["backup"])
        with closing(sqlite3.connect(backup.as_uri() + "?mode=ro", uri=True)) as connection:
            assert connection.execute("PRAGMA integrity_check").fetchone() == ("ok",)
            assert connection.execute("SELECT status FROM tasks WHERE id=?", (task,)).fetchone() == ("running",)
        assert json.loads(manage("Diagnose"))["status"] == "python-rollback-prepared"
        manage("Start", expected="reserved for Python rollback")
        manage("ReleasePythonRollback", expected="pass -ConfirmPythonStopped")
        print("PASS installed TS preflight, verified pre-recovery backup, unknown-task report and start interlock", flush=True)

        stop = run / "stop-python"
        token = "synthetic-handoff-only"
        python_env = env | {"SUPERAGENT_DATABASE_URL": "sqlite:///" + database.as_posix(),
                            "SUPERAGENT_STATE_ROOT": str(data / "python-state"),
                            "SUPERAGENT_ATTACHMENTS_ROOT": str(data / "attachments"),
                            "SUPERAGENT_WORKSPACES_ROOT": str(data / "workspaces"),
                            "SUPERAGENT_SERVICE_MODE": "preview", "SUPERAGENT_API_TOKEN": token,
                            "SUPERAGENT_FEISHU_ENABLED": "0"}
        with (run / "python.log").open("wb") as log:
            process = subprocess.Popen([sys.executable, "-IB", "-X", "utf8", str(Path(__file__).resolve()),
                                        "--serve", str(options.oracle.resolve()), str(port), str(stop)],
                                       cwd=run, env=python_env, stdout=log, stderr=subprocess.STDOUT,
                                       creationflags=subprocess.CREATE_NO_WINDOW)
            try:
                deadline = time.monotonic() + 24
                while time.monotonic() < deadline and process.poll() is None:
                    try:
                        assert request(port, "/health", token=token)["version"] == "0.1.0"
                        break
                    except OSError:
                        time.sleep(0.2)
                else:
                    raise RuntimeError(f"Frozen Python did not start. See {run / 'python.log'}")
                restored = request(port, f"/api/v1/tasks/{task}", token=token)["task"]
                assert restored["title"] == "Synthetic interrupted analysis"
                assert restored["status"] == "waiting_resource" and restored["outcome_unknown"]
                assert all(not connector["enabled"] for connector in request(port, "/api/v1/connectors", token=token))
                manage("ReleasePythonRollback", "-ConfirmPythonStopped", expected="still listening")
                assert database.stat().st_ino == original_file.st_ino
                print("PASS frozen Python opened the same SQLite file and read the unknown task with channels off", flush=True)
            finally:
                stop.touch()
                try:
                    process.wait(15)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(8)
        assert process.returncode == 0
        manage("ReleasePythonRollback", "-ConfirmPythonStopped")
        manage("Start")
        assert request(port, "/api/v1/tasks/" + str(task))["task"]["outcome_unknown"]
        manage("Stop")
        print("PASS explicit handoff release after Python exits, TypeScript resumes on the same SQLite data", flush=True)
    finally:
        if (instance / "SuperAgent.ps1").is_file():
            manage("Stop")


if __name__ == "__main__":
    if sys.argv[1:2] == ["--serve"]:
        serve(Path(sys.argv[2]), int(sys.argv[3]), Path(sys.argv[4]))
    else:
        main()
