"""Windows-only characterization and safety gates for the pinned Python oracle."""
import asyncio
import hashlib
import faulthandler
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
ORACLE = ROOT / ".rewrite-oracle"
PIN = "abf0a6922e8da03d65cd53458df256a509d824c3fbf276f58943cc800201b091"


def verify_source():
    manifest = json.loads((ROOT / "docs/rewrite/oracle.json").read_text("utf-8"))
    hashes = {name: hashlib.sha256((ORACLE / name).read_bytes()).hexdigest()
              for name in manifest["files"]}
    fingerprint = hashlib.sha256(json.dumps(hashes, sort_keys=True).encode()).hexdigest()
    if hashes != manifest["files"] or fingerprint != PIN or manifest["fingerprint"] != PIN:
        raise RuntimeError("oracle fingerprint mismatch")
    print(f"oracle {fingerprint}, {len(hashes)} files", flush=True)


if sys.platform != "win32":
    raise SystemExit("Windows process evidence required")
verify_source()
sys.path.insert(0, str(ORACLE))
from superagent.connectors import media
from superagent.runtime.codex import CodexAppServer, UnknownOutcome
sys.path.insert(0, str(HERE))
from win_signal import ExitSignal


class OracleCases(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.root = Path(self.enterContext(tempfile.TemporaryDirectory(prefix="离线 样本 ", dir=HERE)))
        profile = self.root / "profile"
        service = self.root / "service"
        system = os.environ["SystemRoot"]
        environment = {"SystemRoot": system, "PATH": str(Path(system) / "System32"),
                       "TEMP": str(self.root), "TMP": str(self.root), "USERPROFILE": str(profile),
                       "CODEX_HOME": str(profile / ".codex"), "SUPERAGENT_CODEX_HOME": str(service)}
        for name in ("OPENAI_API_KEY", "CODEX_API_KEY", "DINGTALK_APP_SECRET",
                     "REDMINE_API_KEY", "DATABASE_URL", "SUPERAGENT_API_TOKEN"):
            environment[name] = "synthetic-review-" + name.lower()
        environment["OPENAI_API_KEY"] = "synthetic-review-diagnostic"
        self.enterContext(patch.dict(os.environ, environment, clear=True))

    def command(self, mode):
        return [sys.executable, "-I", "-B", str(HERE / "fake_process.py"), mode, str(self.root)]

    async def client(self, mode, existing=False):
        client = CodexAppServer(self.command(mode), str(self.root), {"timeout": 4},
                                use_existing_login=existing)
        await client.start()
        self.addAsyncCleanup(client.close)
        return client

    async def leaf(self):
        async with asyncio.timeout(3):
            pid_file = self.root / "leaf.pid"
            while not pid_file.exists() or not pid_file.stat().st_size:
                await asyncio.sleep(0.02)
        leaf = ExitSignal(int(pid_file.read_text("ascii")))
        def stop():
            (self.root / "stop").touch()
            try:
                self.assertTrue(leaf.exited(3000), "fixture did not stop")
            finally:
                leaf.close()
        self.addCleanup(stop)
        self.assertFalse(leaf.exited(0))
        return leaf

    async def tree_case(self, mode):
        client = await self.client(mode)
        leaf = await self.leaf()
        parent = ExitSignal(client.process.pid)
        self.addCleanup(parent.close)
        self.assertFalse(parent.exited(0))
        await asyncio.wait_for(client.close(), 6)
        self.assertTrue(parent.exited(1000))
        self.assertTrue(leaf.exited(1000), "root exited but descendant is still live")

    async def test_tree_normal_eof(self):
        await self.tree_case("tree")

    async def test_tree_forced(self):
        await self.tree_case("tree-force")

    async def media_case(self, mode):
        task = asyncio.create_task(media._collect(self.command("media"), self.root,
                                   timeout=3 if mode == "timeout" else 8, max_files=8,
                                   max_bytes=2048, max_total_bytes=4096, poll_interval=0.03))
        try:
            leaf = await self.leaf()
            if mode == "normal":
                (self.root / "release").touch()
                self.assertEqual(await asyncio.wait_for(task, 5), {})
            elif mode == "cancel":
                task.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await asyncio.wait_for(task, 5)
            else:
                with self.assertRaisesRegex(media.ConnectorError, "media_timeout"):
                    await asyncio.wait_for(task, 5)
            self.assertTrue(leaf.exited(1000))
        finally:
            if not task.done():
                task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    async def test_media_normal(self):
        await self.media_case("normal")

    async def test_media_timeout(self):
        await self.media_case("timeout")

    async def test_media_cancel(self):
        await self.media_case("cancel")

    async def test_media_job_unavailable(self):
        with patch.object(media, "_WindowsJob", side_effect=media.ConnectorError("job unavailable")):
            with self.assertRaisesRegex(media.ConnectorError, "job unavailable"):
                await asyncio.wait_for(media._collect(self.command("media"), self.root, timeout=3,
                                       max_files=8, max_bytes=2048, max_total_bytes=4096,
                                       poll_interval=0.03), 6)
        self.assertFalse((self.root / "leaf.pid").exists(), "unassigned collector executed")

    async def env_case(self, existing):
        client = await self.client("env", existing)
        seen = await client._request("env/check", {})
        self.assertTrue(seen["argv_clean"])
        self.assertTrue(seen["selected_home" if existing else "service_home"])
        self.assertEqual({key for key, value in seen["present"].items() if value},
                         set() if existing else {"OPENAI_API_KEY", "CODEX_API_KEY"})
        for feature in ("plugins", "apps", "hooks", "remote_plugin", "plugin_discovery_prefetch"):
            self.assertIn(("--disable", feature), list(zip(seen["argv"], seen["argv"][1:])))
        if existing:
            self.assertIn("mcp_servers={}", seen["argv"])

    async def test_service_env(self):
        await self.env_case(False)

    async def test_selected_synthetic_home(self):
        await self.env_case(True)

    async def turn_case(self, mode):
        client = await self.client(mode)
        if mode == "ok":
            self.assertEqual(await client.start_turn("thread-review", "fixture"), {"id": "turn-review"})
        else:
            client.timeout = 0.5
            with self.assertRaises(UnknownOutcome):
                await client.start_turn("thread-review", "fixture")
            if mode == "late":
                (self.root / "release").touch()
                client.timeout = 3
                self.assertTrue((await client._request("env/check", {}))["service_home"])
                event = await asyncio.wait_for(anext(client.events()), 2)
                self.assertEqual(event["method"], "runtime/late_response")
        await client.close()
        self.assertEqual((self.root / "receipts").read_text("ascii").splitlines(), ["accepted"])

    async def test_turn_ok(self):
        await self.turn_case("ok")

    async def test_turn_eof(self):
        await self.turn_case("eof")

    async def test_turn_late(self):
        await self.turn_case("late")

    async def test_diagnostic_value_excluded(self):
        client = await self.client("env")
        await client._request("review/diagnostic", {})
        event = await asyncio.wait_for(anext(client.events()), 2)
        self.assertEqual(event["method"], "runtime/stderr")
        self.assertFalse("synthetic-review-diagnostic" in json.dumps(event),
                         "raw fixture marker exposed in runtime/stderr")


if __name__ == "__main__":
    # Also bound event-loop initialization on hosts that block the local asyncio wakeup socket.
    faulthandler.dump_traceback_later(90, exit=True)
    unittest.main(verbosity=2)
