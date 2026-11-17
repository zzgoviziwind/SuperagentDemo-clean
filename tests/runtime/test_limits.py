import subprocess
import tempfile
import os
import unittest
from pathlib import Path
from unittest.mock import patch
from superagent.runtime.codex import CodexAppServer
from superagent.runtime.workspace import collect_changes

class LimitsTest(unittest.TestCase):
    def test_unsafe_config_rejected(self):
        for config in ({'sandbox':'danger-full-access'}, {'approvalPolicy':'never'}, {'config':{'sandbox_mode':'danger-full-access'}}, {'effort':'high'}):
            with self.subTest(config=config), self.assertRaises(ValueError):
                CodexAppServer('codex', '.', config)
        CodexAppServer('codex', '.', {'model':'gpt-6.1-sol', 'timeout':2})

    def test_service_home_requires_clearing_parent_codex_home_after_login(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as tmp:
            service_home = str(Path(tmp).resolve())
            with patch.dict(os.environ, {'SUPERAGENT_CODEX_HOME': service_home, 'CODEX_HOME': service_home}):
                with self.assertRaisesRegex(ValueError, 'separate'):
                    CodexAppServer('codex', '.')
                del os.environ['CODEX_HOME']
                self.assertEqual(CodexAppServer('codex', '.').codex_home, Path(service_home))

    def test_large_tracked_diff_rejected_and_tracked_reparse_rejected(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as tmp:
            repo = Path(tmp).resolve()
            def git(*args): return subprocess.run(['git','-C',str(repo),*args],check=True,capture_output=True,text=True,encoding="utf-8").stdout.strip()
            git('init'); git('config','user.email','test@example.invalid'); git('config','user.name','Test')
            tracked=repo/'tracked.txt'; tracked.write_text('before')
            git('add','.'); git('commit','-m','test（common）：建立差异限制测试基线'); base=git('rev-parse','HEAD')
            tracked.write_text('x'*8192)
            with self.assertRaisesRegex(ValueError,'size limit'): collect_changes(repo,base,max_total_bytes=1024)
            original = Path.lstat
            class Reparse:
                st_mode = 0o100644
                st_file_attributes = 0x400
            def fake_lstat(path):
                return Reparse() if path == tracked else original(path)
            with patch.object(Path,'lstat',fake_lstat), self.assertRaisesRegex(ValueError,'reparse'):
                collect_changes(repo,base)
