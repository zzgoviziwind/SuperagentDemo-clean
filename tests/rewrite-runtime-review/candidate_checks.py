"""Run from any cwd. Set REVIEW_NODE to select an installed Node executable."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import unittest

HERE = Path(__file__).resolve().parent
PACKAGE = HERE.parents[1] / "packages" / "runtime"
NODE = os.environ.get("REVIEW_NODE") or shutil.which("node")
if sys.platform != "win32" or not NODE:
    raise SystemExit("Windows and a local Node executable are required")
sys.path.insert(0, str(HERE))
from win_signal import ExitSignal


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def sources():
    return {p.relative_to(PACKAGE).as_posix(): digest(p) for p in PACKAGE.rglob("*")
            if p.is_file() and p.suffix in {".ts", ".mjs", ".cjs", ".json"}
            and "node_modules" not in p.parts}


class CandidateCases(unittest.TestCase):
    def setUp(self):
        self.root = Path(self.enterContext(tempfile.TemporaryDirectory(dir=HERE, prefix="阶段1 样本 ")))
        self.entry = PACKAGE / "index.ts"
        self.env = {"SystemRoot": os.environ["SystemRoot"], "TEMP": str(self.root), "TMP": str(self.root),
                    "USERPROFILE": str(self.root), "HOME": str(self.root),
                    "CODEX_HOME": str(self.root / "synthetic-account")}
        for key in ("OPENAI_API_KEY", "CODEX_API_KEY", "SUPERAGENT_API_TOKEN",
                    "REDMINE_API_KEY", "DINGTALK_APP_SECRET", "DATABASE_URL"):
            self.env[key] = "synthetic-review-marker"

    def driver(self, mode):
        if not mode.startswith("channel-"):
            # Only the protocol peer is replaced; use the same public entry and transport bytes.
            copied = self.root / "runtime"
            shutil.copytree(PACKAGE, copied, ignore=shutil.ignore_patterns("node_modules", "test"))
            self.assertEqual(digest(copied / "fake-codex.ts"), digest(PACKAGE / "fake-codex.ts"))
            shutil.copyfile(HERE / "probe-fixture.mjs", copied / "fixtures" / "fake-app-server.ts")
            self.entry = copied / "index.ts"
            (self.root / "mode").write_text(mode, "ascii")
        return [NODE, str(HERE / "candidate_driver.mjs"), str(self.entry), mode]

    def run_case(self, mode):
        result = subprocess.run(self.driver(mode), cwd=self.root, env=self.env, capture_output=True,
                                timeout=15, encoding="utf-8", errors="replace")
        self.assertEqual(result.returncode, 0, result.stderr)

    def tree_case(self, mode):
        (self.root / "helpers.json").write_text(json.dumps({
            "python": sys.executable, "script": str(HERE / "fake_process.py")
        }), "utf-8")
        proc = subprocess.Popen(self.driver(mode), cwd=self.root, env=self.env, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, encoding="utf-8", errors="replace")
        handles = []
        try:
            names = ["driver-ready", "leaf.pid"]
            if mode.startswith("tree-mixed-"):
                names.insert(1, "middle.pid")
            for name in names:
                path = self.root / name
                end = time.monotonic() + 6
                while not path.exists() or not path.stat().st_size:
                    if proc.poll() is not None:
                        self.fail(proc.communicate()[1] or "driver exited before readiness")
                    if time.monotonic() >= end:
                        self.fail("fixture failed to register " + name)
                    time.sleep(0.02)
                signal = ExitSignal(int(path.read_text("ascii")))
                handles.append(signal)
                self.assertFalse(signal.exited(0), name + " exited before observation")
            (self.root / "go").touch()
            if mode.endswith("-owner"):
                _, err = proc.communicate(timeout=8)
                self.assertEqual(proc.returncode, 34, err)
            else:
                end = time.monotonic() + 7
                while not (self.root / "closed").exists():
                    self.assertIsNone(proc.poll(), "owner ended before close observation")
                    self.assertLess(time.monotonic(), end, "close deadline exceeded")
                    time.sleep(0.02)
            remaining = [name for name, handle in zip(names, handles) if not handle.exited(1000)]
            self.assertEqual(remaining, [], "fixture process still live")
        finally:
            (self.root / "go").touch()
            (self.root / "observer-done").touch()
            (self.root / "stop").touch()
            try:
                if proc.poll() is None:
                    try:
                        proc.communicate(timeout=4)
                    except subprocess.TimeoutExpired:
                        proc.kill()
                        proc.communicate(timeout=3)
                for handle in handles:
                    self.assertTrue(handle.exited(4000), "fixture cleanup incomplete")
            finally:
                for handle in handles:
                    handle.close()
                proc.stdout.close()
                proc.stderr.close()

    def test_tree_normal(self):
        self.tree_case("tree-normal")

    def test_tree_forced(self):
        self.tree_case("tree-force")

    def test_tree_owner_exit(self):
        self.tree_case("tree-owner")

    def test_mixed_tree_normal(self):
        self.tree_case("tree-mixed-normal")

    def test_mixed_tree_forced(self):
        self.tree_case("tree-mixed-force")

    def test_mixed_tree_owner_exit(self):
        self.tree_case("tree-mixed-owner")

    def test_turn_confirmed_and_stderr_private(self):
        self.run_case("ok")

    def test_turn_unknown_eof(self):
        self.run_case("eof")

    def test_turn_unknown_timeout(self):
        self.run_case("timeout")

    def test_created_thread_with_unusable_ack_is_unknown(self):
        self.run_case("thread-uncertain")

    def test_env_excludes_parent_secrets(self):
        self.run_case("environment")

    def test_prompt_and_environment_excluded_from_argv(self):
        self.run_case("argv")

    def test_channel_receipt_with_lost_confirmation(self):
        self.run_case("channel-receipt")

    def test_channel_error_excludes_adapter_diagnostics(self):
        self.run_case("channel-error")

    def test_bundled_offline_cases(self):
        result = subprocess.run([NODE, "--test", "--test-reporter=tap", str(PACKAGE / "test/runtime.test.ts")],
                                env=self.env, cwd=self.root, capture_output=True,
                                timeout=90, encoding="utf-8", errors="replace")
        totals = [line for line in result.stdout.splitlines() if line.startswith(("# tests ", "# pass ", "# fail "))]
        print("Bundled suite:", ", ".join(totals), flush=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertTrue(any(line.startswith("# pass ") and int(line.split()[-1]) > 0 for line in totals))


if __name__ == "__main__":
    baseline = sources()
    print("Node", subprocess.check_output([NODE, "--version"], text=True).strip(), flush=True)
    for name, sha in sorted(baseline.items()):
        print(f"{sha}  {name}", flush=True)
    suite = unittest.main(verbosity=2, exit=False)
    if baseline != sources():
        raise SystemExit("candidate changed during this run; repeat against current files")
    raise SystemExit(0 if suite.result.wasSuccessful() else 1)
