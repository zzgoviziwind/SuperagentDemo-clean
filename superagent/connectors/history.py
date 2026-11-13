"""Bounded DWS read commands and history replay, with fail-closed completeness."""

import asyncio
from datetime import datetime
import json

from .common import ConnectorError, timestamp, utc_now


async def run_read_json(argv, *, timeout=120):
    try:
        process = await asyncio.create_subprocess_exec(*argv, stdout=asyncio.subprocess.PIPE,
                                                       stderr=asyncio.subprocess.PIPE)
    except OSError:
        raise ConnectorError("dws_executable_unavailable") from None
    communication = asyncio.create_task(process.communicate())
    try:
        stdout, _ = await asyncio.wait_for(asyncio.shield(communication), timeout)
    except (TimeoutError, asyncio.CancelledError):
        if process.returncode is None:
            process.terminate()  # Only the finite, read-only query invocation.
        await asyncio.gather(communication, return_exceptions=True)
        raise
    if process.returncode:
        raise ConnectorError("dws_history_query_failed")
    try:
        result = json.loads(stdout)
    except ValueError:
        raise ConnectorError("dws_read_invalid_json") from None
    return result


def require_complete(result):
    if not isinstance(result, dict) or result.get("error") or result.get("outcome") in {"failure", "partial_failure"}:
        raise ConnectorError("dws_read_failed")
    data = result.get("data", result.get("result", result))
    if not isinstance(data, dict):
        raise ConnectorError("dws_read_contract_unavailable")
    if (data.get("complete") is not True or data.get("hasMore") is not False or
            data.get("failures") or data.get("truncatedByPageLimit") or data.get("truncatedByMaxItems") or
            data.get("stopReason") in {"page_limit", "max_items", "item_limit", "timeout", "single_page", "failed"} or
            data.get("messagesComplete") is False or data.get("enrichment", {}).get("complete") is False):
        raise ConnectorError("dws_read_incomplete")
    if not isinstance(data.get("messages"), list):
        raise ConnectorError("dws_read_contract_unavailable")
    return data


class DingTalkHistoryReplay:
    """Callable for DingTalkListener.replay, restricted to explicit account/chats.

    history_timezone is the configured DWS local timezone for createTime strings
    without an offset. sender_map maps known history user IDs to openDingTalkIds.
    """

    def __init__(self, executable="dws", *, profile, chat_ids, initial_since,
                 history_timezone, kind="group", sender_map=None, runner=None,
                 page_limit=40, timeout=120, clock=utc_now):
        if not profile or not chat_ids or kind not in {"group", "at-me"}:
            raise ValueError("Explicit profile, chat IDs and replay kind are required")
        if not 1 <= page_limit <= 40 or history_timezone is None:
            raise ValueError("Bounded page budget and explicit history timezone are required")
        self.executable = [executable] if isinstance(executable, str) else list(executable)
        self.profile, self.chat_ids = profile, tuple(sorted(set(chat_ids)))
        self.initial_since = timestamp(initial_since)
        self.timezone, self.kind = history_timezone, kind
        self.sender_map, self.runner = sender_map or {}, runner
        self.page_limit, self.timeout, self.clock = page_limit, timeout, clock

    async def read_range(self, start, end):
        start, end = timestamp(start), timestamp(end)
        if start >= end:
            raise ValueError("History range must have start before end")
        # Historical createTime can have only second precision. Replay the entire
        # checkpoint second and let the durable message ID deduplicator absorb it.
        start = timestamp(datetime.fromisoformat(start.replace("Z", "+00:00")).replace(microsecond=0))
        events = {}
        for conversation in self.chat_ids:
            command = "+chat-messages" if self.kind == "group" else "+search-msg"
            argv = self.executable + ["--profile", self.profile, "chat", command,
                                     "--group", conversation, "--start", start, "--end", end,
                                     "--order", "asc", "--page-all", "--page-limit", str(self.page_limit),
                                     "--no-reactions", "--format", "json"]
            if self.kind == "at-me":
                argv.append("--at-me")
            result = await self.runner(argv) if self.runner else await run_read_json(argv, timeout=self.timeout)
            data = require_complete(result)
            if data.get("conversationId", conversation) != conversation:
                raise ConnectorError("dws_history_scope_mismatch")
            for row in data["messages"]:
                message, sender = row.get("messageId"), row.get("senderId")
                if not message or not sender or row.get("conversationId", conversation) != conversation:
                    raise ConnectorError("dws_history_message_identity_missing_or_mismatch")
                value = row.get("createTime")
                if isinstance(value, str):
                    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
                    value = parsed.replace(tzinfo=self.timezone) if parsed.tzinfo is None else parsed
                occurred = timestamp(value)
                if not start <= occurred < end:
                    raise ConnectorError("dws_history_time_scope_mismatch")
                raw = {"type": "user_im_message_receive_group" if self.kind == "group" else "user_im_message_receive_at",
                       "conversation_id": conversation, "message_id": message,
                       "sender_open_dingtalk_id": self.sender_map.get(str(sender), str(sender)),
                       "create_time": occurred, "content": row.get("text") or "",
                       "attachments": [], "history_sender_id": str(sender)}
                events[(conversation, message)] = raw
        return sorted(events.values(), key=lambda event: (event["create_time"], event["message_id"]))

    async def __call__(self, checkpoint):
        return await self.read_range(checkpoint or self.initial_since, self.clock())
