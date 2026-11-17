import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from superagent.runtime.codex import CodexAppServer

class EnvironmentTest(unittest.IsolatedAsyncioTestCase):
    async def test_child_only_gets_allowlisted_environment(self):
        fake = str(Path(__file__).with_name('env_server.py').resolve())
        values = {'SUPERAGENT_API_TOKEN':'fake-token', 'SUPERAGENT_USERS_JSON':'fake-users', 'REDMINE_API_KEY':'fake-redmine', 'DATABASE_URL':'fake-db', 'OPENAI_API_KEY':'fake-openai-key', 'CODEX_HOME':'fake-untrusted-home'}
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as temp, patch.dict(os.environ, {**values, 'SUPERAGENT_CODEX_HOME': str(Path(temp).resolve())}):
            client = CodexAppServer([sys.executable, fake], '.', {'timeout': 10})
            try:
                await client.start()
                result = await client._request('env/check', {})
                for name in ('api_token_present','users_present','redmine_present','database_present'):
                    self.assertFalse(result[name])
                self.assertTrue(result['api_key_present'])
                args = result['argv']
                for feature in ('plugins', 'apps', 'remote_plugin', 'hooks', 'plugin_discovery_prefetch'):
                    self.assertTrue(any(args[i:i+2] == ['--disable', feature] for i in range(len(args)-1)))
                self.assertNotEqual(result['codex_home'], 'fake-untrusted-home')
                self.assertTrue(Path(result['codex_home']).is_dir())
            finally:
                await client.close()
            self.assertTrue(Path(result['codex_home']).exists())
            home = Path(result['codex_home'])
            (home / 'plugins' / 'cache' / 'remote').mkdir(parents=True)
            (home / 'plugins' / '.remote-plugin-install-staging').mkdir()
            client2 = CodexAppServer([sys.executable, fake], '.', {'timeout': 10})
            try:
                client1 = CodexAppServer([sys.executable, fake], '.', {'timeout': 10})
                await client1.start()
                await client1.start_thread('.')
                await client1.close()
                await client2.start()
                self.assertEqual((await client2.resume_thread('saved'))['id'], 'saved')
            finally:
                await client2.close()

    async def test_unexpected_plugin_state_and_config_rejected(self):
        fake = str(Path(__file__).with_name('env_server.py').resolve())
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as temp:
            home = Path(temp).resolve()
            with patch.dict(os.environ, {'SUPERAGENT_CODEX_HOME': str(home)}):
                (home / 'plugins' / 'custom').mkdir(parents=True)
                with self.assertRaisesRegex(Exception, 'unexpected plugin state'):
                    await CodexAppServer([sys.executable, fake], '.', {'timeout': 10}).start()
                (home / 'plugins' / 'custom').rmdir()
                (home / 'config.toml').write_text('[mcp_servers.example]\n', encoding='utf-8')
                with self.assertRaisesRegex(Exception, 'disallowed tool configuration'):
                    await CodexAppServer([sys.executable, fake], '.', {'timeout': 10}).start()
