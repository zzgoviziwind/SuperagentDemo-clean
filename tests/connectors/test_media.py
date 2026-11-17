import asyncio
import ctypes
from ctypes import wintypes
import hashlib
import os
from pathlib import Path
import sys
import tempfile
import unittest

from superagent.connectors.common import ConnectorError
from superagent.connectors.dingtalk import DingTalkClient


class MediaTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)

    async def asyncTearDown(self):
        self.directory.cleanup()

    def client(self, mode="success", *arguments):
        return DingTalkClient([sys.executable, str(Path(__file__).with_name("fake_media.py")), mode, *arguments],
                              profile="org:user")

    async def test_real_fake_cli_download_validates_hash_and_retains_existing(self):
        (self.root / "existing.png").write_bytes(b"keep")
        result = await self.client().download_message_resources("chat1", "m1", self.root)
        self.assertTrue(result["complete"])
        self.assertFalse(result["network_bytes_hard_limited"])
        item = result["attachments"][0]
        path = Path(item["local_path"])
        self.assertTrue(path.is_relative_to(self.root))
        self.assertEqual(item["sha256"], hashlib.sha256(path.read_bytes()).hexdigest())
        self.assertEqual(item["resource_id"], "fake-resource")
        self.assertEqual((self.root / "existing.png").read_bytes(), b"keep")
        self.assertEqual(list(self.root.glob(".dws-media-*")), [])

    async def test_bad_ledger_files_and_signatures_never_publish(self):
        for mode in ("signature", "unlisted", "hardlink", "traversal", "size", "message", "partial"):
            with self.subTest(mode=mode), self.assertRaises(ConnectorError):
                await self.client(mode).download_message_resources("chat1", "m1", self.root)
            self.assertEqual(list(self.root.iterdir()), [])

    async def test_per_file_total_and_count_budgets_clean_up(self):
        for mode, limits in (("oversize", {"max_bytes": 100}),
                             ("oversize", {"max_total_bytes": 100}), ("count", {"max_files": 2})):
            with self.subTest(mode=mode, limits=limits), self.assertRaisesRegex(ConnectorError, "budget"):
                await self.client(mode).download_message_resources("chat1", "m1", self.root, **limits)
            self.assertEqual(list(self.root.iterdir()), [])

    async def test_timeout_and_stdout_budget_clean_up(self):
        with self.assertRaisesRegex(ConnectorError, "timeout"):
            await self.client("timeout").download_message_resources("chat1", "m1", self.root, timeout=2)
        self.assertEqual(list(self.root.iterdir()), [])
        with self.assertRaisesRegex(ConnectorError, "output_limit"):
            await self.client("flood").download_message_resources("chat1", "m1", self.root)
        self.assertEqual(list(self.root.iterdir()), [])

    async def test_cancellation_cleans_up_owned_directory(self):
        task = asyncio.create_task(self.client("timeout").download_message_resources("chat1", "m1", self.root))
        while not list(self.root.glob(".dws-media-*")):
            await asyncio.sleep(0.01)
        await asyncio.sleep(0.1)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertEqual(list(self.root.iterdir()), [])

    @unittest.skipUnless(os.name == "nt", "Windows Job Object process-tree regression")
    async def test_successful_parent_also_terminates_own_descendant(self):
        with tempfile.TemporaryDirectory() as marker_dir:
            marker = Path(marker_dir) / "child.pid"
            result = await self.client("child", str(marker)).download_message_resources("chat1", "m1", self.root)
            self.assertTrue(result["complete"])
            pid = int(marker.read_text())
            kernel = ctypes.WinDLL("kernel32", use_last_error=True)
            kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
            kernel.OpenProcess.restype = wintypes.HANDLE
            kernel.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
            kernel.CloseHandle.argtypes = [wintypes.HANDLE]
            handle = kernel.OpenProcess(0x1000, False, pid)
            if handle:
                try:
                    code = wintypes.DWORD()
                    self.assertTrue(kernel.GetExitCodeProcess(handle, ctypes.byref(code)))
                    self.assertNotEqual(code.value, 259)
                finally:
                    kernel.CloseHandle(handle)
