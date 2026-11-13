import asyncio
import json
import sys
import threading
import unittest
from datetime import datetime, timezone, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from superagent.connectors.common import AuthorizedAction, ConnectorError, timestamp
from superagent.connectors.dingtalk import DingTalkClient, DingTalkListener, normalize_event
from superagent.connectors.redmine import RedmineClient, RedminePoller


class Store:
    def __init__(self):
        self.values = {}

    def get(self, key):
        return self.values.get(key)

    def set(self, key, value):
        self.values[key] = value


class Ledger:
    def __init__(self):
        self.rows = {}

    async def claim(self, action_id, action_hash):
        if action_id in self.rows:
            return False
        self.rows[action_id] = {"action_hash": action_hash, "write_status": "unknown"}
        return True

    async def get(self, action_id):
        return self.rows[action_id]

    async def finish(self, action_id, result):
        self.rows[action_id] = result


def issue():
    return {"id": 9, "project": {"id": 3}, "subject": "样例", "description": "正文",
            "author": {"id": 1}, "assigned_to": {"id": 4},
            "updated_on": "2026-11-13T01:00:00Z",
            "attachments": [{"id": 8, "filename": "example.png"}],
            "journals": [{"id": 12, "created_on": "2026-11-13T01:00:00Z",
                          "user": {"id": 2}, "notes": "@developer 请看", "details": [
                              {"property": "attachment", "name": "8", "new_value": "example.png"}]}]}


def message(message_id="m1", sender="other"):
    return {"type": "user_im_message_receive_at", "event_id": "event1",
            "sender_open_dingtalk_id": sender, "conversation_id": "chat1",
            "message_id": message_id, "content": "请检查", "event_time": 1794531600000}


class RedmineTests(unittest.IsolatedAsyncioTestCase):
    async def test_updated_filter_uses_whole_second_utc_z_for_server_compatibility(self):
        calls = []
        async def strict_server(method, path, params, body):
            calls.append(params)
            if params["updated_on"] != ">=2026-11-13T01:00:00Z":
                return 422, {"errors": ["更新于 是无效的"]}
            return 200, {"issues": [], "total_count": 0, "offset": 0}
        client = RedmineClient("https://redmine.invalid", "fake", transport=strict_server)
        inputs = ["2026-11-13T01:00:00.999999Z", "2026-11-13T09:00:00.987654+08:00",
                  datetime(2026, 11, 13, 9, 0, 0, 123456, tzinfo=timezone(timedelta(hours=8))),
                  "2026-11-13T01:00:00Z"]
        for value in inputs:
            with self.subTest(value=str(value)):
                self.assertEqual(await client.list_updated_issues(value, 344), [])
                self.assertEqual(calls[-1]["subproject_id"], "!*")
                self.assertEqual(calls[-1]["project_id"], 344)
        # Wire compatibility must not reduce the internal checkpoint precision.
        self.assertEqual(timestamp(inputs[0]), "2026-11-13T01:00:00.999999Z")

    async def test_pagination_all_status_and_inclusive_filter(self):
        calls = []
        async def transport(method, path, params, body):
            calls.append(params)
            offset = params["offset"]
            return 200, {"issues": [{"id": offset + 1}], "total_count": 2, "offset": offset}
        client = RedmineClient("https://redmine.invalid", "fake", page_size=1, transport=transport)
        self.assertEqual(len(await client.list_updated_issues("2026-11-13T00:00:00Z", 3)), 2)
        self.assertEqual(calls[0]["status_id"], "*")
        self.assertEqual(calls[0]["sort"], "id:asc")
        self.assertTrue(calls[0]["updated_on"].startswith(">="))
        self.assertNotIn("assigned_to_id", calls[0])
        self.assertEqual(calls[1]["offset"], 1)

    async def test_incomplete_page_and_permission(self):
        async def empty(*args):
            return 200, {"issues": [], "total_count": 1}
        client = RedmineClient("http://redmine.invalid", "fake", transport=empty)
        with self.assertRaisesRegex(ConnectorError, "incomplete"):
            await client.list_updated_issues(None)
        async def forbidden(*args):
            return 403, {}
        client._transport = forbidden
        with self.assertRaisesRegex(ConnectorError, "forbidden"):
            await client.get_issue(9)

    async def test_ack_failure_replays_without_cursor_and_comment_mentions(self):
        sample = issue()
        class Client:
            base_url = "http://fake"
            async def list_updated_issues(self, since, project):
                return [sample]
            async def get_issue(self, issue_id):
                return sample
        store, delivered = Store(), []
        async def fail(event):
            raise RuntimeError("storage unavailable")
        poller = RedminePoller(Client(), fail, store, [3], 7,
                               account_map={"developer": [7]}, project_map={"3": "local3"},
                               clock=lambda: "2026-11-13T01:01:00Z")
        with self.assertRaises(RuntimeError):
            await poller.poll_once()
        self.assertFalse(store.values)
        async def emit(event):
            delivered.append(event)
        poller.emit = emit
        await poller.poll_once()
        self.assertEqual(delivered[0]["event_type"], "issue.comment")
        self.assertFalse(delivered[0]["metadata"]["assigned_to_me"])
        self.assertEqual(delivered[0]["attachments"][0]["id"], 8)
        first = delivered[0]["external_id"]
        await poller.poll_once()
        self.assertEqual(delivered[-1]["external_id"], first)
        self.assertTrue(store.values)

    async def test_ambiguous_mentions_are_candidates_and_assignment_away(self):
        async def noop(event):
            pass
        client = RedmineClient("http://fake", "fake")
        poller = RedminePoller(client, noop, Store(), [3], 7, account_map={"developer": [7, 8]})
        events = list(poller._events(issue(), None))
        self.assertTrue(events[0]["metadata"]["needs_confirmation"])
        sample = issue()
        sample["journals"][0].update(notes="", details=[
            {"name": "assigned_to_id", "property": "attr", "old_value": "7", "new_value": "4"}])
        self.assertEqual(list(poller._events(sample, None))[0]["event_type"], "issue.changed")
        sample["project"]["id"] = 99
        with self.assertRaisesRegex(ConnectorError, "scope"):
            list(poller._events(sample, None))

    async def test_comment_preview_authorization_unknown_and_no_resend(self):
        calls = []
        async def timeout(*args):
            calls.append(args)
            raise TimeoutError()
        client = RedmineClient("https://fake", "fake", transport=timeout)
        plan = await client.add_comment(9, "回复")
        self.assertEqual(plan["write_status"], "preview")
        self.assertEqual(calls, [])
        auth = AuthorizedAction("a1", plan["action_hash"])
        ledger = Ledger()
        result = await client.add_comment(9, "回复", authorization=auth, ledger=ledger)
        self.assertEqual(result["write_status"], "unknown")
        self.assertEqual(await client.add_comment(9, "回复", authorization=auth, ledger=ledger), result)
        self.assertEqual(len(calls), 1)
        with self.assertRaises(PermissionError):
            await client.add_comment(9, "改变", authorization=auth, ledger=ledger)

    async def test_concurrent_action_claim_and_assignment(self):
        calls = []
        async def transport(*args):
            calls.append(args)
            await asyncio.sleep(0)
            return 204, {}
        client = RedmineClient("https://fake", "fake", transport=transport)
        plan = await client.assign_issue(9, 7)
        auth, ledger = AuthorizedAction("a", plan["action_hash"]), Ledger()
        results = await asyncio.gather(*(client.assign_issue(9, 7, authorization=auth, ledger=ledger) for _ in range(2)))
        self.assertEqual(len(calls), 1)
        self.assertIn("succeeded", [result["write_status"] for result in results])
        self.assertEqual(calls[0][-1], {"issue": {"assigned_to_id": 7}})

    async def test_http_fake_service_full_issue_and_encoded_filter(self):
        observed = []
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass
            def do_GET(self):
                observed.append((self.path, self.headers.get("X-Redmine-API-Key")))
                data = {"issues": [issue()], "total_count": 1, "offset": 0}
                if self.path.startswith("/issues/9.json"):
                    data = {"issue": issue()}
                self.send_response(200)
                self.end_headers()
                self.wfile.write(json.dumps(data).encode())
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            client = RedmineClient(f"http://127.0.0.1:{server.server_port}", "fake")
            await client.list_updated_issues("2026-11-13T00:00:00Z", 3)
            self.assertEqual((await client.get_issue(9))["attachments"][0]["id"], 8)
            self.assertIn("%3E%3D", observed[0][0])
            self.assertEqual(observed[0][1], "fake")
            await client.close()
            with self.assertRaisesRegex(ConnectorError, "closed"):
                await client.get_issue(9)
        finally:
            await asyncio.to_thread(server.shutdown)
            server.server_close()
            thread.join()

    async def test_second_project_failure_keeps_previous_cursor(self):
        class Client:
            base_url = "http://fake"
            async def list_updated_issues(self, since, project):
                if project == 4:
                    raise ConnectorError("redmine_forbidden")
                return [issue()]
            async def get_issue(self, issue_id):
                return issue()
        events, store = [], Store()
        async def emit(event):
            events.append(event)
        poller = RedminePoller(Client(), emit, store, [3, 4], 7,
                               account_map={"developer": [7]}, clock=lambda: "2026-11-13T01:01:00Z")
        original = timestamp("2026-11-13T00:59:00Z")
        store.set(poller.key, original)
        with self.assertRaises(ConnectorError):
            await poller.poll_once()
        self.assertEqual(store.get(poller.key), original)
        self.assertTrue(events)

    async def test_crash_after_claim_never_reclaims_action(self):
        calls = []
        async def transport(*args):
            calls.append(args)
            return 204, {}
        client = RedmineClient("http://fake", "fake", transport=transport)
        plan = await client.add_comment(9, "正文")
        ledger = Ledger()
        await ledger.claim("crashed", plan["action_hash"])
        result = await client.add_comment(9, "正文", authorization=AuthorizedAction("crashed", plan["action_hash"]),
                                          ledger=ledger)
        self.assertEqual(result["write_status"], "unknown")
        self.assertEqual(calls, [])

    async def test_server_write_error_is_unknown_and_read_error_is_explicit(self):
        async def transport(*args):
            return 503, {}
        client = RedmineClient("http://fake", "fake", transport=transport)
        plan = await client.add_comment(9, "正文")
        result = await client.add_comment(9, "正文", authorization=AuthorizedAction("503", plan["action_hash"]),
                                          ledger=Ledger())
        self.assertEqual(result["write_status"], "unknown")
        with self.assertRaisesRegex(ConnectorError, "503"):
            await client.get_issue(9)

    async def test_edited_old_journal_has_distinct_revision(self):
        async def emit(event):
            pass
        poller = RedminePoller(RedmineClient("http://fake", "fake"), emit, Store(), [3], 7,
                               account_map={"developer": [7]})
        sample = issue()
        before = list(poller._events(sample, "2026-11-13T02:00:00Z"))[0]
        sample["journals"][0]["notes"] += " 修改内容"
        after = list(poller._events(sample, "2026-11-13T02:00:00Z"))[0]
        self.assertNotEqual(before["external_id"], after["external_id"])
        self.assertEqual(after["metadata"]["journal_id"], "12")


class DingTalkTests(unittest.IsolatedAsyncioTestCase):
    async def test_flatten_dedupe_self_scope_and_timestamp(self):
        raw = message()
        first = normalize_event(raw, profile="org:user")
        raw.update(type="user_im_message_receive_group", event_id="different")
        self.assertEqual(first["external_id"], normalize_event(raw, profile="org:user")["external_id"])
        self.assertIsNone(normalize_event(message(sender="me"), profile="org:user", self_ids={"me"}))
        self.assertNotEqual(first["external_id"], normalize_event(raw, profile="other:user")["external_id"])
        with self.assertRaises(ValueError):
            timestamp("2026-11-13T00:00:00")

    async def test_process_ready_and_graceful_stdin_exit(self):
        received = asyncio.Event()
        async def emit(event):
            received.set()
        listener = DingTalkListener([sys.executable, str(Path(__file__).with_name("fake_dws.py")), "normal"],
                                     emit, profile="org:user", self_ids={"me"}, ready_timeout=10)
        await listener.start()
        await asyncio.wait_for(received.wait(), 10)
        self.assertEqual(listener.status, "running")
        self.assertNotIn("--flatten", listener.command())
        await listener.stop()
        self.assertEqual(listener._process.returncode, 0)
        self.assertEqual(listener.status, "stopped")

    async def test_no_ready_fails_and_leaves_no_child(self):
        async def emit(event):
            pass
        listener = DingTalkListener([sys.executable, str(Path(__file__).with_name("fake_dws.py")), "exit"],
                                     emit, profile="org:user", self_ids={"me"}, ready_timeout=10)
        with self.assertRaises(ConnectorError):
            await listener.start()
        self.assertIsNotNone(listener._process.returncode)

    async def test_disconnect_requires_replay(self):
        async def emit(event):
            pass
        listener = DingTalkListener([sys.executable, str(Path(__file__).with_name("fake_dws.py")), "disconnect"],
                                     emit, profile="org:user", self_ids={"me"}, ready_timeout=10)
        await listener.start()
        await asyncio.wait_for(listener._task, 10)
        self.assertEqual(listener.last_error, "dws_disconnected_replay_required")

    async def test_reconnect_replays_after_ack_checkpoint(self):
        delivered, checkpoints = [], []
        async def emit(event):
            delivered.append(event)
        async def replay(checkpoint):
            checkpoints.append(checkpoint)
            return [message("missing")]
        listener = DingTalkListener([sys.executable, str(Path(__file__).with_name("fake_dws.py")), "disconnect"],
                                     emit, profile="org:user", self_ids={"me"}, ready_timeout=10,
                                     state_store=Store(), replay=replay)
        await listener.start()
        await asyncio.wait_for(listener._task, 100)
        self.assertEqual(len(checkpoints), 1)
        self.assertIsNotNone(checkpoints[0])
        self.assertIn("org:user:chat1:missing", [event["external_id"] for event in delivered])
        self.assertEqual(listener.last_error, "dws_reconnect_budget_exhausted")

    async def test_emit_failure_does_not_advance_checkpoint(self):
        async def emit(event):
            raise RuntimeError("persist failed")
        store = Store()
        listener = DingTalkListener("unused", emit, profile="org:user", self_ids={"me"}, state_store=store)
        with self.assertRaises(RuntimeError):
            await listener._deliver(message())
        self.assertFalse(store.values)
        self.assertIsNotNone(listener._pending)

    async def test_reply_requires_approval_and_delivery_evidence(self):
        calls = []
        async def runner(argv):
            calls.append(argv)
            return {"result": {"deliveryStatus": "unknown"}}
        client = DingTalkClient(profile="org:user", runner=runner)
        plan = await client.reply("chat1", "m1", "正文")
        self.assertFalse(calls)
        auth, ledger = AuthorizedAction("d1", plan["action_hash"]), Ledger()
        self.assertEqual((await client.reply("chat1", "m1", "正文", authorization=auth, ledger=ledger))["write_status"], "unknown")
        await client.reply("chat1", "m1", "正文", authorization=auth, ledger=ledger)
        self.assertEqual(len(calls), 1)
        self.assertIn("--yes", calls[0])

    async def test_failed_start_nonretryable_never_restarts(self):
        spawns = []
        async def spawn(*args, **kwargs):
            spawns.append(args)
            return await asyncio.create_subprocess_exec(*args, **kwargs)
        async def emit(event):
            pass
        async def replay(checkpoint):
            return []
        listener = DingTalkListener([sys.executable, str(Path(__file__).with_name("fake_dws.py")), "nonretryable"],
                                     emit, profile="org:user", self_ids={"me"}, ready_timeout=10,
                                     replay=replay, process_factory=spawn)
        with self.assertRaises(ConnectorError):
            await listener.start()
        self.assertEqual(len(spawns), 1)

    async def test_restart_replays_durable_checkpoint(self):
        checkpoint = timestamp("2026-11-13T00:00:00Z")
        replayed, events = [], []
        async def emit(event):
            events.append(event)
        async def replay(since):
            replayed.append(since)
            return [message("offline")]
        store = Store()
        listener = DingTalkListener([sys.executable, str(Path(__file__).with_name("fake_dws.py")), "normal"],
                                     emit, profile="org:user", self_ids={"me"}, ready_timeout=10,
                                     replay=replay, state_store=store)
        store.set(listener.key, checkpoint)
        await listener.start()
        await listener.stop()
        self.assertEqual(replayed, [checkpoint])
        self.assertIn("org:user:chat1:offline", [event["external_id"] for event in events])

    async def test_scope_mismatch_rejected_before_consumption(self):
        events = []
        async def emit(event):
            events.append(event)
        listener = DingTalkListener("unused", emit, profile="org:user", self_ids={"me"},
                                     kind="group", chat_id="other-chat")
        with self.assertRaisesRegex(ConnectorError, "scope"):
            await listener._deliver(message())
        self.assertEqual(events, [])


if __name__ == "__main__":
    unittest.main()
