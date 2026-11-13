"""Offline app-server peer. Used only by the HTTP black-box acceptance suite."""
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import time

sys.stdin.reconfigure(encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8")

lock = threading.Lock()
workspace = Path.cwd()
turn_number = 0
thread_id = "offline-thread"
pending = {}
required_approvals = {}
verification_command = ""


def verify_project(turn_id):
    flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
    result = subprocess.run(verification_command, shell=True, cwd=workspace, capture_output=True,
        text=True, encoding="utf-8", errors="replace", timeout=30, creationflags=flags)
    emit({"method": "item/completed", "params": {"threadId": thread_id, "turnId": turn_id,
        "item": {"id": "project-test", "type": "commandExecution", "command": verification_command,
            "cwd": str(workspace), "status": "completed" if result.returncode == 0 else "failed",
            "exitCode": result.returncode, "aggregatedOutput": result.stdout + result.stderr}}})


def emit(value):
    with lock:
        print(json.dumps(value), flush=True)


def finish(turn_id, delay=0):
    time.sleep(delay)
    emit({"method": "item/completed", "params": {
        "threadId": thread_id, "turnId": turn_id,
        "item": {"id": "summary", "type": "agentMessage", "text": json.dumps({
            "status": "completed", "summary": "Offline fixture produced result.txt. Real Codex is unverified."})}}})
    emit({"method": "turn/completed", "params": {
        "threadId": thread_id, "turn": {"id": turn_id, "status": "completed"}}})


for line in sys.stdin:
    message = json.loads(line)
    method = message.get("method")
    params = message.get("params", {})
    if method is None:
        turn_id = pending.pop(message.get("id"), None)
        if turn_id and message.get("result", {}).get("decision") in ("accept", "acceptForSession"):
            required_approvals[turn_id].discard(message["id"])
            if required_approvals[turn_id]:
                continue
            (workspace / "result.txt").write_text("verified offline artifact\n", encoding="utf-8")
            verify_project(turn_id)
            threading.Thread(target=finish, args=(turn_id, 0.1), daemon=True).start()
        continue
    if "id" not in message:
        continue
    if method == "initialize":
        result = {"userAgent": "offline-e2e"}
    elif method == "thread/start":
        workspace = Path(params["cwd"])
        result = {"thread": {"id": thread_id}}
    elif method in ("thread/resume", "thread/read"):
        result = {"thread": {"id": thread_id, "turns": []}}
    elif method == "turn/start":
        prompt = "\n".join(entry.get("text", "") for entry in params.get("input", []))
        verification_command = next((line.split("：", 1)[1] for line in prompt.splitlines()
            if line.startswith("项目配置的验证命令：")), "")
        turn_number += 1
        turn_id = f"offline-turn-{turn_number}"
        emit({"id": message["id"], "result": {"turn": {"id": turn_id, "status": "inProgress"}}})
        if any("[tool-failure]" in entry.get("text", "") for entry in params.get("input", [])):
            emit({"method": "item/completed", "params": {"threadId": thread_id, "turnId": turn_id,
                "item": {"id": "blocked-command", "type": "commandExecution", "command": "test",
                    "status": "failed", "exitCode": 1, "aggregatedOutput": "blocked by policy"}}})
            emit({"method": "item/completed", "params": {"threadId": thread_id, "turnId": turn_id,
                "item": {"id": "failure-summary", "type": "agentMessage", "text": "Tools blocked by policy. No files changed. Tests could not run."}}})
            emit({"method": "turn/completed", "params": {"threadId": thread_id,
                "turn": {"id": turn_id, "status": "completed"}}})
            continue
        approval_id = 1000 + turn_number
        pending[approval_id] = turn_id
        required_approvals[turn_id] = {approval_id}
        emit({"id": approval_id, "method": "item/fileChange/requestApproval", "params": {
            "threadId": thread_id, "turnId": turn_id, "itemId": "write-result",
            "reason": "Create offline result.txt inside isolated workspace", "grantRoot": str(workspace)}})
        if any("[two-approvals]" in entry.get("text", "") for entry in params.get("input", [])):
            second_id = 2000 + turn_number
            pending[second_id] = turn_id
            required_approvals[turn_id].add(second_id)
            emit({"id": second_id, "method": "item/commandExecution/requestApproval", "params": {
                "threadId": thread_id, "turnId": turn_id, "itemId": "verify-result",
                "command": "offline verification", "cwd": str(workspace)}})
        continue
    elif method == "turn/interrupt":
        # Deliberately deliver an old completion after an acknowledged interrupt.
        threading.Thread(target=finish, args=(params["turnId"], 0.25), daemon=True).start()
        result = {}
    else:
        result = {}
    emit({"id": message["id"], "result": result})
