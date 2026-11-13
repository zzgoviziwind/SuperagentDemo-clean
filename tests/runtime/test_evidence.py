import unittest
import os
from unittest.mock import patch
from superagent.runtime.evidence import EvidenceCollector
from superagent.runtime.outcome import assess_outcome
from pathlib import Path

class EvidenceTest(unittest.TestCase):
    def test_only_real_matching_successful_command_is_test_evidence(self):
        cwd = str(Path('.').resolve())
        collector = EvidenceCollector('thread', 'turn', cwd, 'pytest -q')
        def item(command, status='completed', code=0, output='passed', turn='turn'):
            return {'method': 'item/completed', 'params': {'threadId':'thread', 'turnId':turn, 'item': {'id':command, 'type':'commandExecution', 'command':command, 'cwd':cwd, 'status':status, 'exitCode':code, 'aggregatedOutput':output}}}
        collector.add_event(item('pytest -q', turn='other'))
        collector.add_event(item('echo pytest -q'))
        self.assertEqual(collector.snapshot()['verification']['status'], 'unverified')
        collector.add_event(item('pytest -q', 'failed', 1, 'blocked by policy'))
        snapshot = collector.snapshot()
        self.assertEqual(snapshot['verification']['status'], 'unverified')
        self.assertEqual(snapshot['commands'][-1]['output'], 'blocked by policy')
        collector.add_event(item('pytest -q'))
        snapshot = collector.snapshot()
        self.assertEqual(snapshot['verification']['status'], 'passed')
        self.assertEqual(len(snapshot['tool_failures']), 1)
        collector.mark_incomplete()
        self.assertEqual(collector.snapshot()['verification']['status'], 'unverified')

    def test_wrapped_command_requires_exact_single_shell_payload(self):
        cwd = str(Path('.').resolve())
        expected = 'python -B -m unittest -v'
        def valid(command):
            c = EvidenceCollector('thread','turn',cwd,expected)
            c.add_event({'method':'item/completed','params':{'threadId':'thread','turnId':'turn','item':{'type':'commandExecution','id':'test','command':command,'cwd':cwd,'status':'completed','exitCode':0,'aggregatedOutput':'OK'}}})
            return c.snapshot()['verification']['status']
        wrapper = "\"C:\\Program Files\\PowerShell\\7\\pwsh.exe\" -Command 'python -B -m unittest -v'"
        with patch.dict('os.environ', {'ProgramFiles': r'C:\Program Files'}):
            self.assertEqual(valid(wrapper),'passed')
            self.assertEqual(valid("\"C:\\evil\\pwsh.exe\" -Command 'python -B -m unittest -v'"),'unverified')
        if os.name != 'nt':
            with patch('superagent.runtime.evidence.shutil.which', return_value='/usr/bin/bash'):
                self.assertEqual(valid("bash -c 'python -B -m unittest -v'"),'passed')
        prefix = wrapper.split(' -Command ')[0] + ' -Command '
        with patch.dict('os.environ', {'ProgramFiles': r'C:\Program Files'}):
            for suffix in ("'echo x; python -B -m unittest -v'", "'python -B -m unittest -v; echo x'", "'python -B -m unittest -v' extra", "'python -B -m unittest -v && echo ok'", "'python -B -m unittest -v' ; echo x"):
                with self.subTest(command=suffix): self.assertEqual(valid(prefix + suffix),'unverified')

    def test_verification_invalidated_by_later_tools(self):
        cwd = str(Path('.').resolve())
        c = EvidenceCollector('thread', 'turn', cwd, 'pytest -q')
        def send(method, kind, ident, **fields):
            c.add_event({'method':method, 'params':{'threadId':'thread','turnId':'turn', 'item':{'id':ident,'type':kind,**fields}}})
        def test_run(ident):
            send('item/started','commandExecution',ident,command='pytest -q',cwd=cwd)
            send('item/completed','commandExecution',ident,command='pytest -q',cwd=cwd,status='completed',exitCode=0,aggregatedOutput='ok')
        test_run('test1')
        self.assertEqual(c.snapshot()['verification']['status'], 'passed')
        send('item/completed','agentMessage','message',text='ok')
        self.assertEqual(c.snapshot()['verification']['status'], 'passed')
        for kind in ('fileChange','commandExecution','mcpToolCall'):
            send('item/started',kind,kind)
            self.assertEqual(c.snapshot()['verification']['status'], 'unverified')
            send('item/completed',kind,kind,status='completed')
            test_run('test-'+kind)
            self.assertEqual(c.snapshot()['verification']['status'], 'passed')
        send('item/started','mcpToolCall','long')
        test_run('concurrent')
        self.assertEqual(c.snapshot()['verification']['status'], 'unverified')
        send('item/completed','mcpToolCall','long',status='completed')
        self.assertEqual(c.snapshot()['verification']['status'], 'unverified')

    def test_failed_command_prevents_analysis_acceptance(self):
        event = {'method':'item/completed', 'params':{'item':{'type':'commandExecution','id':'a','status':'failed','exitCode':1}}}
        result = assess_outcome(task_kind='analysis',turn_status='completed',events=[event],verification={'status':'passed','evidence':'source'},outcome={'status':'completed'})
        self.assertEqual(result['suggested_status'], 'waiting_input')
        self.assertEqual(result['tool_failures'][0]['item_id'], 'a')
