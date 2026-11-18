import asyncio
import json
import os
import sys
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from superagent.core import db, governance as gov, local_agents as agents
from superagent.api import local_agents as api
from superagent.runtime.codex import CodexAppServer


@pytest.fixture
def local_store(tmp_path, monkeypatch):
    engine = create_engine('sqlite:///' + str(tmp_path / 'agents.db'), connect_args={'check_same_thread': False})
    db.Base.metadata.create_all(engine)
    factory = sessionmaker(engine, expire_on_commit=False)
    monkeypatch.setattr(db, 'Session', factory)
    program = tmp_path / 'codex.exe'
    program.write_text('offline fixture', encoding='utf-8')
    home = tmp_path / 'existing-home'
    home.mkdir()
    monkeypatch.setattr(agents, 'discover_executable', lambda agent_id='codex': str(program) if agent_id == 'codex' else None)
    monkeypatch.setattr(agents, '_version', lambda path: '0.167.0')
    monkeypatch.setattr(agents, 'existing_home', lambda: home)
    async def probe(executable, directory):
        return {'auth_status': 'authenticated', 'auth_type': 'chatgpt'}
    monkeypatch.setattr(agents, 'probe_account', probe)
    yield factory, program, home
    engine.dispose()


def test_explicit_connect_persists_and_enables_only_agent_services(local_store):
    _, executable, home = local_store
    assert agents.uses_subscription_account() is False
    before = asyncio.run(agents.agent_status())
    assert before['active_id'] is None
    assert before['items'][0]['installed'] is True
    assert not before['items'][1]['adapter_available']
    result = asyncio.run(agents.connect_agent('codex', use_existing_login=True, actor='admin'))
    assert result['execution_enabled'] is True
    assert agents.resolve_executable() == str(executable)
    assert agents.resolve_home() == str(home)
    assert agents.client_options() == {'use_existing_login': True, 'codex_home': str(home)}
    assert agents.uses_subscription_account() is True
    settings = gov.settings_snapshot()
    assert all(settings[key] for key in ('scheduler_enabled', 'router_agent_enabled', 'semantic_routing_enabled'))
    assert not settings['dingtalk_enabled']
    assert not settings['redmine_enabled']
    assert settings['budget_reservation_estimate_micros'] is None
    assert asyncio.run(agents.agent_status())['active_id'] == 'codex'
    executable.unlink()
    assert not agents.uses_subscription_account()
    with pytest.raises(ValueError):
        agents.resolve_executable()


@pytest.mark.parametrize('auth_type', ['api_key', 'unknown', 'chatgpt_external'])
def test_non_subscription_has_no_free_budget_bypass(local_store, monkeypatch, auth_type):
    async def probe(*args):
        return {'auth_status': 'authenticated', 'auth_type': auth_type}
    monkeypatch.setattr(agents, 'probe_account', probe)
    result = asyncio.run(agents.connect_agent('codex', use_existing_login=True, actor='admin'))
    assert not result['execution_enabled']
    assert result['budget_configuration_required']
    assert agents.uses_subscription_account() is False


def test_connect_rechecks_login_and_candidate(local_store, monkeypatch):
    from fastapi import HTTPException
    with pytest.raises(HTTPException):
        asyncio.run(agents.connect_agent('claude', use_existing_login=True, actor='admin'))
    with pytest.raises(HTTPException):
        asyncio.run(agents.connect_agent('codex', use_existing_login=False, actor='admin'))
    async def unauthenticated(*args):
        return {'auth_status': 'login_required', 'auth_type': 'unknown'}
    monkeypatch.setattr(agents, 'probe_account', unauthenticated)
    with pytest.raises(HTTPException):
        asyncio.run(agents.connect_agent('codex', use_existing_login=True, actor='admin'))
    assert agents._selection() is None


def test_legacy_helpers_and_no_automatic_account_selection(local_store, monkeypatch):
    monkeypatch.setenv('SUPERAGENT_CODEX_EXECUTABLE', '["python", "fake.py"]')
    assert agents.resolve_executable() == ['python', 'fake.py']
    assert agents.client_options()['use_existing_login'] is False
    monkeypatch.setenv('SUPERAGENT_CODEX_EXECUTABLE', '[]')
    with pytest.raises(ValueError):
        agents.resolve_executable()


def test_unmigrated_database_retains_legacy_behavior(tmp_path, monkeypatch):
    engine = create_engine('sqlite:///' + str(tmp_path / 'unmigrated.db'))
    monkeypatch.setattr(db, 'Session', sessionmaker(engine))
    monkeypatch.setenv('SUPERAGENT_CODEX_EXECUTABLE', 'legacy-codex')
    try:
        assert agents._selection() is None
        assert agents.resolve_executable() == 'legacy-codex'
        assert not agents.client_options()['use_existing_login']
        assert not agents.uses_subscription_account()
    finally:
        engine.dispose()


def test_selection_pins_account_home_after_environment_changes(local_store, monkeypatch):
    _, _, home = local_store
    asyncio.run(agents.connect_agent('codex', use_existing_login=True, actor='admin'))
    monkeypatch.setenv('CODEX_HOME', str(home.parent / 'other-account'))
    monkeypatch.setenv('SUPERAGENT_CODEX_HOME', str(home.parent / 'service-account'))
    assert agents.resolve_home() == str(home)
    assert agents.client_options()['codex_home'] == str(home)
    seen = []
    async def probe(executable, directory):
        seen.append(directory)
        return {'auth_status': 'authenticated', 'auth_type': 'chatgpt'}
    monkeypatch.setattr(agents, 'probe_account', probe)
    asyncio.run(agents.agent_status())
    assert seen == [home]


def test_missing_selected_binary_requires_explicit_reconnect_to_same_account(local_store, monkeypatch):
    _, selected, home = local_store
    asyncio.run(agents.connect_agent('codex', use_existing_login=True, actor='admin'))
    selected.unlink()
    replacement = home.parent / 'new' / 'codex.exe'
    replacement.parent.mkdir()
    replacement.write_text('offline replacement', encoding='utf-8')
    monkeypatch.setattr(agents, 'discover_executable', lambda agent_id='codex': str(replacement) if agent_id=='codex' else None)
    monkeypatch.setattr(agents, 'existing_home', lambda: home.parent / 'other-account')
    status = asyncio.run(agents.agent_status())
    assert status['active_id'] is None
    assert status['items'][0]['connection_state'] == 'reconnect_required'
    assert not status['items'][0]['selected']
    assert agents._selection()['executable'] == str(selected)
    asyncio.run(agents.connect_agent('codex', use_existing_login=True, actor='admin'))
    assert agents.resolve_executable() == str(replacement)
    assert agents.resolve_home() == str(home)


def test_status_invalidates_stale_subscription_verification(local_store, monkeypatch):
    asyncio.run(agents.connect_agent('codex', use_existing_login=True, actor='admin'))
    assert agents.uses_subscription_account()
    async def switched(*args):
        return {'auth_status': 'authenticated', 'auth_type': 'api_key'}
    monkeypatch.setattr(agents, 'probe_account', switched)
    asyncio.run(agents.agent_status())
    assert not agents.uses_subscription_account()


def test_api_is_admin_only_and_rejects_paths(local_store, monkeypatch):
    monkeypatch.setenv('SUPERAGENT_USERS_JSON', json.dumps([
        {'user_id': 'root', 'role': 'admin', 'token': 'offline-root'},
        {'user_id': 'member', 'role': 'member', 'token': 'offline-member'}]))
    monkeypatch.delenv('SUPERAGENT_API_TOKEN', raising=False)
    app = FastAPI()
    app.include_router(api.router)
    with TestClient(app) as client:
        url = '/api/v1/agents/local'
        assert client.get(url).status_code == 401
        assert client.get(url, headers={'Authorization': 'Bearer offline-member'}).status_code == 403
        headers = {'Authorization': 'Bearer offline-root'}
        assert client.get(url, headers=headers).status_code == 200
        assert client.post(url + '/connect', headers=headers, json={
            'agent_id': 'codex', 'use_existing_login': True, 'executable': 'untrusted.exe'}).status_code == 422
        assert client.post(url + '/connect', headers=headers, json={
            'agent_id': 'codex', 'use_existing_login': True}).json()['active_id'] == 'codex'


def test_explicit_existing_home_keeps_config_and_filters_environment(tmp_path, monkeypatch):
    home = tmp_path / 'existing'
    home.mkdir()
    config = home / 'config.toml'
    config.write_text('[mcp_servers.private]\ncommand="never-run"\n', encoding='utf-8')
    monkeypatch.setenv('CODEX_HOME', str(home))
    monkeypatch.setenv('OPENAI_API_KEY', 'offline-sensitive-key')
    fake = Path(__file__).with_name('env_server.py').resolve()
    async def run():
        client = CodexAppServer([sys.executable, str(fake)], str(tmp_path), use_existing_login=True)
        try:
            await client.start()
            result = await client._request('env/check', {})
            assert result['codex_home'] == str(home)
            assert not result['api_key_present']
            assert 'mcp_servers={}' in result['argv']
            assert not result['api_token_present']
        finally:
            await client.close()
    asyncio.run(run())
    assert config.read_text(encoding='utf-8') == '[mcp_servers.private]\ncommand="never-run"\n'
    with pytest.raises(ValueError, match='separate'):
        CodexAppServer([sys.executable, str(fake)], str(tmp_path), codex_home=str(home))


def test_thread_read_filters_hidden_reasoning_and_tool_less_protocol(tmp_path):
    client = CodexAppServer([sys.executable], str(tmp_path), codex_home=str(tmp_path / 'service'))
    seen = []
    async def request(method, params):
        seen.append((method, params))
        return {'thread': {'id': 'owned', 'path': 'private-rollout', 'baseInstructions': 'private', 'turns': [
            {'id': 'turn', 'status': 'completed', 'items': [
                {'id': 'r', 'type': 'reasoning', 'summary': ['hidden'], 'content': ['hidden']},
                {'id': 'u', 'type': 'userMessage', 'content': [{'type': 'text', 'text': 'hello'}]},
                {'id': 'a', 'type': 'agentMessage', 'text': 'visible', 'private': 'hidden'},
                {'id': 't', 'type': 'commandExecution', 'command': 'echo ok', 'aggregatedOutput': 'ok'},
                {'id': 'x', 'type': 'futureInternal', 'text': 'hidden'},
            ]}]}}
    client._request = request
    result = asyncio.run(client.read_thread('owned', include_turns=True))
    assert seen[-1] == ('thread/read', {'threadId': 'owned', 'includeTurns': True})
    assert 'hidden' not in json.dumps(result)
    assert 'private-rollout' not in json.dumps(result)
    assert [item['type'] for item in result['thread']['turns'][0]['items']] == ['userMessage', 'agentMessage', 'commandExecution']
    asyncio.run(client.start_thread(str(tmp_path), read_only=True, tool_less=True))
    assert seen[-1][1]['sandbox'] == 'read-only'
    assert 'dynamicTools' not in seen[-1][1]
    assert 'owned' not in client.readonly_threads
    asyncio.run(client.resume_thread('owned', read_only=True, tool_less=True))
    with pytest.raises(ValueError):
        asyncio.run(client.start_thread(str(tmp_path), tool_less=True))
