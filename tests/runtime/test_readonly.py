import unittest
from unittest.mock import AsyncMock
from superagent.runtime.codex import CodexAppServer
from superagent.runtime.outcome import assess_outcome

class ReadOnlyTest(unittest.IsolatedAsyncioTestCase):
    async def test_start_and_resume_set_explicit_policy(self):
        client = CodexAppServer('unused', '.')
        client._request = AsyncMock(return_value={'thread': {'id': 'id'}})
        await client.start_thread('.', read_only=True)
        self.assertEqual(client._request.await_args.args[1]['sandbox'], 'read-only')
        self.assertEqual(client._request.await_args.args[1]['approvalPolicy'], 'on-request')
        await client.resume_thread('id', read_only=True)
        self.assertEqual(client._request.await_args.args[1]['sandbox'], 'read-only')
        self.assertEqual(client._request.await_args.args[1]['approvalPolicy'], 'on-request')
        await client.start_thread('.')
        self.assertEqual(client._request.await_args.args[1]['sandbox'], 'workspace-write')
        await client.resume_thread('id')
        self.assertEqual(client._request.await_args.args[1]['sandbox'], 'workspace-write')
        with self.assertRaises(ValueError): await client.start_thread('.', read_only='true')
        with self.assertRaises(ValueError): await client.resume_thread('id', read_only=1)

    async def test_analysis_with_changes_must_not_pass(self):
        for changes in ({'diff':'patch'}, {'untracked_artifacts':[{'path':'a'}]}, {'status':'?? ignored'}):
            result = assess_outcome(task_kind='analysis', turn_status='completed', events=[], changes=changes, verification={'status':'passed','evidence':'source'},outcome={'status':'completed'})
            self.assertEqual(result['suggested_status'], 'waiting_input')
            self.assertIn('analysis_workspace_changed', result['reasons'])
