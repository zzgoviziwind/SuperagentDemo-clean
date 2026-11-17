"""Outbound execution daemon. No inbound socket and no remote shell endpoint."""
import asyncio
import json
import os
import time
import uuid
from pathlib import Path
from urllib.parse import urlparse
from urllib.request import Request, urlopen

from superagent.core.execution_nodes import signature, METHODS
from .codex import CodexAppServer
from .workspace import _no_links


class Daemon:
    def __init__(self, url, node_id, token, roots, executable, *, client_factory=CodexAppServer):
        parsed = urlparse(url)
        if parsed.scheme != 'https' and not (parsed.scheme == 'http' and parsed.hostname in ('localhost', '127.0.0.1', '::1')):
            raise ValueError('控制服务远端地址必须使用 HTTPS')
        if not token or not roots or not executable:
            raise ValueError('缺少节点凭据、根目录或固定执行引擎')
        self.url, self.node_id, self.token = url.rstrip('/'), node_id, token
        self.roots = [Path(root).resolve(strict=True) for root in roots]
        self.executable, self.factory = executable, client_factory
        self.boot_id = uuid.uuid4().hex
        self.clients, self.pumps, self.sequences = {}, {}, {}
        self.events = asyncio.Queue(maxsize=1000)
        self.jobs = set()
        self.seen = set()

    def path(self, value):
        path = Path(value)
        if not path.is_absolute():
            raise ValueError('执行路径必须为绝对路径')
        resolved = path.resolve(strict=True)
        root = next((root for root in self.roots if resolved == root or root in resolved.parents), None)
        if root is None:
            raise ValueError('执行路径越界')
        _no_links(root, path.relative_to(root).parts)
        return str(resolved)

    async def post(self, endpoint, payload):
        path = '/api/v1/operations/daemon/' + endpoint
        body = json.dumps(payload, separators=(',', ':'), ensure_ascii=False).encode()
        timestamp, nonce = str(time.time()), uuid.uuid4().hex
        headers = {'Content-Type': 'application/json', 'X-Node-Id': self.node_id,
                   'X-Node-Time': timestamp, 'X-Node-Nonce': nonce,
                   'X-Node-Signature': signature(self.token, timestamp, nonce, path, body)}
        def send():
            with urlopen(Request(self.url + path, data=body, headers=headers, method='POST'), timeout=10) as response:
                return json.load(response)
        return await asyncio.to_thread(send)

    async def pump(self, session_id, client):
        try:
            async for event in client.events():
                if event.get('method') == 'runtime/stderr':
                    continue
                self.sequences[session_id] += 1
                await self.events.put({'session_id': session_id, 'sequence': self.sequences[session_id], 'payload': event})
        finally:
            self.sequences[session_id] += 1
            await self.events.put({'session_id': session_id, 'sequence': self.sequences[session_id],
                                   'payload': {'method': 'runtime/disconnected', 'params': {}}})

    async def dispatch(self, operation):
        if operation['id'] in self.seen or operation['deadline'] < time.time():
            raise ValueError('操作已执行或租约已过期')
        self.seen.add(operation['id'])
        method, session_id = operation['method'], operation['session_id']
        payload = dict(operation['payload'])
        if method not in METHODS:
            raise ValueError('不支持的执行操作')
        if method == 'start':
            if session_id in self.clients or len(self.clients) >= 4:
                raise ValueError('会话重复或容量已满')
            cwd = self.path(payload['cwd'])
            client = self.factory(self.executable, cwd, config=payload.get('config'))
            self.clients[session_id] = client
            self.sequences[session_id] = 0
            await client.start()
            self.pumps[session_id] = asyncio.create_task(self.pump(session_id, client))
            return None
        client = self.clients.get(session_id)
        if client is None:
            raise ValueError('会话不存在，禁止重建重放')
        if method == 'start_thread':
            if self.path(payload['cwd']) != client.cwd:
                raise ValueError('会话目录不一致')
        if method == 'start_turn':
            for path in payload.get('image_paths') or []:
                self.path(path)
            if payload.get('attachment_root'):
                self.path(payload['attachment_root'])
        result = await getattr(client, method)(**payload)
        if method == 'close':
            self.clients.pop(session_id, None)
            pump = self.pumps.pop(session_id, None)
            if pump:
                pump.cancel()
                await asyncio.gather(pump, return_exceptions=True)
        return result

    async def execute(self, operation):
        try:
            value = await asyncio.wait_for(self.dispatch(operation), max(.01, operation['deadline'] - time.time()))
            result = {'value': value}
        except Exception as exc:
            # Errors can occur after a command was accepted. Never retry execution.
            result = {'error': type(exc).__name__}
        await self.post('exchange', {'operation_id': operation['id'], 'lease': operation['lease'], 'result': result})

    async def run(self):
        try:
            while True:
                # Poll independently while start_turn or shutdown waits for the engine.
                response = await self.post('poll', {'boot_id': self.boot_id})
                authorized = set(response.get('active_sessions', []))
                for session_id in list(self.clients):
                    if session_id not in authorized:
                        client = self.clients.pop(session_id)
                        await client.close()
                        pump = self.pumps.pop(session_id, None)
                        if pump:
                            pump.cancel()
                            await asyncio.gather(pump, return_exceptions=True)
                if response.get('operation'):
                    job = asyncio.create_task(self.execute(response['operation']))
                    self.jobs.add(job)
                finished = {job for job in self.jobs if job.done()}
                for job in finished:
                    job.result()
                self.jobs -= finished
                batch = []
                while not self.events.empty() and len(batch) < 50:
                    batch.append(self.events.get_nowait())
                if batch:
                    await self.post('exchange', {'events': batch})
                await asyncio.sleep(.15)
        finally:
            for job in self.jobs:
                job.cancel()
            await asyncio.gather(*self.jobs, return_exceptions=True)
            for client in self.clients.values():
                await client.close()
            for pump in self.pumps.values():
                pump.cancel()
            await asyncio.gather(*self.pumps.values(), return_exceptions=True)


def main():
    raw = os.environ['SUPERAGENT_CODEX_EXECUTABLE']
    executable = json.loads(raw) if raw.lstrip().startswith('[') else raw
    daemon = Daemon(os.environ['SUPERAGENT_CONTROL_URL'], os.environ['SUPERAGENT_NODE_ID'],
                    os.environ['SUPERAGENT_NODE_TOKEN'], json.loads(os.environ['SUPERAGENT_DAEMON_ROOTS']), executable)
    asyncio.run(daemon.run())


if __name__ == '__main__':
    main()
