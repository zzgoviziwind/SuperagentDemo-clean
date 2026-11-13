import asyncio
import base64
from datetime import timezone, timedelta
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from superagent.connectors.common import ConnectorError
from superagent.connectors.dingtalk import DingTalkClient, DingTalkHistoryReplay, DingTalkListener
from superagent.connectors.history import run_read_json
from superagent.connectors.redmine import RedmineClient


PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=")


class DownloadTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.requests = []
        self.responses = {}
        requests, responses = self.requests, self.responses
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass
            def do_GET(self):
                requests.append((self.path, self.headers.get("X-Redmine-API-Key")))
                status, headers, body = responses.get(self.path, (200, {"Content-Type": "image/png"}, PNG))
                self.send_response(status)
                for key, value in headers.items():
                    self.send_header(key, str(value))
                self.end_headers()
                self.wfile.write(body)
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.root = tempfile.TemporaryDirectory()
        self.client = RedmineClient(f"http://127.0.0.1:{self.server.server_port}", "offline-fake-key")
        self.attachment = {"id": 8, "filename": "截图.png", "content_type": "image/png",
                           "filesize": len(PNG), "content_url": self.client.base_url + "/attachments/download/8/shot.png"}

    async def asyncTearDown(self):
        await self.client.close()
        await asyncio.to_thread(self.server.shutdown)
        self.server.server_close()
        self.thread.join()
        self.root.cleanup()

    async def test_download_hash_and_non_overwrite(self):
        result = await self.client.download_attachment(self.attachment, self.root.name)
        self.assertEqual(Path(result["local_path"]).read_bytes(), PNG)
        self.assertEqual(result["sha256"], hashlib.sha256(PNG).hexdigest())
        self.assertEqual(result["size"], len(PNG))
        self.assertEqual(result["content_type"], "image/png")
        self.assertTrue(Path(result["local_path"]).is_absolute())
        with self.assertRaisesRegex(ConnectorError, "exists"):
            await self.client.download_attachment(self.attachment, self.root.name)
        self.assertEqual(Path(result["local_path"]).read_bytes(), PNG)

    async def test_unsafe_filenames_fail_before_network(self):
        for filename in ("../x.png", "..\\x.png", "C:\\x.png", "x.png:payload", "CON.png", "x.png.", "x/shot.png"):
            with self.subTest(filename=filename), self.assertRaises(ConnectorError):
                await self.client.download_attachment({**self.attachment, "filename": filename}, self.root.name)
        self.assertEqual(self.requests, [])

    async def test_untrusted_origins_and_attachment_route_fail_before_network(self):
        urls = ["http://example.invalid/attachments/download/8/a.png",
                "https://127.0.0.1/attachments/download/8/a.png",
                self.client.base_url.replace("http://", "http://user:pass@") + "/attachments/download/8/a.png",
                self.client.base_url + "/attachments/download/9/a.png",
                self.client.base_url + "/attachments/download/8/%2e%2e/a.png"]
        for url in urls:
            with self.subTest(url=url), self.assertRaises(ConnectorError):
                await self.client.download_attachment({**self.attachment, "content_url": url}, self.root.name)
        self.assertEqual(self.requests, [])

    async def test_redirect_never_forwards_key(self):
        self.responses["/attachments/download/8/shot.png"] = (302, {"Location": self.client.base_url + "/target"}, b"")
        with self.assertRaisesRegex(ConnectorError, "302"):
            await self.client.download_attachment(self.attachment, self.root.name)
        self.assertEqual(len(self.requests), 1)
        self.assertEqual(self.requests[0][1], "offline-fake-key")
        self.assertEqual(list(Path(self.root.name).iterdir()), [])

    async def test_size_preflight_and_stream_limit_cleanup(self):
        with self.assertRaisesRegex(ConnectorError, "size_limit"):
            await self.client.download_attachment(self.attachment, self.root.name, max_bytes=5)
        self.assertEqual(self.requests, [])
        attachment = {**self.attachment}
        attachment.pop("filesize")
        with self.assertRaisesRegex(ConnectorError, "size_limit"):
            await self.client.download_attachment(attachment, self.root.name, max_bytes=5)
        self.assertEqual(list(Path(self.root.name).iterdir()), [])

    async def test_declared_size_limit_and_wrong_metadata(self):
        self.responses["/attachments/download/8/shot.png"] = (200, {"Content-Type": "image/png", "Content-Length": 99999}, b"")
        with self.assertRaisesRegex(ConnectorError, "size_limit"):
            await self.client.download_attachment(self.attachment, self.root.name, max_bytes=1000)
        self.responses.clear()
        with self.assertRaisesRegex(ConnectorError, "incomplete"):
            await self.client.download_attachment({**self.attachment, "filesize": len(PNG) + 1}, self.root.name)
        self.assertEqual(list(Path(self.root.name).iterdir()), [])

    async def test_mime_extension_and_signature_allowlist(self):
        variants = [("text/html", b"<html>content", "shot.png"),
                    ("image/png", b"MZexecutable", "shot.png"),
                    ("image/png", PNG, "shot.exe"),
                    ("image/svg+xml", b"<svg/>", "shot.svg")]
        for mime, body, filename in variants:
            self.responses["/attachments/download/8/shot.png"] = (200, {"Content-Type": mime}, body)
            attachment = {**self.attachment, "content_type": mime, "filename": filename}
            attachment.pop("filesize")
            with self.subTest(mime=mime, filename=filename), self.assertRaises(ConnectorError):
                await self.client.download_attachment(attachment, self.root.name)
            self.assertEqual(list(Path(self.root.name).iterdir()), [])

    async def test_concurrent_download_never_overwrites(self):
        results = await asyncio.gather(*(self.client.download_attachment(self.attachment, self.root.name) for _ in range(2)),
                                       return_exceptions=True)
        self.assertEqual(sum(isinstance(item, dict) for item in results), 1)
        self.assertEqual(sum(isinstance(item, ConnectorError) for item in results), 1)
        self.assertEqual((Path(self.root.name) / "截图.png").read_bytes(), PNG)
        self.assertEqual(len(list(Path(self.root.name).iterdir())), 1)

    async def test_output_traversal_and_junction_are_rejected(self):
        with self.assertRaisesRegex(ConnectorError, "traversal"):
            await self.client.download_attachment(self.attachment, Path(self.root.name) / ".." / "escape")
        with patch("superagent.connectors.attachments.Path.is_junction", return_value=True):
            with self.assertRaisesRegex(ConnectorError, "symlink"):
                await self.client.download_attachment(self.attachment, self.root.name)
        self.assertEqual(list(Path(self.root.name).iterdir()), [])

    async def test_caller_mime_restriction_and_metadata_mismatch(self):
        with self.assertRaisesRegex(ConnectorError, "mime_not_allowed"):
            await self.client.download_attachment(self.attachment, self.root.name, mime_types={"application/pdf"})
        with self.assertRaisesRegex(ConnectorError, "type_mismatch"):
            await self.client.download_attachment({**self.attachment, "content_type": "image/jpeg"}, self.root.name)


def history_result():
    return {"data": {"complete": True, "hasMore": False, "failures": [], "messages": [
        {"messageId": "m1", "senderId": "user1", "conversationId": "chat1",
         "createTime": "2026-11-13 09:00:00", "text": "截图需要分析"}]}}


class HistoryTests(unittest.IsolatedAsyncioTestCase):
    def helper(self, runner, **kwargs):
        return DingTalkHistoryReplay(profile="org:user", chat_ids=["chat1"],
                                     initial_since="2026-11-13T00:59:00Z",
                                     history_timezone=timezone(timedelta(hours=8)),
                                     sender_map={"user1": "open1"}, runner=runner,
                                     clock=lambda: "2026-11-13T01:01:00Z", **kwargs)

    async def test_group_replay_scope_range_mapping_and_normalization(self):
        calls = []
        async def runner(argv):
            calls.append(argv)
            return history_result()
        helper = self.helper(runner)
        events = await helper(None)
        self.assertEqual(events[0]["sender_open_dingtalk_id"], "open1")
        self.assertEqual(events[0]["create_time"], "2026-11-13T01:00:00.000000Z")
        argv = calls[0]
        for value in ("org:user", "chat1", "--page-all", "--start", "--end", "+chat-messages"):
            self.assertIn(value, argv)
        self.assertNotIn("--download-resources", argv)

    async def test_at_me_uses_precise_search_range(self):
        calls = []
        async def runner(argv):
            calls.append(argv)
            return history_result()
        await self.helper(runner, kind="at-me")("2026-11-13T01:00:00Z")
        self.assertIn("+search-msg", calls[0])
        self.assertIn("--at-me", calls[0])

    async def test_millisecond_checkpoint_replays_entire_second(self):
        calls = []
        async def runner(argv):
            calls.append(argv)
            return history_result()
        events = await self.helper(runner)("2026-11-13T01:00:00.500Z")
        self.assertEqual(calls[0][calls[0].index("--start") + 1], "2026-11-13T01:00:00.000000Z")
        self.assertEqual(len(events), 1)

    async def test_replay_budget_is_separate_from_process_ready_timeout(self):
        class Listener(DingTalkListener):
            async def _run(self):
                self._stream_ready.set()
                await asyncio.sleep(0.1)
                self._ready.set_result(None)
        async def emit(event):
            pass
        listener = Listener("unused", emit, profile="org:user", self_ids={"me"}, ready_timeout=0.02)
        await listener.start()
        self.assertTrue(listener._ready.done())
        await listener.stop()

    async def test_partial_unknown_truncated_failed_queries_never_succeed(self):
        variants = [{"complete": False}, {"hasMore": True}, {"complete": None},
                    {"failures": [{"page": 2}]}, {"truncatedByPageLimit": True},
                    {"messagesComplete": False}]
        variants.append({"stopReason": "page_limit"})
        for change in variants:
            async def runner(argv):
                result = history_result()
                result["data"].update(change)
                return result
            with self.subTest(change=change), self.assertRaisesRegex(ConnectorError, "incomplete"):
                await self.helper(runner)(None)

    async def test_history_rejects_cross_scope_and_wrong_time(self):
        for change in ({"conversationId": "other"}, {"createTime": "2026-11-12 09:00:00"}, {"senderId": None}):
            async def runner(argv):
                result = history_result()
                result["data"]["messages"][0].update(change)
                return result
            with self.subTest(change=change), self.assertRaises(ConnectorError):
                await self.helper(runner)(None)

    async def test_finite_fake_cli_protocol_and_failure(self):
        payload = json.dumps(history_result())
        result = await run_read_json([sys.executable, "-c", "import sys; print(sys.argv[1])", payload])
        self.assertTrue(result["data"]["complete"])
        with self.assertRaises(ConnectorError):
            await run_read_json([sys.executable, "-c", "raise SystemExit(7)"])

    async def test_message_read_checks_explicit_scope(self):
        client = DingTalkClient(profile="org:user")
        async def reader(argv):
            self.assertIn("--msg-ids", argv)
            self.assertIn("m1", argv)
            return history_result()
        self.assertEqual((await client.read_message("chat1", "m1", reader=reader))["messageId"], "m1")
        with self.assertRaisesRegex(ConnectorError, "scope"):
            await client.read_message("other", "m1", reader=reader)


if __name__ == "__main__":
    unittest.main()
