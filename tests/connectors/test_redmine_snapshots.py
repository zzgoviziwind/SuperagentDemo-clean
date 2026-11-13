"""Acknowledged semantic snapshots must not echo issue bodies after comments."""

import copy
import unittest

from superagent.connectors.common import timestamp
from superagent.connectors.redmine import RedminePoller, restore_issue_checkpoint


class Store:
    def __init__(self):
        self.values = {}

    def get(self, key):
        return self.values.get(key)

    def set(self, key, value):
        self.values[key] = copy.deepcopy(value)


class Source:
    base_url = "https://offline.invalid"

    def __init__(self):
        self.issue = {"id": 24701, "subject": "离线测试", "description": "原始需求",
                      "assigned_to": {"id": 7}, "project": {"id": 3}, "author": {"id": 8},
                      "updated_on": "2026-11-13T01:00:00Z", "journals": []}

    async def list_updated_issues(self, since, project):
        return [{"id": self.issue["id"]}] if self.issue["project"]["id"] == project else []

    async def get_issue(self, issue_id):
        return copy.deepcopy(self.issue)

    def comment(self, notes="本系统回复"):
        self.issue["updated_on"] = "2026-11-13T01:00:01Z"
        self.issue["journals"].append({"id": len(self.issue["journals"]) + 1,
                                       "created_on": self.issue["updated_on"], "user": {"id": 7},
                                       "notes": notes, "details": []})


class SnapshotTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.source, self.store = Source(), Store()
        self.calls, self.persisted = [], {}

    async def emit(self, event):
        self.calls.append(copy.deepcopy(event))
        # Models the receiving service's unique (source, external_id) constraint.
        self.persisted.setdefault(event["external_id"], copy.deepcopy(event))

    def poller(self, emit=None):
        return RedminePoller(self.source, emit or self.emit, self.store, [3, 4], 7,
                             clock=lambda: "2026-11-13T01:01:00.123456Z")

    def snapshots(self):
        return [event for event in self.calls if event["event_type"] == "issue.updated"]

    async def test_own_comment_and_timestamp_change_do_not_reemit_body(self):
        poller = self.poller()
        await poller.poll_once()
        self.source.comment()
        await poller.poll_once()
        self.assertEqual(len(self.snapshots()), 1)
        self.assertEqual(self.calls[-1]["event_type"], "issue.comment")
        self.assertEqual(self.calls[-1]["actor_id"], "7")
        journal_id = self.calls[-1]["external_id"]
        self.source.issue["updated_on"] = "2026-11-13T01:00:02Z"
        await self.poller().poll_once()  # New process-facing poller, same durable store.
        self.assertEqual(len(self.snapshots()), 1)
        self.assertEqual(self.calls[-1]["external_id"], journal_id)
        self.assertEqual(len(self.persisted), 2)

    async def test_real_subject_description_project_and_assignment_changes_emit(self):
        poller = self.poller()
        await poller.poll_once()
        changes = [("subject", "更新标题"), ("description", "更新正文"),
                   ("project", {"id": 4}), ("assigned_to", {"id": 8})]
        for field, value in changes:
            self.source.issue[field] = value
            await poller.poll_once()
        snapshots = self.snapshots()
        self.assertEqual(len(snapshots), 5)
        self.assertEqual(len({event["external_id"] for event in snapshots}), 5)
        self.assertEqual(snapshots[-1]["metadata"]["assigned_to_id"], "8")
        self.assertFalse(snapshots[-1]["metadata"]["assigned_to_me"])

    async def test_a_to_b_to_a_with_identical_timestamp_has_distinct_events(self):
        poller = self.poller()
        for description in ("A", "B", "A"):
            self.source.issue["description"] = description
            await poller.poll_once()
        snapshots = self.snapshots()
        self.assertEqual(len(snapshots), 3)
        self.assertEqual(len(self.persisted), 3)
        self.assertEqual(snapshots[0]["metadata"]["issue_fingerprint"], snapshots[2]["metadata"]["issue_fingerprint"])
        self.assertNotEqual(snapshots[0]["external_id"], snapshots[2]["external_id"])

    async def test_journal_failure_prevents_fingerprint_and_cursor_commit(self):
        self.source.comment()
        fail = True
        async def emit(event):
            if fail and event["event_type"] == "issue.comment":
                raise RuntimeError("journal not durably accepted")
            await self.emit(event)
        poller = self.poller(emit)
        with self.assertRaises(RuntimeError):
            await poller.poll_once()
        self.assertNotIn(poller.key, self.store.values)
        self.assertFalse(any(key.endswith(":semantics") for key in self.store.values))
        self.assertEqual(self.store.get(poller.pending_key)["updated_on"], "2026-11-13T01:00:01Z")
        first_id = self.snapshots()[0]["external_id"]
        fail = False
        self.source.issue["updated_on"] = "2026-11-13T01:00:03Z"
        poller = self.poller(emit)  # Resume the reserved legacy snapshot after restart.
        await poller.poll_once()
        self.assertEqual(self.snapshots()[-1]["external_id"], first_id)
        self.assertEqual(len(self.persisted), 2)
        self.assertIsNone(self.store.get(poller.pending_key))
        self.assertIn(poller.key, self.store.values)
        await poller.poll_once()
        self.assertEqual(len(self.snapshots()), 2)  # The failed batch replayed exactly once.

    async def test_failed_checkpoint_write_replays_stable_snapshot_id(self):
        original_set = self.store.set
        fail = True
        def set_checkpoint(key, value):
            if fail and key.endswith(":semantics"):
                raise RuntimeError("checkpoint persistence failed")
            original_set(key, value)
        self.store.set = set_checkpoint
        poller = self.poller()
        with self.assertRaises(RuntimeError):
            await poller.poll_once()
        self.assertNotIn(poller.key, self.store.values)
        self.assertFalse(any(key.endswith(":semantics") for key in self.store.values))
        fail = False
        await poller.poll_once()
        self.assertEqual(len(self.snapshots()), 2)
        self.assertEqual(len(self.persisted), 1)

    async def test_existing_legacy_event_is_deduped_while_baseline_is_initialized(self):
        poller = self.poller()
        legacy = next(event for event in poller._events(self.source.issue, None) if event["event_type"] == "issue.updated")
        self.persisted[legacy["external_id"]] = copy.deepcopy(legacy)
        self.store.set(poller.key, "2026-11-13T01:00:00.000000Z")
        await poller.poll_once()
        self.assertEqual(self.snapshots()[0]["external_id"], legacy["external_id"])
        self.assertEqual(len(self.persisted), 1)
        checkpoint = next(value for key, value in self.store.values.items() if key.endswith(":semantics"))
        self.assertEqual(checkpoint["sequence"], 1)
        self.source.comment()
        await self.poller().poll_once()
        self.assertEqual(len(self.snapshots()), 1)
        self.assertEqual(len(self.persisted), 2)

    async def test_non_semantic_labels_status_and_null_empty_values_do_not_emit(self):
        self.source.issue["description"] = None
        poller = self.poller()
        await poller.poll_once()
        self.source.issue.update(description="", status={"id": 2}, updated_on="2026-11-13T01:05:00Z")
        self.source.issue["assigned_to"] = {"id": "7", "name": "展示名变化"}
        self.source.issue["project"]["name"] = "项目展示名变化"
        await poller.poll_once()
        self.assertEqual(len(self.snapshots()), 1)
        self.source.issue["assigned_to"] = None
        await poller.poll_once()
        self.assertEqual(len(self.snapshots()), 2)

    async def test_journal_edits_still_emit_without_body_changes(self):
        self.source.comment("第一次评论")
        poller = self.poller()
        await poller.poll_once()
        original_comment_id = self.calls[-1]["external_id"]
        self.source.issue["journals"][0]["notes"] = "修改已有评论"
        await poller.poll_once()
        self.assertEqual(len(self.snapshots()), 1)
        self.assertNotEqual(self.calls[-1]["external_id"], original_comment_id)
        self.assertEqual(self.calls[-1]["event_type"], "issue.comment")

    def legacy_event(self):
        event = next(event for event in self.poller()._events(self.source.issue, None) if event["event_type"] == "issue.updated")
        event["metadata"].pop("assigned_to_id", None)
        return event

    async def test_upgrade_recovers_legacy_snapshot_after_cursor_passed_old_issue(self):
        self.source.issue["updated_on"] = "2026-11-13T08:45:53Z"
        historical = self.legacy_event()
        self.persisted[historical["external_id"]] = historical
        requested = []
        async def load_snapshot(**scope):
            requested.append(scope)
            return historical
        poller = self.poller()
        poller.load_snapshot = load_snapshot
        self.store.set(poller.key, "2026-11-13T09:20:00.000000Z")
        self.assertLess(timestamp(self.source.issue["updated_on"]), self.store.get(poller.key))
        self.source.comment()
        self.source.issue["updated_on"] = "2026-11-13T09:30:19Z"
        await poller.poll_once()
        self.assertEqual(self.snapshots(), [])
        self.assertEqual(len(self.persisted), 2)
        self.assertEqual(self.calls[0]["event_type"], "issue.comment")
        self.assertEqual(requested, [{"base_url": self.source.base_url, "issue_id": "24701",
                                      "project_ids": [3, 4], "user_id": "7"}])
        self.assertTrue(any(key.endswith(":semantics") for key in self.store.values))

    async def test_bootstrap_still_emits_real_semantic_changes(self):
        historical = self.legacy_event()
        original = copy.deepcopy(self.source.issue)
        for field, value in (("subject", "新标题"), ("description", "真实新需求"),
                             ("assigned_to", {"id": 8}), ("project", {"id": 4})):
            with self.subTest(field=field):
                self.source.issue = copy.deepcopy(original)
                self.source.issue[field] = value
                self.store.values.clear()
                self.calls.clear()
                poller = self.poller()
                poller.load_snapshot = lambda **scope: historical
                await poller.poll_once()
                self.assertEqual(len(self.snapshots()), 1)
                self.assertIn(":snapshot:2:", self.snapshots()[0]["external_id"])

    async def test_bootstrap_fingerprint_waits_for_all_journals_ack(self):
        historical = self.legacy_event()
        self.source.comment()
        fail = True
        async def emit(event):
            if fail:
                raise RuntimeError("journal not committed")
            await self.emit(event)
        poller = self.poller(emit)
        poller.load_snapshot = lambda **scope: historical
        with self.assertRaises(RuntimeError):
            await poller.poll_once()
        self.assertEqual(self.store.values, {})
        fail = False
        await poller.poll_once()
        self.assertEqual(self.snapshots(), [])
        self.assertTrue(any(key.endswith(":semantics") for key in self.store.values))

    async def test_incomplete_or_out_of_scope_history_never_suppresses_update(self):
        original = self.legacy_event()
        variants = []
        for key, value in (("redmine_endpoint", "https://other.invalid"), ("external_user_id", "8"),
                           ("assigned_to_me", False), ("issue_fingerprint", "unverified"),
                           ("assigned_to_id", True), ("assigned_to_id", None)):
            event = copy.deepcopy(original)
            event["metadata"][key] = value
            variants.append(event)
        other_project = copy.deepcopy(original)
        other_project["project_external_id"] = "99"
        variants.append(other_project)
        for historical in variants:
            with self.subTest(metadata=historical["metadata"]):
                self.store.values.clear()
                self.calls.clear()
                poller = self.poller()
                poller.load_snapshot = lambda **scope: historical
                await poller.poll_once()
                self.assertEqual(len(self.snapshots()), 1)

    async def test_restore_uses_verified_snapshot_sequence(self):
        historical = self.legacy_event()
        scope = {"base_url": self.source.base_url, "issue_id": "24701", "project_ids": [3, 4], "user_id": "7"}
        fingerprint = restore_issue_checkpoint(historical, **scope)["fingerprint"]
        historical["external_id"] = f"{self.source.base_url}:issue:24701:snapshot:7:{fingerprint}"
        historical["metadata"]["issue_fingerprint"] = fingerprint
        self.assertEqual(restore_issue_checkpoint(historical, **scope)["sequence"], 7)
        self.source.issue["description"] = "真实新需求"
        poller = self.poller()
        poller.load_snapshot = lambda **scope: historical
        await poller.poll_once()
        self.assertIn(":snapshot:8:", self.snapshots()[0]["external_id"])
