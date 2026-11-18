import unittest
import pytest
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


def test_reference_reads_require_an_explicit_alias_and_cannot_escape(tmp_path):
    from superagent.runtime.readonly_tools import run_scoped_tool, reference_root, AccessDenied
    workspace = tmp_path / 'work'
    workspace.mkdir()
    source = tmp_path / 'other'
    source.mkdir()
    (source / 'proof.txt').write_text('reference only')
    (source / '.env').write_text('private')
    path = {'path': '@refs/project-2/proof.txt'}
    with pytest.raises(AccessDenied):
        run_scoped_tool(workspace, {}, 'read_file', path)
    args = {'project-2': str(source)}
    result, _ = run_scoped_tool(workspace, args, 'read_file', path)
    assert result['reference'] == '@refs/project-2'
    assert result['lines'][0]['text'] == 'reference only'
    for rejected in ('@refs/project-2/.env', '@refs/project-2/../work/file.txt', str(source / 'proof.txt')):
        with pytest.raises(AccessDenied):
            run_scoped_tool(workspace, args, 'read_file', {'path': rejected})
    with pytest.raises(AccessDenied):
        reference_root(tmp_path.anchor)
