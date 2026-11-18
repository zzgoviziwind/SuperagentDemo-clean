"""Finite, offline process fixtures. All paths are supplied by the review runner."""
import json
import os
from pathlib import Path
import subprocess
import sys
import time


def wait_file(path, seconds):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        if path.exists():
            return
        time.sleep(0.02)


def start_leaf(root):
    subprocess.Popen([sys.executable, "-I", "-B", __file__, "leaf", str(root)],
                     stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                     stderr=subprocess.DEVNULL)


def respond(ident, result):
    print(json.dumps({"id": ident, "result": result}), flush=True)


def server(root, mode):
    for line in sys.stdin:
        message = json.loads(line)
        method = message.get("method")
        if method == "initialize":
            if mode in {"tree", "tree-force"}:
                start_leaf(root)
            respond(message["id"], {})
        elif method == "env/check":
            names = ("REDMINE_API_KEY", "SUPERAGENT_API_TOKEN", "DATABASE_URL",
                     "DINGTALK_APP_SECRET", "OPENAI_API_KEY", "CODEX_API_KEY")
            respond(message["id"], {
                "present": {name: name in os.environ for name in names},
                "service_home": os.environ.get("CODEX_HOME") == str(root / "service"),
                "selected_home": os.environ.get("CODEX_HOME") == str(root / "profile" / ".codex"),
                "argv_clean": all("synthetic-review-" not in arg for arg in sys.argv),
                "argv": [arg for arg in sys.argv[3:] if "synthetic-review-" not in arg],
            })
        elif method == "turn/start":
            with (root / "receipts").open("a", encoding="ascii") as receipt:
                receipt.write("accepted\n")
            if mode == "eof":
                return
            if mode == "late":
                wait_file(root / "release", 8)
            respond(message["id"], {"turn": {"id": "turn-review"}})
        elif method == "turn/interrupt":
            respond(message["id"], {})
            print(json.dumps({"method": "turn/completed",
                              "params": {"threadId": "thread-review", "turn": {"id": "turn-review"}}}), flush=True)
        elif method == "review/diagnostic":
            print("synthetic-review-diagnostic", file=sys.stderr, flush=True)
            respond(message["id"], {})
    if mode == "tree-force":
        wait_file(root / "stop", 12)


if __name__ == "__main__":
    mode, root = sys.argv[1], Path(sys.argv[2])
    if mode == "leaf":
        (root / "leaf.pid").write_text(str(os.getpid()), encoding="ascii")
        wait_file(root / "stop", 20)
    elif mode == "bridge":
        (root / "middle.pid").write_text(str(os.getpid()), encoding="ascii")
        start_leaf(root)
        wait_file(root / "stop", 20)
    elif mode == "media":
        start_leaf(root)
        wait_file(root / "release", 15)
        print("{}", flush=True)
    else:
        server(root, mode)
