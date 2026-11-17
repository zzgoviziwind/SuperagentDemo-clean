"""Schema-bound quote normalization and real durable routing regressions."""

import unittest

from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from superagent.connectors.dingtalk import normalize_event
from superagent.core.db import Base, Project, Task
from superagent.core.ingestion import ingest_event
from superagent.core.governance import TaskOwner  # Register owner mapping with Base.


def event(ident="m1", quote=None):
    raw = {"type": "user_im_message_receive_group", "sender_open_dingtalk_id": "trusted",
           "conversation_id": "chat", "message_id": ident, "content": "请检查截图中的问题",
           "event_time": "2026-11-13T01:00:00Z"}
    if quote is not None:
        raw["quoted_message"] = quote
    return normalize_event(raw, profile="offline")


class QuoteTests(unittest.TestCase):
    def test_same_conversation_explicit_message_id_is_normalized(self):
        normalized = event("m2", {"conversation_id": "chat", "message_id": "m1"})
        self.assertEqual(normalized["metadata"]["reply_to_message_id"], "m1")
        self.assertNotIn("needs_confirmation", normalized["metadata"])
        self.assertNotIn("reply_to_message_id", event()["metadata"])

    def test_ambiguous_cross_conversation_and_self_quotes_require_confirmation(self):
        for quote in ({"message_id": "m1"}, {"conversation_id": "other", "message_id": "m1"},
                      {"conversation_id": "chat"}, {"conversation_id": "chat", "message_id": "m2"},
                      {"conversation_id": "chat", "message_id": ""},
                      {"conversation_id": "chat", "message_id": " m1 "}, "unstructured"):
            with self.subTest(quote=quote):
                metadata = event("m2", quote)["metadata"]
                self.assertTrue(metadata["needs_confirmation"])
                self.assertNotIn("reply_to_message_id", metadata)

    def test_quoted_request_without_issue_number_continues_existing_task(self):
        engine = create_engine("sqlite://")
        try:
            Base.metadata.create_all(engine)
            sessions = sessionmaker(engine, expire_on_commit=False)
            with sessions.begin() as session:
                session.add(Project(name="引用回归", repo_path=".", dingtalk_chat_ids=["chat"]))
            def actor(source, actor_id):
                return {"user_id": "tester", "role": "admin", "project_ids": [1], "permissions": ["request"]}
            first = ingest_event(event(), session_factory=sessions, actor_resolver=actor)
            second = ingest_event(event("m2", {"conversation_id": "chat", "message_id": "m1"}),
                                  session_factory=sessions, actor_resolver=actor)
            self.assertEqual(first["task_id"], second["task_id"])
            ambiguous = ingest_event(event("m3", {"conversation_id": "other", "message_id": "m1"}),
                                     session_factory=sessions, actor_resolver=actor)
            self.assertIsNone(ambiguous["task_id"])
            self.assertEqual(ambiguous["data"]["routing_status"], "pending_confirmation")
            with sessions() as session:
                self.assertEqual(len(session.scalars(select(Task)).all()), 1)
        finally:
            engine.dispose()
