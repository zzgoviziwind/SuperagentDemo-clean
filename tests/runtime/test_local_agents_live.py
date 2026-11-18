"""Opt-in, isolated real account smoke check. Never enabled by the default suite."""
import asyncio
import hashlib
import os

import pytest

from superagent.core.local_agents import discover_executable, existing_home, probe_account
from superagent.runtime.codex import CodexAppServer


@pytest.mark.skipif(os.getenv('SUPERAGENT_TEST_EXISTING_CODEX') != '1', reason='真实本机账号验证需显式启用')
def test_real_existing_login_thread_roundtrip(tmp_path):
    async def run():
        executable = discover_executable()
        assert executable
        home = existing_home()
        config = home / 'config.toml'
        config_before = hashlib.sha256(config.read_bytes()).hexdigest() if config.exists() else None
        assert (await probe_account(executable, home))['auth_status'] == 'authenticated'
        client = CodexAppServer(executable, str(tmp_path), {'timeout': 20},
                                use_existing_login=True, codex_home=str(home))
        ident = None
        try:
            await client.start()
            thread = await client.start_thread(str(tmp_path), read_only=True, tool_less=True,
                instructions='This is an isolated protocol smoke test. Use no tools. Answer only LOCAL_AGENT_V4_OK.')
            ident = thread['id']
            turn = await client.start_turn(ident, 'Reply only LOCAL_AGENT_V4_OK. Use no tools.')
            async def completed():
                async for event in client.events():
                    if 'id' in event:
                        if event['method'] in ('item/commandExecution/requestApproval', 'item/fileChange/requestApproval'):
                            await client.respond_approval(event['id'], 'reject')
                        raise AssertionError('隔离验证意外请求工具或审批')
                    params = event.get('params') or {}
                    if event.get('method') == 'item/started':
                        assert params.get('item', {}).get('type') not in (
                            'commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall')
                    if event.get('method') == 'turn/completed' and params.get('turn', {}).get('id') == turn['id']:
                        assert params['turn']['status'] == 'completed'
                        return
                raise AssertionError('协议断线')
            await asyncio.wait_for(completed(), 60)
            history = await client.read_thread(ident, include_turns=True)
            assert any('LOCAL_AGENT_V4_OK' in item.get('text', '')
                       for turn in history['thread']['turns'] for item in turn['items'])
        finally:
            await client.close()
        restored = CodexAppServer(executable, str(tmp_path), {'timeout': 20},
                                  use_existing_login=True, codex_home=str(home))
        try:
            await restored.start()
            resumed = await restored.resume_thread(ident, read_only=True, tool_less=True)
            assert resumed['id'] == ident
            history = await restored.read_thread(ident, include_turns=True)
            assert any('LOCAL_AGENT_V4_OK' in item.get('text', '')
                       for turn in history['thread']['turns'] for item in turn['items'])
            print('真实本机账号验证通过，线程创建、可见回复、跨进程恢复及历史读取成功。')
        finally:
            await restored.close()
        config_after = hashlib.sha256(config.read_bytes()).hexdigest() if config.exists() else None
        assert config_before == config_after
    asyncio.run(run())
