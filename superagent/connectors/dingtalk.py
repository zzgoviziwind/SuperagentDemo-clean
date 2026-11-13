"""DWS personal IM NDJSON integration. Nothing starts until start is called."""

import asyncio
import json
import re

from .common import (ConnectorError, WriteOutcomeUnknown, execute_write, preview,
                     resolve, timestamp, utc_now)
from .history import DingTalkHistoryReplay, require_complete, run_read_json


def normalize_event(raw, *, profile, self_ids=(), project_map=None):
    kind = raw.get("type", "")
    if kind not in {"user_im_message_receive_at", "user_im_message_receive_group"}:
        raise ConnectorError("unsupported_dws_event_type")
    actor = raw.get("sender_open_dingtalk_id")
    if actor in self_ids:
        return None
    conversation = raw.get("conversation_id")
    message = raw.get("message_id")
    if not actor or not conversation or not message:
        raise ConnectorError("dws_event_missing_identity")
    quote = raw.get("quoted_message")
    reference = {}
    if quote is not None:
        if (isinstance(quote, dict) and isinstance(quote.get("message_id"), str) and
                quote["message_id"].strip() and quote["message_id"] == quote["message_id"].strip() and
                quote["message_id"] != message and
                quote.get("conversation_id") == conversation):
            reference["reply_to_message_id"] = quote["message_id"]
        else:
            reference["needs_confirmation"] = True
    # Message key deduplicates overlapping at-me/group subscriptions and bus replay.
    return {"source": "dingtalk", "external_id": f"{profile}:{conversation}:{message}",
            "event_type": "message.received", "actor_id": actor, "thread_id": conversation,
            "project_external_id": conversation, "issue_id": None,
            "content": raw.get("content", ""),
            "occurred_at": timestamp(raw.get("event_time") or raw.get("timestamp") or raw.get("create_time")),
            "attachments": raw.get("attachments", []),
            "metadata": {"profile": profile, "message_id": message,
                         "event_id": raw.get("event_id"),
                         "project_id": (project_map or {}).get(conversation),
                         "quoted_message": raw.get("quoted_message"),
                         "forward_messages": raw.get("forward_messages", []), **reference}}


class DingTalkListener:
    def __init__(self, executable, emit, *, profile, self_ids, chat_id=None,
                 kind="at-me", state_store=None, project_map=None, replay=None,
                 ready_timeout=30, stop_timeout=10, process_factory=None):
        if kind not in {"at-me", "group"} or (kind == "group") != bool(chat_id):
            raise ValueError("Use at-me or group with one explicit chat_id")
        if not profile or not self_ids:
            raise ValueError("Explicit profile and current account IDs are required")
        self.executable = [executable] if isinstance(executable, str) else list(executable)
        self.emit, self.profile, self.self_ids = emit, profile, set(self_ids)
        self.chat_id, self.kind = chat_id, kind
        self.state, self.project_map, self.replay = state_store, project_map, replay
        self.ready_timeout, self.stop_timeout = ready_timeout, stop_timeout
        self._spawn = process_factory or asyncio.create_subprocess_exec
        self.status, self.last_error, self.last_seen = "stopped", None, None
        self._task = self._process = self._ready = None
        self._stream_ready = None
        self._stopping = False
        self._pending = None
        self.key = f"dingtalk:{profile}:{kind}:{chat_id or ''}"

    def command(self):
        command = self.executable + ["--profile", self.profile, "event", "+listen-im",
                                     "--kind", self.kind, "--events", "message",
                                     "--format", "ndjson"]
        if self.chat_id:
            command += ["--chat-id", self.chat_id]
        return command

    async def start(self):
        if self._task and not self._task.done():
            return
        self._stopping = False
        self._ready = asyncio.get_running_loop().create_future()
        self._stream_ready = asyncio.Event()
        self._task = asyncio.create_task(self._run())
        stream_wait = asyncio.create_task(self._stream_ready.wait())
        try:
            done, _ = await asyncio.wait({stream_wait, self._ready}, timeout=self.ready_timeout,
                                         return_when=asyncio.FIRST_COMPLETED)
            if not done:
                raise TimeoutError("dws_ready_timeout")
            # Historical queries carry their own bounded timeout and may take
            # longer than waiting for the process's ready marker.
            await asyncio.shield(self._ready)
        except BaseException:
            await self.stop()
            raise
        finally:
            stream_wait.cancel()
            await asyncio.gather(stream_wait, return_exceptions=True)

    async def _deliver(self, raw):
        event = normalize_event(raw, profile=self.profile, self_ids=self.self_ids,
                                project_map=self.project_map)
        if event is None:
            return
        if self.chat_id and event["thread_id"] != self.chat_id:
            raise ConnectorError("dws_conversation_scope_mismatch")
        self._pending = raw
        await self.emit(event)
        if self.state:
            previous = await resolve(self.state.get(self.key))
            await resolve(self.state.set(self.key, max(previous or event["occurred_at"], event["occurred_at"])))
        self._pending = None
        self.last_seen = utc_now()

    async def _stderr(self, process, ready, errors):
        while line := await process.stderr.readline():
            value = line.decode("utf-8", errors="replace").strip()
            if re.match(r"^\[event\] ready(?: |$)", value):
                ready.set()
            # Never persist arbitrary stderr, which can contain credentials/content.
            try:
                data = json.loads(value)
                if isinstance(data, dict) and "error" in data:
                    errors.update(data["error"])
            except ValueError:
                continue

    async def _shutdown(self, process):
        if process.returncode is None:
            process.stdin.close()  # DWS documents stdin EOF as graceful cancellation.
            try:
                await asyncio.wait_for(process.wait(), self.stop_timeout)
            except TimeoutError:
                self.status = "stop_failed"
                raise ConnectorError("dws_graceful_stop_timeout") from None

    async def _session(self, reconnect):
        process = await self._spawn(*self.command(), stdin=asyncio.subprocess.PIPE,
                                    stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
                                    limit=1024 * 1024)
        self._process = process
        ready, errors = asyncio.Event(), {}
        stderr_task = asyncio.create_task(self._stderr(process, ready, errors))
        ready_task = asyncio.create_task(ready.wait())
        exit_task = asyncio.create_task(process.wait())
        try:
            done, _ = await asyncio.wait({ready_task, exit_task}, timeout=self.ready_timeout,
                                         return_when=asyncio.FIRST_COMPLETED)
            if not ready.is_set():
                if not done:
                    raise ConnectorError("dws_ready_timeout")
                await stderr_task
                return errors
            self._stream_ready.set()
            checkpoint = await resolve(self.state.get(self.key)) if self.state else None
            if reconnect or checkpoint:
                if not self.replay:
                    raise ConnectorError("dws_disconnected_replay_required")
                for raw in await self.replay(checkpoint):
                    await self._deliver(raw)
            if self._pending:
                await self._deliver(self._pending)
            self.status = "running"
            if not self._ready.done():
                self._ready.set_result(None)
            while not self._stopping:
                line = await process.stdout.readline()
                if not line:
                    break
                try:
                    raw = json.loads(line)
                except ValueError:
                    raise ConnectorError("dws_invalid_ndjson") from None
                await self._deliver(raw)
            await self._shutdown(process)
            await stderr_task
            return errors
        finally:
            try:
                await self._shutdown(process)
            finally:
                for task in (stderr_task, ready_task, exit_task):
                    task.cancel()
                await asyncio.gather(stderr_task, ready_task, exit_task, return_exceptions=True)

    async def _run(self):
        attempts = 0
        try:
            while not self._stopping:
                self.status = "connecting" if attempts == 0 else "reconnecting"
                errors = await self._session(attempts > 0)
                if self._stopping:
                    break
                if not self.replay:
                    raise ConnectorError("dws_disconnected_replay_required")
                retryable = errors.get("retryable")
                maximum = {True: 2, False: 0}.get(retryable, 1)
                if attempts >= maximum or errors.get("state") in {"in_flight", "cooldown", "terminal_hold"}:
                    raise ConnectorError("dws_reconnect_budget_exhausted")
                delay = max(0, float(errors.get("retry_after_seconds", 1)))
                if errors.get("next_retry_at"):
                    from datetime import datetime, timezone
                    target = datetime.fromisoformat(errors["next_retry_at"].replace("Z", "+00:00"))
                    delay = max(delay, (target - datetime.now(timezone.utc)).total_seconds())
                attempts += 1
                await asyncio.sleep(delay)
        except asyncio.CancelledError:
            raise
        except Exception as error:
            self.last_error = str(error) if isinstance(error, ConnectorError) else "dws_delivery_or_process_failure"
            if self.status != "stop_failed":
                self.status = "failed"
            if not self._ready.done():
                self._ready.set_exception(ConnectorError(self.last_error))
        else:
            self.status = "stopped"

    async def stop(self):
        self._stopping = True
        if self._process and self._process.returncode is None:
            self._process.stdin.close()
        if self._task and not self._task.done():
            self._task.cancel()
            await asyncio.gather(self._task, return_exceptions=True)
        if self.status != "stop_failed":
            self.status = "stopped"


class DingTalkClient:
    def __init__(self, executable="dws", *, profile, timeout=30, runner=None):
        if not profile:
            raise ValueError("Explicit profile is required")
        self.executable = [executable] if isinstance(executable, str) else list(executable)
        self.profile, self.timeout = profile, timeout
        self._runner = runner or self._execute
        self._inflight = set()

    async def _execute(self, argv):
        try:
            process = await asyncio.create_subprocess_exec(*argv, stdout=asyncio.subprocess.PIPE,
                                                           stderr=asyncio.subprocess.PIPE)
        except OSError:
            raise ConnectorError("dws_executable_unavailable") from None
        communication = asyncio.create_task(process.communicate())
        self._inflight.add(communication)
        communication.add_done_callback(self._inflight.discard)
        try:
            stdout, _ = await asyncio.wait_for(asyncio.shield(communication), self.timeout)
        except TimeoutError:
            raise WriteOutcomeUnknown("dws_write_outcome_unknown") from None
        try:
            data = json.loads(stdout)
        except ValueError:
            raise WriteOutcomeUnknown("dws_write_outcome_unknown") from None
        if process.returncode:
            raise WriteOutcomeUnknown("dws_write_outcome_unknown")
        return data

    async def reply(self, conversation_id, message_id, content, *, authorization=None, ledger=None):
        if not conversation_id or not message_id or not content.strip():
            raise ValueError("Explicit conversation, source message and content are required")
        plan = preview("dingtalk", "reply", {"profile": self.profile,
                       "conversation_id": conversation_id, "message_id": message_id}, {"content": content})
        async def write():
            argv = self.executable + ["--profile", self.profile, "chat", "+messages-reply",
                                     "--group", conversation_id, "--message-id", message_id,
                                     "--content", content, "--idempotency-key", authorization.action_id,
                                     "--format", "json", "--yes"]
            data = await self._runner(argv)
            result = data.get("data", data.get("result", data))
            delivery = result.get("deliveryStatus", "unknown")
            if delivery not in {"sent", "delivered", "succeeded", "success"}:
                raise WriteOutcomeUnknown("dws_delivery_status_unknown")
            return {"write_status": "succeeded", "verification": delivery,
                    "message_id": result.get("messageId")}
        return await execute_write(plan, authorization, ledger, write)

    async def read_message(self, conversation_id, message_id, *, reader=None):
        if not conversation_id or not message_id or "," in message_id:
            raise ValueError("One explicit conversation and message ID are required")
        argv = self.executable + ["--profile", self.profile, "chat", "+messages-mget",
                                 "--msg-ids", message_id, "--no-reactions", "--no-threads", "--format", "json"]
        result = await reader(argv) if reader else await run_read_json(argv, timeout=self.timeout)
        data = require_complete(result)
        rows = data["messages"]
        if len(rows) != 1 or rows[0].get("messageId") != message_id or rows[0].get("conversationId") != conversation_id:
            raise ConnectorError("dws_message_scope_unverified")
        return rows[0]

    async def download_message_resources(self, conversation_id, message_id, output_dir, **budgets):
        from .media import download_message_resources
        return await download_message_resources(self.executable, self.profile, conversation_id, message_id,
                                                 output_dir, **budgets)

    async def close(self):
        if self._inflight:
            await asyncio.gather(*self._inflight, return_exceptions=True)
