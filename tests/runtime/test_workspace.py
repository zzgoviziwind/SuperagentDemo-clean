import base64
import subprocess
import tempfile
import unittest
from pathlib import Path
from superagent.runtime.workspace import prepare_workspace, collect_changes

class WorkspaceTest(unittest.TestCase):
    def test_committed_and_untracked_and_rejection(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as tmp:
            root = Path(tmp)
            repo = root / 'repo'; repo.mkdir()
            work = root / 'work'; work.mkdir()
            def git(where, *args):
                return subprocess.run(['git', '-C', str(where), *args], check=True, capture_output=True, text=True, encoding="utf-8").stdout.strip()
            git(repo, 'init')
            git(repo, 'config', 'user.email', 'test@example.invalid')
            git(repo, 'config', 'user.name', 'Test')
            (repo / 'a.txt').write_text('base')
            git(repo, 'add', 'a.txt'); git(repo, 'commit', '-m', 'test（common）：建立工作区测试基线')
            branch = git(repo, 'branch', '--show-current')
            result = prepare_workspace(repo, branch, 'one', work)
            clone = Path(result['path'])
            git(clone, 'config', 'user.email', 'test@example.invalid')
            git(clone, 'config', 'user.name', 'Test')
            (clone / 'a.txt').write_text('committed')
            git(clone, 'add', 'a.txt'); git(clone, 'commit', '-m', 'test（common）：调整工作区测试样本')
            (clone / 'new.txt').write_text('new content')
            changes = collect_changes(clone, result['base_sha'])
            self.assertIn('+committed', changes['diff'])
            self.assertEqual(base64.b64decode(changes['untracked_artifacts'][0]['content_base64']), b'new content')
            (clone / '.env').write_text('secret')
            with self.assertRaises(ValueError): collect_changes(clone, result['base_sha'])
