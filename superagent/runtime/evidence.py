"""Collect per-turn command evidence for the scheduler; never infer tests from prose."""
import os
import ntpath
import shlex
import shutil
from pathlib import Path


def _matches_test_command(actual, expected):
    """Allow a single known-shell wrapper around the exact configured command."""
    if not isinstance(actual, str) or not expected:
        return False
    if actual == expected:
        return True
    try:
        argv = shlex.split(actual, posix=True)
    except ValueError:
        return False
    if len(argv) != 3:
        return False
    executable = argv[0]
    # Only system installation locations qualify; an attacker-controlled
    # executable called pwsh/bash must not masquerade as the shell.
    if ntpath.isabs(executable) and ntpath.splitdrive(executable)[0]:
        normalized = ntpath.normcase(ntpath.normpath(executable))
        roots = [os.environ.get('SystemRoot'), os.environ.get('ProgramFiles'), os.environ.get('ProgramW6432')]
        trusted = False
        for root in roots:
            if root:
                root = ntpath.normcase(ntpath.normpath(root))
                try:
                    trusted = trusted or ntpath.commonpath((root, normalized)) == root
                except ValueError:
                    pass
        if not trusted:
            return False
    else:
        executable = executable if os.path.isabs(executable) else shutil.which(executable)
        if not executable or not os.path.isabs(executable):
            return False
        resolved = os.path.realpath(executable)
        if not any(resolved.startswith(root + os.sep) for root in ('/usr/bin', '/bin')):
            return False
    shell = ntpath.basename(executable).lower()
    flag = argv[1].lower()
    if shell in ('pwsh', 'pwsh.exe', 'powershell', 'powershell.exe'):
        if flag not in ('-command', '-c'):
            return False
    elif shell in ('sh', 'bash', 'sh.exe', 'bash.exe'):
        if flag != '-c':
            return False
    else:
        return False
    return argv[2] == expected


class EvidenceCollector:
    def __init__(self, thread_id, turn_id, workspace_path, test_command):
        if not thread_id or not turn_id:
            raise ValueError('thread_id and turn_id are required')
        self.thread_id = thread_id
        self.turn_id = turn_id
        self.workspace = os.path.normcase(str(Path(workspace_path).resolve()))
        self.test_command = test_command.strip() if isinstance(test_command, str) else ''
        self.commands = {}
        self.failures = []
        self.incomplete_stream = False
        self.sequence = 0
        self.write_watermark = 0
        self.active_tools = set()

    def add_event(self, event):
        method = event.get('method')
        params = event.get('params') or {}
        # Unscoped events cannot be attributed safely to this turn.
        event_turn = params.get('turnId') or (params.get('turn') or {}).get('id')
        if params.get('threadId') != self.thread_id or event_turn != self.turn_id:
            return False
        if method == 'error':
            self.failures.append({'type': 'server_error', 'params': params})
        if method in ('item/started', 'item/updated', 'item/completed'):
            item = params.get('item') or {}
            kind = item.get('type')
            if kind in ('commandExecution', 'fileChange', 'mcpToolCall'):
                self.sequence += 1
                self.write_watermark = self.sequence
                ident = item.get('id')
                if not ident:
                    self.incomplete_stream = True
                elif method == 'item/started':
                    self.active_tools.add(ident)
                elif method == 'item/completed':
                    self.active_tools.discard(ident)
            if kind == 'commandExecution' and item.get('id'):
                self.commands[item['id']] = {
                    'id': item['id'], 'command': item.get('command'),
                    'status': item.get('status'), 'exitCode': item.get('exitCode'),
                    'output': item.get('aggregatedOutput'), 'cwd': item.get('cwd'),
                    'completed_event': method == 'item/completed',
                    'sequence': self.sequence, 'other_tools_active': bool(self.active_tools),
                }
            if method == 'item/completed' and kind in ('commandExecution', 'fileChange', 'mcpToolCall'):
                if item.get('status') in ('failed', 'declined', 'cancelled', 'error') or (item.get('exitCode') is not None and item.get('exitCode') != 0):
                    self.failures.append({'type': kind, 'item': item})
        return True

    def mark_incomplete(self):
        """Call on disconnect, protocol error, replay gaps, or incomplete history."""
        self.incomplete_stream = True

    def snapshot(self):
        commands = list(self.commands.values())
        matches = []
        for command in commands:
            cwd = command['cwd']
            if not isinstance(cwd, str) or not os.path.isabs(cwd):
                continue
            cwd = os.path.normcase(str(Path(cwd).resolve()))
            if (_matches_test_command(command['command'], self.test_command)
                    and cwd == self.workspace and command['completed_event']
                    and command['status'] == 'completed' and command['exitCode'] == 0
                    and isinstance(command['output'], str) and command['sequence'] == self.write_watermark
                    and not command['other_tools_active'] and not self.active_tools):
                matches.append(command['id'])
        valid = bool(matches) and not self.incomplete_stream
        return {'commands': commands, 'tool_failures': list(self.failures),
                'stream_incomplete': self.incomplete_stream,
                'verification': {'status': 'passed' if valid else 'unverified',
                                 'evidence': {'command_item_ids': matches} if valid else None}}
