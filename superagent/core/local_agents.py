"""Server-side discovery and explicit selection of existing local Agent accounts."""
import asyncio
import json
import os
import re
import shutil
import subprocess
from pathlib import Path

from fastapi import HTTPException
from sqlalchemy import String, inspect
from sqlalchemy.orm import Mapped, mapped_column

from superagent.core import db, governance as gov


class LocalAgentSelection(db.Base):
    __tablename__ = 'local_agent_selection'
    id: Mapped[int] = mapped_column(primary_key=True, default=1)
    agent_id: Mapped[str] = mapped_column(String(40))
    executable: Mapped[str] = mapped_column(String(2000))
    home: Mapped[str] = mapped_column(String(2000))
    auth_type: Mapped[str] = mapped_column(String(40))
    verified_at: Mapped[str] = mapped_column(String(40), default=db.now)
    actor_id: Mapped[str] = mapped_column(String(200))


def _selection():
    with db.Session() as session:
        if not inspect(session.connection()).has_table(LocalAgentSelection.__tablename__):
            return None
        row = session.get(LocalAgentSelection, 1)
        return db.dump(row) if row else None


def existing_home():
    configured = os.getenv('CODEX_HOME')
    if configured and not Path(configured).is_absolute():
        raise ValueError('CODEX_HOME 必须为绝对路径')
    return Path(configured or Path.home() / '.codex').resolve()


def discover_executable(agent_id='codex'):
    """Only server-known paths and PATH, never a client-supplied command."""
    candidates = []
    if agent_id == 'codex':
        local = os.getenv('LOCALAPPDATA')
        if local:
            root = Path(local) / 'OpenAI' / 'Codex' / 'bin'
            if root.is_dir():
                folders = sorted((p for p in root.iterdir() if p.is_dir() and not p.name.startswith('.')),
                                 key=lambda p: p.stat().st_mtime, reverse=True)
                candidates.extend(p / 'codex.exe' for p in folders)
        for root in (Path.home() / '.vscode' / 'extensions', Path.home() / '.vscode-insiders' / 'extensions'):
            if root.is_dir():
                candidates.extend(sorted(root.glob('openai.chatgpt-*/bin/*/codex.exe'), reverse=True))
        npm = os.getenv('APPDATA')
        if npm:
            root = Path(npm) / 'npm' / 'node_modules' / '@openai'
            candidates.extend(root.glob('codex*/vendor/*/codex/codex.exe'))
            candidates.extend(root.glob('codex/node_modules/@openai/codex*/vendor/*/codex/codex.exe'))
    found = shutil.which(agent_id + '.exe') or shutil.which(agent_id)
    if found:
        candidates.append(Path(found))
    for candidate in candidates:
        if candidate.is_file() and (os.name != 'nt' or candidate.suffix.lower() == '.exe'):
            return str(candidate.resolve())
    return None


def _version(executable):
    try:
        result = subprocess.run([executable, '--version'], capture_output=True, timeout=10,
                                creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
        match = re.search(rb'\d+\.\d+\.\d+(?:[-+.][A-Za-z0-9.-]+)?', result.stdout[:4096])
        return match.group().decode('ascii') if result.returncode == 0 and match else None
    except (OSError, subprocess.TimeoutExpired):
        return None


async def probe_account(executable, home):
    from superagent.runtime.codex import CodexAppServer
    if not Path(home).is_dir():
        return {'auth_status': 'login_required', 'auth_type': 'unknown'}
    client = CodexAppServer(executable, str(Path.cwd()), {'timeout': 10},
                            use_existing_login=True, codex_home=str(home))
    try:
        await client.start()
        result = await client._request('account/read', {'refreshToken': False})
        account = result.get('account') or {}
        auth_type = account.get('type')
        known = {'chatgpt': 'chatgpt', 'chatgptAuthTokens': 'chatgpt_external',
                 'apiKey': 'api_key', 'amazonBedrock': 'bedrock'}
        return {'auth_status': 'authenticated' if auth_type in known else 'login_required',
                'auth_type': known.get(auth_type, 'unknown')}
    except Exception:
        return {'auth_status': 'unavailable', 'auth_type': 'unknown'}
    finally:
        try:
            await client.close()
        except Exception:
            pass


async def agent_status():
    selection = _selection()
    selected_file = selection and Path(selection['executable']).is_file()
    executable = selection['executable'] if selected_file else await asyncio.to_thread(discover_executable)
    version = await asyncio.to_thread(_version, executable) if executable else None
    home = Path(selection['home']) if selection else existing_home()
    auth = await probe_account(executable, home) if executable and version else {
        'auth_status': 'not_installed' if not executable else 'unavailable', 'auth_type': 'unknown'}
    if selected_file:
        with db.Session.begin() as session:
            current = session.get(LocalAgentSelection, 1)
            if current and current.home == selection['home'] and current.executable == selection['executable']:
                current.auth_type = auth['auth_type'] if auth['auth_status'] == 'authenticated' else 'unknown'
                current.verified_at = db.now()
    connection = ('reconnect_required' if selection and not selected_file
                  else 'connected' if selection and auth['auth_status'] == 'authenticated'
                  else 'unavailable' if selection else 'not_selected')
    items = [{'id': 'codex', 'name': 'Codex', 'installed': bool(executable),
              'executable': executable, 'version': version, **auth,
              'capabilities': ['create', 'continue', 'read', 'interrupt', 'approvals'] if version else [],
              'selected': connection == 'connected', 'connection_state': connection,
              'adapter_available': True}]
    claude = await asyncio.to_thread(discover_executable, 'claude')
    items.append({'id': 'claude', 'name': 'Claude Code', 'installed': bool(claude),
                  'executable': claude, 'version': await asyncio.to_thread(_version, claude) if claude else None,
                  'auth_status': 'unsupported', 'auth_type': 'unknown', 'capabilities': [],
                  'adapter_available': False, 'selected': False})
    return {'items': items, 'active_id': selection['agent_id'] if connection == 'connected' else None}


async def connect_agent(agent_id, *, use_existing_login, actor):
    if agent_id != 'codex':
        raise HTTPException(422, '该 Agent 尚无可用执行适配器')
    if use_existing_login is not True:
        raise HTTPException(422, '连接本机 Agent 需要明确复用已有登录')
    executable = await asyncio.to_thread(discover_executable)
    if not executable or not await asyncio.to_thread(_version, executable):
        raise HTTPException(409, '未发现可运行的本机 Codex')
    previous = _selection()
    home = Path(previous['home']) if previous and previous['agent_id'] == agent_id else existing_home()
    status = await probe_account(executable, home)
    if status['auth_status'] != 'authenticated':
        raise HTTPException(409, '本机 Codex 登录尚未验证，请先在本机 Codex 完成登录')
    with db.Session.begin() as session:
        session.merge(LocalAgentSelection(id=1, agent_id='codex', executable=executable, home=str(home),
            auth_type=status['auth_type'], verified_at=db.now(), actor_id=actor))
        gov._audit(session, actor, 'local_agent.connect', 'codex', {'auth_type': status['auth_type']})
    settings = gov.settings_snapshot()
    estimate = settings.get('budget_reservation_estimate_micros')
    with db.Session() as session:
        budget = session.get(gov.BudgetAccount, 'global')
        funded = (isinstance(estimate, int) and estimate > 0 and budget is not None
                  and budget.hard_limit_micros is not None
                  and budget.hard_limit_micros - budget.spent_micros - budget.reserved_micros >= estimate)
    ready = status['auth_type'] == 'chatgpt' or funded
    if ready:
        gov.update_settings({'scheduler_enabled': True, 'semantic_routing_enabled': True,
                             'router_agent_enabled': True}, actor=actor)
    return {'active_id': 'codex', 'auth_status': status['auth_status'], 'auth_type': status['auth_type'],
            'execution_enabled': ready, 'budget_configuration_required': not ready}


def resolve_executable():
    selected = _selection()
    if selected:
        if not Path(selected['executable']).is_file():
            raise ValueError('已选择的本机 Codex 已不可用，请重新连接')
        return selected['executable']
    value = os.getenv('SUPERAGENT_CODEX_EXECUTABLE', '')
    if value.lstrip().startswith('['):
        value = json.loads(value)
        if not isinstance(value, list) or not value or any(not isinstance(part, str) or not part for part in value):
            raise ValueError('SUPERAGENT_CODEX_EXECUTABLE 必须是非空字符串数组')
    return value or None


def resolve_home():
    selected = _selection()
    if selected:
        return selected['home']
    return str(Path(os.getenv('SUPERAGENT_CODEX_HOME') or Path.cwd() / 'data' / 'codex-state').resolve())


def client_options():
    selected = _selection()
    return {'use_existing_login': bool(selected), 'codex_home': resolve_home()}


def uses_subscription_account():
    selected = _selection()
    return bool(selected and selected['agent_id'] == 'codex' and selected['auth_type'] == 'chatgpt'
                and selected['verified_at'] and Path(selected['executable']).is_file())
