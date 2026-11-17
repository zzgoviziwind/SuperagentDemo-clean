"""Run a real HTTP service and real fake-Codex child processes, without imports from superagent."""
import json
import os
from pathlib import Path
import socket
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import threading
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[2]


class BlackBoxAcceptance(unittest.TestCase):
    def setUp(self):
        scratch = ROOT / "tests/e2e/.tmp"
        scratch.mkdir(exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(prefix="superagent-e2e-", dir=scratch)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.repo = self.root / "source"
        self.repo.mkdir()
        self.git("init", "-b", "main")
        self.git("config", "user.email", "offline@example.invalid")
        self.git("config", "user.name", "离线验收")
        (self.repo / "README.md").write_text("baseline\n", encoding="utf-8")
        self.git("add", "README.md")
        self.git("commit", "-m", "test（common）：建立离线验收基线")
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            self.port = listener.getsockname()[1]
        self.base = f"http://127.0.0.1:{self.port}"
        self.environment = os.environ.copy()
        # Completely replace real integrations even when the calling shell has credentials.
        for key in list(self.environment):
            if key.startswith(("SUPERAGENT_", "DINGTALK_", "REDMINE_", "CODEX_", "OPENAI_")):
                del self.environment[key]
        self.environment.update({
            "SUPERAGENT_DATABASE_URL": "sqlite:///" + (self.root / "control.db").as_posix(),
            "SUPERAGENT_WORKSPACES_ROOT": str(self.root / "workspaces"),
            "SUPERAGENT_CODEX_EXECUTABLE": json.dumps([sys.executable, str(ROOT / "tests/e2e/fake_codex.py")]),
            "SUPERAGENT_API_TOKEN": "offline-acceptance-token",
            "SUPERAGENT_ALLOWED_REPO_ROOTS": str(self.root),
            "PYTHONPATH": str(ROOT), "PYTHONUNBUFFERED": "1",
            "OFFLINE_REDMINE_KEY": "offline-fixture-key",
        })
        self.log = open(self.root / "service.log", "w+", encoding="utf-8")
        self.addCleanup(self.log.close)
        self.process = None
        self.addCleanup(self.stop)
        self.start()
        self.request("PATCH", "/api/v1/settings", {"scheduler_enabled": True, "max_concurrent_tasks": 4,
            "budget_hard_limit_micros": 100000000, "budget_reservation_estimate_micros": 1000})
        self.project = self.request("POST", "/api/v1/projects", {
            "name": "离线验收", "repo_path": str(self.repo), "base_branch": "main",
            "test_command": f'"{sys.executable}" -c "from pathlib import Path; assert Path(\'result.txt\').read_text().strip() == \'verified offline artifact\'"',
            "allowed_paths": ["."], "dingtalk_chat_ids": ["offline-chat"], "redmine_project_ids": ["42"]})

    def git(self, *arguments):
        return subprocess.check_output(["git", "-C", str(self.repo), *arguments], stderr=subprocess.STDOUT)

    def start(self):
        self.process = subprocess.Popen([sys.executable, "-m", "uvicorn", "superagent.main:app",
            "--host", "127.0.0.1", "--port", str(self.port)], cwd=ROOT, env=self.environment,
            stdout=self.log, stderr=subprocess.STDOUT)
        last_error = None
        for _ in range(100):
            if self.process.poll() is not None:
                self.log.flush()
                self.log.seek(0)
                self.fail("HTTP service failed to start\n" + self.log.read())
            try:
                if self.request("GET", "/health")["status"] == "ok":
                    return
            except (URLError, ConnectionError, TimeoutError) as error:
                last_error = error
                time.sleep(0.1)
        self.log.flush()
        self.log.seek(0)
        self.fail(f"HTTP service did not become healthy: {last_error!r}\n" + self.log.read())

    def stop(self):
        if self.process and self.process.poll() is None:
            if os.name == "nt":
                powershell = shutil.which("pwsh")
                if powershell:
                    killed = subprocess.run([powershell, "-NoProfile", "-NonInteractive", "-Command",
                        f"$p = [System.Diagnostics.Process]::GetProcessById({self.process.pid}); $p.Kill($true); $p.WaitForExit()"],
                        capture_output=True, text=True, errors="replace", creationflags=subprocess.CREATE_NO_WINDOW)
                else:
                    killed = subprocess.run(["taskkill", "/PID", str(self.process.pid), "/T", "/F"],
                        capture_output=True, text=True, errors="replace", check=False)
                self.assertEqual(killed.returncode, 0, killed.stderr)
                self.process.wait(timeout=10)
                return
            self.process.terminate()
            try:
                self.process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=5)

    def request(self, method, path, body=None, expected=200, authenticated=True):
        headers = {"Content-Type": "application/json"}
        if authenticated:
            headers["Authorization"] = "Bearer offline-acceptance-token"
        request = Request(self.base + path, data=None if body is None else json.dumps(body).encode(), headers=headers, method=method)
        try:
            with urlopen(request, timeout=5) as response:
                status, raw = response.status, response.read()
        except HTTPError as error:
            status, raw = error.code, error.read()
        valid = expected if isinstance(expected, tuple) else (expected,)
        self.assertIn(status, valid, f"{method} {path}: {status} {raw!r}")
        if not raw:
            return None
        try:
            return json.loads(raw)
        except ValueError:
            return raw.decode()

    def create_task(self, goal="Create result.txt"):
        return self.request("POST", "/api/v1/tasks", {"title": "生成离线验收产物", "goal": goal, "project_id": self.project["id"], "acceptance_criteria": "result.txt passes project test"}, expected=(200, 201, 202))

    def detail(self, task):
        return self.request("GET", f'/api/v1/tasks/{task["id"]}')

    def wait_status(self, task, statuses):
        for _ in range(150):
            detail = self.detail(task)
            if detail["task"]["status"] in statuses:
                return detail
            if detail["task"]["status"] == "failed":
                self.fail(f"Task failed: {detail!r}")
            time.sleep(0.1)
        self.fail(f"Task did not reach {statuses}: {detail!r}")

    def test_full_delivery_and_persistence(self):
        task = self.create_task()
        waiting = self.wait_status(task, {"waiting_approval"})
        workspace = Path(waiting["task"]["workspace_path"])
        self.assertNotEqual(workspace.resolve(), self.repo.resolve())
        self.assertTrue(workspace.is_relative_to(self.root / "workspaces"))
        approval = waiting["approvals"][-1]
        self.request("POST", f'/api/v1/approvals/{approval["id"]}/decision', {"decision": "approve", "action_hash": approval["action_hash"]})
        ready = self.wait_status(task, {"review_ready"})
        self.assertTrue(ready["artifacts"], "review_ready requires inspectable evidence")
        verification = [a for a in ready["artifacts"] if a["kind"] == "verification"]
        self.assertTrue(verification, "Delivery must include actual project validation evidence")
        evidence = json.loads(verification[-1]["content"])
        self.assertEqual(evidence.get("exit_code", evidence.get("returncode")), 0,
            "Configured project test must run and pass before delivery")
        self.assertTrue((workspace / "result.txt").exists())
        self.assertFalse((self.repo / "result.txt").exists())
        self.assertEqual(self.git("status", "--porcelain"), b"")
        for artifact in ready["artifacts"]:
            self.request("GET", f'/api/v1/artifacts/{artifact["id"]}')
        self.request("POST", f'/api/v1/tasks/{task["id"]}/acceptance', {"accepted": True, "revision": ready["task"]["revision"]})
        self.stop()
        self.start()
        self.assertEqual(self.detail(task)["task"]["status"], "completed")

    def test_cancel_blocks_late_completion_and_old_approval(self):
        task = self.create_task()
        waiting = self.wait_status(task, {"waiting_approval"})
        approval = waiting["approvals"][-1]
        self.request("POST", f'/api/v1/tasks/{task["id"]}/controls', {"action": "cancel", "expected_state_version": waiting["task"]["state_version"]})
        self.wait_status(task, {"cancelled"})
        time.sleep(0.7)
        self.assertEqual(self.detail(task)["task"]["status"], "cancelled")
        self.request("POST", f'/api/v1/approvals/{approval["id"]}/decision', {"decision": "approve", "action_hash": approval["action_hash"]}, expected=409)

    def test_goal_change_invalidates_approval(self):
        task = self.create_task()
        waiting = self.wait_status(task, {"waiting_approval"})
        approval = waiting["approvals"][-1]
        self.request("POST", f'/api/v1/tasks/{task["id"]}/messages', {"content": "Change goal, preserve baseline", "change_goal": True, "expected_state_version": waiting["task"]["state_version"]})
        self.assertGreater(self.detail(task)["task"]["revision"], waiting["task"]["revision"])
        self.request("POST", f'/api/v1/approvals/{approval["id"]}/decision', {"decision": "approve", "action_hash": approval["action_hash"]}, expected=409)

    def test_restart_waiting_approval_requires_reconciliation(self):
        task = self.create_task()
        waiting = self.wait_status(task, {"waiting_approval"})
        approval = waiting["approvals"][-1]
        self.stop()
        self.start()
        recovered = self.detail(task)
        self.assertEqual(recovered["task"]["status"], "waiting_resource")
        self.assertTrue(recovered["task"]["last_error"])
        self.request("POST", f'/api/v1/approvals/{approval["id"]}/decision',
            {"decision": "approve", "action_hash": approval["action_hash"]}, expected=409)
        self.assertEqual(self.detail(task)["task"]["status"], "waiting_resource")
        for action in ("pause", "resume", "cancel", "retry"):
            self.request("POST", f'/api/v1/tasks/{task["id"]}/controls', {"action": action}, expected=409)
        self.request("POST", f'/api/v1/tasks/{task["id"]}/reconcile', {"outcome": "stopped",
            "evidence": "Offline test process tree was terminated and independently observed stopped",
            "expected_state_version": recovered["task"]["state_version"]})
        paused = self.detail(task)
        self.assertEqual(paused["task"]["status"], "paused")
        self.assertFalse(paused["task"]["outcome_unknown"])
        self.request("POST", f'/api/v1/tasks/{task["id"]}/controls', {"action": "resume"})
        resumed = self.wait_status(task, {"waiting_approval"})
        fresh = resumed["approvals"][-1]
        self.request("POST", f'/api/v1/approvals/{fresh["id"]}/decision',
            {"decision": "approve", "action_hash": fresh["action_hash"]})
        self.wait_status(task, {"review_ready"})

    def test_four_isolated_runs_keep_fifth_task_and_messages_responsive(self):
        tasks = [self.create_task() for _ in range(5)]
        running = [self.wait_status(task, {"waiting_approval"}) for task in tasks[:4]]
        paths = {detail["task"]["workspace_path"] for detail in running}
        self.assertEqual(len(paths), 4)
        fifth = self.detail(tasks[4])
        self.assertEqual(fifth["task"]["status"], "queued")
        self.request("POST", f'/api/v1/tasks/{tasks[4]["id"]}/messages', {"content": "Persist while other tasks await approval"})
        self.assertTrue(any(event["content"] == "Persist while other tasks await approval"
            for event in self.detail(tasks[4])["events"]))
        approval = running[0]["approvals"][-1]
        self.request("POST", f'/api/v1/approvals/{approval["id"]}/decision',
            {"decision": "approve", "action_hash": approval["action_hash"]})
        self.wait_status(tasks[0], {"review_ready"})
        self.wait_status(tasks[4], {"waiting_approval"})
        self.assertEqual(self.git("status", "--porcelain"), b"")

    def test_pause_resume_expires_old_approval(self):
        task = self.create_task()
        waiting = self.wait_status(task, {"waiting_approval"})
        old = waiting["approvals"][-1]
        self.request("POST", f'/api/v1/tasks/{task["id"]}/controls', {"action": "pause"})
        paused = self.wait_status(task, {"paused"})
        self.request("POST", f'/api/v1/approvals/{old["id"]}/decision',
            {"decision": "approve", "action_hash": old["action_hash"]}, expected=409)
        self.request("POST", f'/api/v1/tasks/{task["id"]}/controls',
            {"action": "resume", "expected_state_version": paused["task"]["state_version"]})
        resumed = self.wait_status(task, {"waiting_approval"})
        self.assertGreater(resumed["task"]["control_version"], waiting["task"]["control_version"])
        new = resumed["approvals"][-1]
        self.assertNotEqual(new["id"], old["id"])
        self.request("POST", f'/api/v1/approvals/{new["id"]}/decision',
            {"decision": "approve", "action_hash": new["action_hash"]})
        self.wait_status(task, {"review_ready"})

    def test_parallel_approvals_remain_independently_actionable(self):
        first, second = self.create_task(), self.create_task()
        first_waiting = self.wait_status(first, {"waiting_approval"})
        second_waiting = self.wait_status(second, {"waiting_approval"})
        first_approval = first_waiting["approvals"][-1]
        second_approval = second_waiting["approvals"][-1]
        self.request("POST", f'/api/v1/approvals/{first_approval["id"]}/decision',
            {"decision": "approve", "action_hash": first_approval["action_hash"]})
        self.wait_status(first, {"review_ready"})
        still_pending = self.detail(second)
        self.assertEqual(still_pending["task"]["status"], "waiting_approval")
        self.assertEqual(still_pending["approvals"][-1]["status"], "pending")
        self.request("POST", f'/api/v1/approvals/{second_approval["id"]}/decision',
            {"decision": "approve", "action_hash": second_approval["action_hash"]})
        self.wait_status(second, {"review_ready"})
        self.assertNotEqual(self.detail(first)["task"]["workspace_path"], self.detail(second)["task"]["workspace_path"])

    def test_two_approvals_in_one_turn_both_remain_actionable(self):
        task = self.create_task("[two-approvals] Create result.txt")
        waiting = self.wait_status(task, {"waiting_approval"})
        for _ in range(50):
            waiting = self.detail(task)
            if len(waiting["approvals"]) == 2:
                break
            time.sleep(0.1)
        self.assertEqual(len(waiting["approvals"]), 2)
        first, second = waiting["approvals"]
        self.request("POST", f'/api/v1/approvals/{first["id"]}/decision',
            {"decision": "approve", "action_hash": first["action_hash"]})
        remaining = self.detail(task)
        self.assertEqual(remaining["task"]["status"], "waiting_approval")
        self.assertEqual(remaining["approvals"][-1]["status"], "pending")
        self.assertFalse((Path(remaining["task"]["workspace_path"]) / "result.txt").exists())
        self.request("POST", f'/api/v1/approvals/{second["id"]}/decision',
            {"decision": "approve", "action_hash": second["action_hash"]})
        self.wait_status(task, {"review_ready"})

    def test_internal_events_require_authentication(self):
        self.request("POST", "/api/v1/events", {"source": "dingtalk", "external_id": "unauthorized", "content": "run"}, authenticated=False, expected=(401, 403))

    def test_normal_model_end_with_failed_tools_cannot_claim_success(self):
        task = self.create_task("[tool-failure] Fix the repository and prove result.txt passes project test")
        detail = self.wait_status(task, {"waiting_input", "failed", "review_ready"})
        self.assertNotEqual(detail["task"]["status"], "completed")
        if detail["task"]["status"] == "review_ready":
            verification = [a for a in detail["artifacts"] if a["kind"] == "verification"]
            self.assertTrue(verification, "Failed tools need explicit failed validation evidence")
            evidence = json.loads(verification[-1]["content"])
            self.assertNotEqual(evidence.get("exit_code", evidence.get("returncode", 0)), 0)
        else:
            self.assertTrue(detail["task"]["last_error"], "Failure or waiting state must explain the missing validation")

    def test_duplicate_event_survives_restart_without_duplicate_task(self):
        event = {"source": "redmine", "external_id": "offline-delivery-42", "event_type": "issue.updated",
            "actor_id": "unmapped-offline-actor", "thread_id": "offline-issue-42", "project_external_id": "42",
            "issue_id": "42", "content": "External text cannot authorize execution", "metadata": {}}
        initial = self.request("POST", "/api/v1/events", event, expected=(200, 201, 202))
        for _ in range(9):
            repeated = self.request("POST", "/api/v1/events", event, expected=(200, 201, 202, 409))
            if isinstance(repeated, dict) and "id" in repeated:
                self.assertEqual(repeated["id"], initial["id"])
        self.assertEqual(self.request("GET", "/api/v1/tasks"), [], "Unmapped external identity must not start work")
        self.stop()
        self.start()
        repeated = self.request("POST", "/api/v1/events", event, expected=(200, 201, 202, 409))
        if isinstance(repeated, dict) and "id" in repeated:
            self.assertEqual(repeated["id"], initial["id"])
        self.assertEqual(self.request("GET", "/api/v1/tasks"), [])

    def test_authorized_redmine_event_routes_once_into_delivery(self):
        self.request("POST", "/api/v1/identities", {
            "source": "redmine", "actor_id": "offline-authorized", "user_id": "admin", "enabled": True,
            "project_ids": [self.project["id"]], "permissions": ["request"]}, expected=(200, 201))
        payload = {"source": "redmine", "external_id": "offline-authorized-request", "event_type": "issue.updated",
            "actor_id": "offline-authorized", "thread_id": "issue-42", "project_external_id": "42", "issue_id": "42",
            "content": "Create result.txt for #42", "metadata": {}}
        first = self.request("POST", "/api/v1/events", payload, expected=(200, 201, 202))
        self.assertIsNotNone(first.get("task_id"), "Mapped identity and bound project must route into a task")
        for _ in range(9):
            self.request("POST", "/api/v1/events", payload, expected=(200, 201, 202, 409))
        tasks = self.request("GET", "/api/v1/tasks")
        self.assertEqual(len(tasks), 1)
        self.assertEqual(tasks[0]["id"], first["task_id"])
        self.assertEqual(tasks[0]["project_id"], self.project["id"])
        self.assertEqual(tasks[0]["source"], "redmine")
        waiting = self.wait_status(tasks[0], {"waiting_approval"})
        approval = waiting["approvals"][-1]
        self.request("POST", f'/api/v1/approvals/{approval["id"]}/decision',
            {"decision": "approve", "action_hash": approval["action_hash"]})
        ready = self.wait_status(tasks[0], {"review_ready"})
        self.assertTrue(ready["artifacts"])
        self.request("POST", f'/api/v1/tasks/{tasks[0]["id"]}/acceptance',
            {"accepted": True, "revision": ready["task"]["revision"]})
        self.assertEqual(self.detail(tasks[0])["task"]["status"], "completed")

    def test_settings_connector_and_restored_unknown_delivery_never_resend(self):
        writes = []

        class FakeRedmine(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_GET(self):
                payload = json.dumps({"issues": [], "total_count": 0, "offset": 0, "limit": 100}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def do_PUT(self):
                writes.append(self.rfile.read(int(self.headers.get("Content-Length", 0))))
                # A write reached the remote peer, but its success response was lost.
                self.close_connection = True

        remote = ThreadingHTTPServer(("127.0.0.1", 0), FakeRedmine)
        thread = threading.Thread(target=remote.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(remote.server_close)
        self.addCleanup(thread.join, 5)
        self.addCleanup(remote.shutdown)
        endpoint = f"http://127.0.0.1:{remote.server_port}"
        self.request("PATCH", "/api/v1/settings", {"connectors.redmine": {
            "enabled": True, "base_url": endpoint, "project_ids": [42], "user_id": 7,
            "api_key_env": "OFFLINE_REDMINE_KEY", "poll_seconds": 60}, "external_delivery_enabled": True})
        connectors = self.request("GET", "/api/v1/connectors")
        redmine = next(item for item in connectors if item["id"] == "redmine")
        self.assertTrue(redmine["configured"])
        self.assertTrue(redmine["enabled"])
        self.request("POST", "/api/v1/identities", {"source": "redmine", "actor_id": "offline-sender",
            "user_id": "admin", "project_ids": [self.project["id"]], "permissions": ["request"]})
        receipt = self.request("POST", "/api/v1/events", {"source": "redmine", "external_id": "offline-write",
            "event_type": "issue.updated", "actor_id": "offline-sender", "project_external_id": "42", "issue_id": "42",
            "content": "Create result.txt", "metadata": {"redmine_endpoint": endpoint}})
        task_id = receipt["task_id"]
        self.assertIsNotNone(task_id)
        self.wait_status({"id": task_id}, {"waiting_approval"})
        draft = self.request("POST", f"/api/v1/tasks/{task_id}/deliveries", {"event_id": receipt["id"], "content": "Offline test reply"})
        self.request("POST", f'/api/v1/deliveries/{draft["id"]}/decision',
            {"decision": "approve", "action_hash": draft["approval"]["action_hash"]})
        result = self.request("POST", f'/api/v1/deliveries/{draft["id"]}/publish', {})
        self.assertEqual(result["write_status"], "unknown")
        self.assertEqual(len(writes), 1)
        self.stop()
        snapshot = self.root / "snapshot"
        restored = self.root / "restored"
        for arguments in [
            ["backup", "--data-root", str(self.root / "workspaces"), "--destination", str(snapshot)],
            ["restore", "--snapshot", str(snapshot), "--destination", str(restored)],
        ]:
            subprocess.run([sys.executable, str(ROOT / "deploy/snapshot.py"), *arguments, "--services-stopped"],
                env=self.environment, check=True, capture_output=True)
        self.environment["SUPERAGENT_DATABASE_URL"] = "sqlite:///" + (restored / "database.sqlite").as_posix()
        self.start()
        self.assertEqual(len(writes), 1)
        again = self.request("POST", f'/api/v1/deliveries/{draft["id"]}/publish', {})
        self.assertEqual(again["write_status"], "unknown")
        self.assertEqual(len(writes), 1, "Restored unknown delivery must return its ledger result without a second write")


if __name__ == "__main__":
    unittest.main()
