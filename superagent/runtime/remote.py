"""Codex interface backed by the durable outbound daemon mailbox."""
import asyncio
import time
import uuid

from sqlalchemy import select
from superagent.core import db
from superagent.core.execution_nodes import NodeOperation, NodeEvent, enqueue, renew
from .codex import UnknownOutcome


class RemoteCodexAppServer:
    def __init__(self, node_id, cwd, config=None, project_id=None, timeout=30):
        self.node_id, self.cwd = node_id, cwd
        self.config = config or {}
        self.project_id, self.timeout = project_id, timeout
        self.session_id = uuid.uuid4().hex
        self.closed = False

    async def call(self, method, **payload):
        if method not in ('start', 'close'):
            try:
                renew(self.session_id)
            except ValueError as exc:
                raise UnknownOutcome(str(exc)) from exc
        operation_id = enqueue(self.node_id, self.session_id, method, payload, self.timeout)
        deadline = time.monotonic() + self.timeout
        while time.monotonic() < deadline:
            with db.Session() as session:
                row = session.get(NodeOperation, operation_id)
                if row.status == 'done':
                    return row.result.get('value')
                if row.status in ('unknown', 'failed'):
                    raise UnknownOutcome('远端操作结果未知，需核验')
            await asyncio.sleep(.1)
        with db.Session.begin() as session:
            row = session.get(NodeOperation, operation_id)
            if row.status in ('queued', 'leased'):
                row.status = 'unknown'
        raise UnknownOutcome('远端操作超时，禁止自动重试')

    async def start(self):
        return await self.call('start', cwd=self.cwd, config=self.config, project_id=self.project_id)

    async def start_thread(self, cwd, instructions='', *, read_only=False):
        return await self.call('start_thread', cwd=cwd, instructions=instructions, read_only=read_only)

    async def resume_thread(self, thread_id, *, read_only=False):
        return await self.call('resume_thread', thread_id=thread_id, read_only=read_only)

    async def start_turn(self, thread_id, prompt, *, model=None, effort=None, image_paths=None, attachment_root=None):
        return await self.call('start_turn', thread_id=thread_id, prompt=prompt, model=model,
                               effort=effort, image_paths=image_paths, attachment_root=attachment_root)

    async def steer_turn(self, thread_id, turn_id, prompt):
        return await self.call('steer_turn', thread_id=thread_id, turn_id=turn_id, prompt=prompt)

    async def interrupt_turn(self, thread_id, turn_id):
        return await self.call('interrupt_turn', thread_id=thread_id, turn_id=turn_id)

    async def respond_approval(self, request_id, decision):
        return await self.call('respond_approval', request_id=request_id, decision=decision)

    async def respond_tool(self, request_id, result):
        return await self.call('respond_tool', request_id=request_id, result=result)

    async def events(self):
        cursor = 0
        renewed = 0
        while not self.closed:
            if time.monotonic() - renewed > 5:
                try:
                    renew(self.session_id)
                except ValueError:
                    yield {'method': 'runtime/disconnected', 'params': {}}
                    return
                renewed = time.monotonic()
            from superagent.core.execution_nodes import ExecutionNode
            with db.Session() as session:
                node = session.get(ExecutionNode, self.node_id)
                alive = node is not None and node.seen > time.time() - 30
                rows = session.scalars(select(NodeEvent).where(NodeEvent.session_id == self.session_id,
                                       NodeEvent.sequence > cursor).order_by(NodeEvent.sequence)).all()
            if not alive:
                yield {'method': 'runtime/disconnected', 'params': {}}
                return
            for row in rows:
                cursor = row.sequence
                yield row.payload
            await asyncio.sleep(.1)

    async def close(self):
        if not self.closed:
            try:
                await self.call('close')
            finally:
                self.closed = True
