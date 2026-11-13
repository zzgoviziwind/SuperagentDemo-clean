"""Async newline-delimited Codex app-server transport."""
import asyncio
import json
import os
import signal
import subprocess
from pathlib import Path

from .workspace import _no_links


def _readonly_tools():
    def definition(name, description, properties, required):
        return {'type': 'function', 'name': name, 'description': description,
                'inputSchema': {'type': 'object', 'properties': properties,
                                'required': required, 'additionalProperties': False}}
    path = {'type': 'string', 'description': '仓库相对路径'}
    return [definition('list_files', '列出允许目录内的文件。', {'path': path}, ['path']),
            definition('read_file', '读取允许范围内的文本文件，可指定起始行和行数。',
                       {'path': path, 'start_line': {'type': 'integer', 'minimum': 1},
                        'max_lines': {'type': 'integer', 'minimum': 1, 'maximum': 200}}, ['path']),
            definition('search_text', '在允许范围内搜索文本。',
                       {'path': path, 'query': {'type': 'string'}}, ['path', 'query'])]


class CodexError(RuntimeError):
    pass


class UnknownOutcome(CodexError):
    """A sent request timed out or disconnected; reconcile before retrying."""


class CodexAppServer:
    def __init__(self, executable, cwd, config=None):
        self.command = [executable] if isinstance(executable, str) else list(executable)
        self.cwd = os.path.abspath(cwd)
        self.config = dict(config or {})
        self.timeout = self.config.pop('timeout', 30)
        self.max_line_bytes = self.config.pop('max_line_bytes', 8 * 1024 * 1024)
        if set(self.config) - {'model'}:
            raise ValueError('unsupported or unsafe thread configuration')
        if 'model' in self.config and (not isinstance(self.config['model'], str) or not self.config['model'].strip()):
            raise ValueError('model must be a nonempty string')
        if not 65536 <= self.max_line_bytes <= 32 * 1024 * 1024:
            raise ValueError('max_line_bytes must be between 64 KiB and 32 MiB')
        self.active_turns = set()
        self.completed_turns = set()
        self.turn_finished = asyncio.Event()
        self.pending = {}
        self.approvals = {}
        self.pending_tools = {}
        self.readonly_threads = set()
        self.queue = asyncio.Queue()
        self.next_id = 0
        self.process = None
        configured_home = os.environ.get('SUPERAGENT_CODEX_HOME')
        if configured_home and not os.path.isabs(configured_home):
            raise ValueError('SUPERAGENT_CODEX_HOME must be absolute')
        self.codex_home = Path(configured_home or (Path.cwd() / 'data' / 'codex-state')).resolve()
        user_homes = {Path.home().joinpath('.codex').resolve()}
        if os.environ.get('CODEX_HOME'):
            user_homes.add(Path(os.environ['CODEX_HOME']).resolve())
        if any(self.codex_home == home or home in self.codex_home.parents for home in user_homes):
            raise ValueError('service Codex home must be separate from user Codex home')
        self.reader = None
        self.stderr_reader = None
        self.lock = asyncio.Lock()

    async def start(self):
        if self.process is not None:
            raise CodexError('client already started')
        kwargs = {'start_new_session': True} if os.name != 'nt' else {'creationflags': subprocess.CREATE_NEW_PROCESS_GROUP}
        # An isolated home avoids loading the interactive user's Codex config,
        # plugins and MCP servers. No application/channel/database env is inherited.
        self.codex_home.mkdir(parents=True, exist_ok=True)
        if (self.codex_home / 'config.toml').exists() or list(self.codex_home.glob('*.config.toml')):
            raise CodexError('service Codex home has disallowed tool configuration')
        plugins = self.codex_home / 'plugins'
        _no_links(self.codex_home, ('plugins',))
        if plugins.exists():
            if not plugins.is_dir():
                raise CodexError('invalid plugins directory')
            for entry in plugins.iterdir():
                if entry.name not in ('cache', '.remote-plugin-install-staging'):
                    raise CodexError('service Codex home has unexpected plugin state')
                _no_links(self.codex_home, ('plugins', entry.name))
                if not entry.is_dir():
                    raise CodexError('invalid plugin cache')
        allowed_env = ('PATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT',
                       'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE',
                       'HOMEDRIVE', 'HOMEPATH', 'LOCALAPPDATA', 'APPDATA',
                       'LANG', 'LC_ALL', 'LC_CTYPE', 'SSL_CERT_FILE',
                       'SSL_CERT_DIR', 'OPENAI_API_KEY', 'CODEX_API_KEY')
        environment = {key: os.environ[key] for key in allowed_env if key in os.environ}
        environment['CODEX_HOME'] = str(self.codex_home)
        self.process = await asyncio.create_subprocess_exec(*self.command, 'app-server', '--disable', 'plugins', '--disable', 'apps', '--disable', 'remote_plugin', '--disable', 'hooks', '--disable', 'plugin_discovery_prefetch', cwd=self.cwd, env=environment, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, limit=self.max_line_bytes, **kwargs)
        self.reader = asyncio.create_task(self._read())
        self.stderr_reader = asyncio.create_task(self._stderr())
        try:
            await self._request('initialize', {'clientInfo': {'name': 'superagent', 'title': 'SuperAgent', 'version': '0.1.0'}, 'capabilities': {'experimentalApi': True}})
            await self._send({'method': 'initialized', 'params': {}})
        except BaseException:
            await self.close()
            raise

    async def _send(self, message):
        if not self.process or self.process.returncode is not None:
            raise CodexError('app-server is not running')
        async with self.lock:
            self.process.stdin.write((json.dumps(message, ensure_ascii=False) + '\n').encode())
            await self.process.stdin.drain()

    async def _request(self, method, params):
        self.next_id += 1
        ident = self.next_id
        future = asyncio.get_running_loop().create_future()
        self.pending[ident] = future
        try:
            await self._send({'id': ident, 'method': method, 'params': params})
            try:
                return await asyncio.wait_for(asyncio.shield(future), self.timeout)
            except asyncio.TimeoutError as exc:
                raise UnknownOutcome(f'{method} timed out; outcome unknown') from exc
        finally:
            self.pending.pop(ident, None)
            if not future.done():
                future.cancel()

    async def _read(self):
        try:
            while line := await self.process.stdout.readline():
                try:
                    msg = json.loads(line)
                except (ValueError, UnicodeDecodeError):
                    await self.queue.put({'method': 'runtime/protocol_error', 'params': {'detail': 'invalid JSON'}})
                    continue
                if 'method' in msg:
                    if msg['method'] == 'turn/completed':
                        params = msg.get('params', {})
                        key = (params.get('threadId'), params.get('turn', {}).get('id'))
                        self.completed_turns.add(key)
                        self.active_turns.discard(key)
                        self.turn_finished.set()
                    if 'id' in msg:
                        if msg['method'] == 'item/tool/call':
                            self.pending_tools[msg['id']] = msg.get('params') or {}
                        else:
                            self.approvals[msg['id']] = {'method': msg['method'], 'availableDecisions': (msg.get('params') or {}).get('availableDecisions')}
                    await self.queue.put(msg)
                elif msg.get('id') in self.pending:
                    future = self.pending[msg['id']]
                    if not future.done():
                        if 'error' in msg:
                            future.set_exception(CodexError(str(msg['error'])))
                        else:
                            future.set_result(msg.get('result', {}))
                else:
                    await self.queue.put({'method': 'runtime/late_response', 'params': msg})
        except Exception as exc:
            await self.queue.put({'method': 'runtime/protocol_error', 'params': {'detail': f'reader failed: {type(exc).__name__}: {exc}'}})
        finally:
            for future in list(self.pending.values()):
                if not future.done():
                    future.set_exception(UnknownOutcome('app-server disconnected; outcome unknown'))
            await self.queue.put({'method': 'runtime/disconnected', 'params': {'returncode': self.process.returncode}})
            await self.queue.put(None)

    async def _stderr(self):
        while line := await self.process.stderr.read(4096):
            await self.queue.put({'method': 'runtime/stderr', 'params': {'text': line.decode('utf-8', 'replace').rstrip()}})

    async def start_thread(self, cwd, instructions='', *, read_only=False):
        if not isinstance(read_only, bool):
            raise ValueError('read_only must be a boolean')
        params = {'cwd': os.path.abspath(cwd), 'approvalPolicy': 'on-request', 'sandbox': 'read-only' if read_only else 'workspace-write', **self.config}
        if instructions:
            params['developerInstructions'] = instructions
        if read_only:
            params['dynamicTools'] = _readonly_tools()
        thread = (await self._request('thread/start', params))['thread']
        if read_only:
            self.readonly_threads.add(thread['id'])
        return thread

    async def resume_thread(self, thread_id, *, read_only=False):
        if not isinstance(read_only, bool):
            raise ValueError('read_only must be a boolean')
        thread = (await self._request('thread/resume', {'threadId': thread_id, 'approvalPolicy': 'on-request', 'sandbox': 'read-only' if read_only else 'workspace-write'}))['thread']
        if read_only:
            self.readonly_threads.add(thread_id)
        else:
            self.readonly_threads.discard(thread_id)
        return thread

    async def start_turn(self, thread_id, prompt, *, model=None, effort=None, image_paths=None, attachment_root=None):
        inputs = [{'type': 'text', 'text': prompt, 'text_elements': []}]
        if image_paths:
            if not attachment_root or not isinstance(image_paths, list) or len(image_paths) > 10:
                raise ValueError('images require attachment_root and at most 10 paths')
            root = Path(attachment_root).resolve(strict=True)
            if not root.is_dir():
                raise ValueError('attachment_root must be a directory')
            for value in image_paths:
                path = Path(value)
                if not path.is_absolute():
                    raise ValueError('image path must be absolute')
                try:
                    parts = path.relative_to(root).parts
                except ValueError as exc:
                    raise ValueError('image outside attachment root') from exc
                if not parts or any(x in ('.', '..') for x in parts):
                    raise ValueError('invalid image path')
                _no_links(root, parts)
                resolved = path.resolve(strict=True)
                if root not in resolved.parents or not resolved.is_file() or resolved.stat().st_size > 10 * 1024 * 1024:
                    raise ValueError('invalid or oversized image')
                with resolved.open('rb') as stream:
                    header = stream.read(16)
                if not (header.startswith(b'\x89PNG\r\n\x1a\n') or header.startswith(b'\xff\xd8\xff') or header.startswith((b'GIF87a', b'GIF89a')) or (header.startswith(b'RIFF') and header[8:12] == b'WEBP')):
                    raise ValueError('unsupported image format')
                inputs.append({'type': 'localImage', 'path': str(resolved)})
        params = {'threadId': thread_id, 'input': inputs}
        if model is not None:
            if not isinstance(model, str) or not model.strip():
                raise ValueError('model must be a nonempty string')
            params['model'] = model
        if effort is not None:
            if not isinstance(effort, str) or not effort.strip():
                raise ValueError('effort must be a nonempty string')
            params['effort'] = effort
        turn = (await self._request('turn/start', params))['turn']
        key = (thread_id, turn['id'])
        if key not in self.completed_turns:
            self.active_turns.add(key)
        return turn

    async def steer_turn(self, thread_id, turn_id, prompt):
        return await self._request('turn/steer', {'threadId': thread_id, 'expectedTurnId': turn_id, 'input': [{'type': 'text', 'text': prompt, 'text_elements': []}]})

    async def interrupt_turn(self, thread_id, turn_id):
        return await self._request('turn/interrupt', {'threadId': thread_id, 'turnId': turn_id})

    async def read_thread(self, thread_id):
        return await self._request('thread/read', {'threadId': thread_id, 'includeTurns': True})

    async def respond_approval(self, request_id, decision):
        request = self.approvals.get(request_id)
        if not isinstance(request, dict) or request.get('method') not in ('item/commandExecution/requestApproval', 'item/fileChange/requestApproval'):
            raise CodexError('unknown or unsupported approval request')
        if decision not in ('approve', 'reject'):
            raise ValueError('decision must be approve or reject')
        options = request.get('availableDecisions')
        if options is not None and not isinstance(options, list):
            raise CodexError('invalid availableDecisions')
        choices = ['accept'] if decision == 'approve' else ['decline', 'cancel']
        selected = next((choice for choice in choices if options is None or choice in options), None)
        if selected is None:
            raise CodexError('no supported safe approval decision available')
        await self._send({'id': request_id, 'result': {'decision': selected}})
        del self.approvals[request_id]

    async def respond_tool(self, request_id, result):
        params = self.pending_tools.get(request_id)
        if (not isinstance(params, dict) or params.get('threadId') not in self.readonly_threads
                or (params.get('threadId'), params.get('turnId')) not in self.active_turns
                or params.get('tool') not in ('list_files', 'read_file', 'search_text')
                or params.get('namespace') is not None):
            raise CodexError('unknown or unauthorized dynamic tool request')
        if not isinstance(result, dict) or set(result) != {'contentItems', 'success'} or not isinstance(result['success'], bool):
            raise ValueError('invalid dynamic tool result')
        items = result['contentItems']
        if not isinstance(items, list) or len(items) > 16:
            raise ValueError('invalid dynamic tool content')
        size = 0
        for item in items:
            if not isinstance(item, dict) or set(item) != {'type', 'text'} or item['type'] != 'inputText' or not isinstance(item['text'], str):
                raise ValueError('only inputText is supported')
            size += len(item['text'].encode('utf-8'))
        if size > 1024 * 1024:
            raise ValueError('dynamic tool result exceeds limit')
        await self._send({'id': request_id, 'result': result})
        del self.pending_tools[request_id]

    async def events(self):
        while (event := await self.queue.get()) is not None:
            yield event

    async def close(self):
        if not self.process:
            return
        if self.process.returncode is None:
            for thread_id, turn_id in list(self.active_turns):
                try:
                    await asyncio.wait_for(self.interrupt_turn(thread_id, turn_id), min(self.timeout, 3))
                except (Exception, asyncio.CancelledError):
                    await self.queue.put({'method': 'runtime/interrupt_unconfirmed', 'params': {'threadId': thread_id, 'turnId': turn_id}})
            if self.active_turns:
                self.turn_finished.clear()
                try:
                    await asyncio.wait_for(self.turn_finished.wait(), 3)
                except asyncio.TimeoutError:
                    await self.queue.put({'method': 'runtime/interrupt_unconfirmed', 'params': {'turns': list(self.active_turns)}})
            if self.process.stdin:
                self.process.stdin.close()
            try:
                await asyncio.wait_for(self.process.wait(), 3)
            except asyncio.TimeoutError:
                await self.queue.put({'method': 'runtime/forced_termination', 'params': {}})
                if os.name == 'nt':
                    killer = await asyncio.create_subprocess_exec('taskkill', '/PID', str(self.process.pid), '/T', '/F', stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
                    await killer.wait()
                    if self.process.returncode is None:
                        self.process.kill()
                else:
                    try:
                        os.killpg(self.process.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                await self.process.wait()
        if self.reader:
            await self.reader
        if self.stderr_reader:
            await self.stderr_reader
