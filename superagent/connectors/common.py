"""Persistence-neutral delivery and external-write contracts."""

import asyncio
import hashlib
import inspect
import json
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Protocol


class ConnectorError(RuntimeError):
    pass


class WriteOutcomeUnknown(ConnectorError):
    pass


class StateStore(Protocol):
    """get/set can be synchronous or awaitable. set must durably commit."""

    def get(self, key: str) -> Any: ...
    def set(self, key: str, value: Any) -> Any: ...


class ActionLedger(Protocol):
    """claim atomically inserts a durable pending row, including across processes.

    If available, mark_dispatching must durably authorize the same claim before I/O.
    get returns the stored result or a pending record. finish durably stores the result.
    """

    async def claim(self, action_id: str, action_hash: str) -> bool: ...
    async def get(self, action_id: str) -> dict: ...
    async def finish(self, action_id: str, result: dict) -> None: ...


async def resolve(value):
    if inspect.isawaitable(value):
        return await value
    return value


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="microseconds").replace("+00:00", "Z")


def timestamp(value) -> str:
    if isinstance(value, (float, int)):
        return datetime.fromtimestamp(value / 1000, timezone.utc).isoformat(timespec="microseconds").replace("+00:00", "Z")
    parsed = value if isinstance(value, datetime) else datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("An explicit timestamp timezone is required")
    return parsed.astimezone(timezone.utc).isoformat(timespec="microseconds").replace("+00:00", "Z")


def digest(value) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False,
                                     separators=(",", ":")).encode()).hexdigest()


def preview(source: str, kind: str, target: dict, payload: dict) -> dict:
    action = {"source": source, "kind": kind, "target": target, "payload": payload}
    return {**action, "action_hash": digest(action), "write_status": "preview"}


@dataclass(frozen=True)
class AuthorizedAction:
    """Created by the trusted authorization layer after approval/version checks."""

    action_id: str
    action_hash: str


async def execute_write(plan, authorization, ledger, operation):
    if authorization is None:
        return plan
    if ledger is None or not authorization.action_id or authorization.action_hash != plan["action_hash"]:
        raise PermissionError("Approved action and durable ledger must match the preview")
    if not await ledger.claim(authorization.action_id, authorization.action_hash):
        existing = await ledger.get(authorization.action_id)
        if existing.get("action_hash") != authorization.action_hash:
            raise PermissionError("Action ID belongs to a different payload")
        return existing
    enter_dispatch = getattr(ledger, "mark_dispatching", None)
    if enter_dispatch is not None and not await enter_dispatch(authorization.action_id):
        return await ledger.get(authorization.action_id)
    result = {"action_id": authorization.action_id, "action_hash": plan["action_hash"]}
    try:
        response = await operation()
        result.update(response)
    except asyncio.CancelledError:
        # A pending claim survives cancellation even if recording the result fails.
        result.update(write_status="unknown", reason="cancelled_after_claim")
        await asyncio.shield(ledger.finish(authorization.action_id, result))
        raise
    except WriteOutcomeUnknown:
        result.update(write_status="unknown", reason="external_write_outcome_unknown")
    except ConnectorError as error:
        result.update(write_status="failed", reason=str(error))
    except Exception:
        result.update(write_status="unknown", reason="unexpected_failure_after_claim")
    await ledger.finish(authorization.action_id, result)
    return result
