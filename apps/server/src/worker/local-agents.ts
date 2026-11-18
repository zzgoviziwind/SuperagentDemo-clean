import { glob, readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, extname, isAbsolute, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { FakeCodex } from '../../../../packages/runtime/index.ts';
import { fail } from '../auth.js';
import { settings } from '../settings.js';
import { admin, audit, tx, utc } from '../sql.js';

type Selection = { executable: string; home: string; auth_type: string; verified_at: string };

export function pinnedSelection(db: DatabaseSync): Selection | undefined {
  return db.prepare("SELECT executable,home,auth_type,verified_at FROM local_agent_selection WHERE id=1 AND agent_id='codex'")
    .get() as Selection | undefined;
}

function desktopHome(env: NodeJS.ProcessEnv) {
  return env.USERPROFILE || env.HOME || homedir();
}

async function validExecutable(value: string) {
  if (!isAbsolute(value)) return;
  try {
    const canonical = await realpath(value);
    if ((process.platform !== 'win32' || extname(canonical).toLowerCase() === '.exe') && (await stat(canonical)).isFile()) return canonical;
  } catch { /* Missing candidates are not executable. */ }
}

async function discover(env: NodeJS.ProcessEnv, agent: 'codex' | 'claude') {
  if (agent === 'codex' && env.SUPERAGENT_CODEX_EXECUTABLE) return validExecutable(env.SUPERAGENT_CODEX_EXECUTABLE);
  const binary = agent + (process.platform === 'win32' ? '.exe' : '');
  const candidates: string[] = [];
  if (agent === 'codex' && process.platform === 'win32') {
    if (env.LOCALAPPDATA && isAbsolute(env.LOCALAPPDATA)) {
      const root = join(env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin');
      const folders = await readdir(root, { withFileTypes: true }).catch(() => []);
      const versions = await Promise.all(folders.filter(x => x.isDirectory() && !x.name.startsWith('.')).map(async x => {
        const path = join(root, x.name);
        return { path, mtime: (await stat(path).catch(() => undefined))?.mtimeMs ?? 0 };
      }));
      candidates.push(...versions.sort((a, b) => b.mtime - a.mtime).map(x => join(x.path, binary)));
    }
    const profile = desktopHome(env);
    const roots: [string, string[]][] = isAbsolute(profile) ? ['.vscode', '.vscode-insiders']
      .map(app => [join(profile, app, 'extensions'), ['openai.chatgpt-*/bin/*/codex.exe']]) : [];
    if (env.APPDATA && isAbsolute(env.APPDATA)) roots.push([join(env.APPDATA, 'npm', 'node_modules', '@openai'),
      ['codex*/vendor/*/codex/codex.exe', 'codex/node_modules/@openai/codex*/vendor/*/codex/codex.exe']]);
    for (const [root, patterns] of roots) {
      const paths: string[] = [];
      try { for await (const path of glob(patterns, { cwd: root })) paths.push(join(root, path)); } catch { /* Unavailable directory. */ }
      candidates.push(...paths.sort().reverse());
    }
  }
  candidates.push(...(env.PATH ?? env.Path ?? '').split(delimiter).filter(isAbsolute).map(path => join(path, binary)));
  for (const path of candidates) {
    const found = await validExecutable(path);
    if (found) return found;
  }
}

function readyToDispatch(db: DatabaseSync, billing: 'subscription' | 'metered') {
  if (billing === 'subscription') return true;
  const estimate = settings(db).budget_reservation_estimate_micros;
  return typeof estimate === 'number' && Number.isSafeInteger(estimate) && estimate > 0 && !!db.prepare(`SELECT id
    FROM governance_budget_accounts WHERE id='global' AND (hard_limit_micros IS NULL OR spent_micros+reserved_micros+?<=hard_limit_micros)`)
    .get(estimate);
}

async function diagnose(executable: string, home: string, cwd: string) {
  try {
    const client = await FakeCodex.startLocal({ executable, accountDirectory: home, cwd, useExistingLogin: true });
    const result = client.accountInfo();
    return await client.close() ? result : undefined;
  } catch { return undefined; }
}

export function registerLocalAgents(app: FastifyInstance, db: DatabaseSync, root: string, env: NodeJS.ProcessEnv) {
  const fixture = env.SUPERAGENT_DRIVER === 'fixture';
  app.get('/api/v1/agents/local', async request => {
    admin(request.principal);
    const selection = pinnedSelection(db);
    const executable = fixture ? undefined : selection?.executable ?? await discover(env, 'codex');
    const pinned = selection && executable ? await validExecutable(executable) === executable : false;
    const replacement = !fixture && selection && !pinned ? await discover(env, 'codex') : undefined;
    const result = pinned && selection && executable ? await diagnose(executable, selection.home, root) : undefined;
    if (selection && pinned) {
      db.prepare(`UPDATE local_agent_selection SET auth_type=?,verified_at=? WHERE id=1 AND executable=? AND home=? AND verified_at=?`)
        .run(result?.authType ?? 'unknown', utc(), selection.executable, selection.home, selection.verified_at);
    }
    const connection = result ? 'connected' : selection ? (pinned ? 'unavailable' : 'reconnect_required') : 'not_selected';
    const claude = fixture ? undefined : await discover(env, 'claude');
    return { active_id: result ? 'codex' : null, items: [
      { id: 'codex', name: 'Codex', executable: executable ?? null, installed: !!(pinned || replacement || (!selection && executable)),
        version: result?.version ?? null, auth_status: result ? 'authenticated' : executable ? 'unavailable' : 'not_installed',
        auth_type: result?.authType ?? 'unknown', capabilities: result ? ['create'] : [], selected: !!result,
        connection_state: connection, adapter_available: true },
      { id: 'claude', name: 'Claude Code', executable: claude ?? null, installed: !!claude, version: null,
        auth_status: 'unsupported', auth_type: 'unknown', capabilities: [], selected: false, adapter_available: false },
    ] };
  });

  app.post('/api/v1/agents/local/connect', async request => {
    admin(request.principal);
    z.strictObject({ agent_id: z.literal('codex'), use_existing_login: z.literal(true) }).parse(request.body);
    if (fixture) fail(409, '离线夹具模式不使用本机登录');
    const before = pinnedSelection(db);
    const executable = (before && await validExecutable(before.executable) === before.executable ? before.executable : undefined)
      ?? await discover(env, 'codex');
    if (!executable) fail(409, '未发现可运行的本机 Codex');
    const configured = before?.home ?? (env.SUPERAGENT_CODEX_HOME || env.CODEX_HOME || join(desktopHome(env), '.codex'));
    if (!isAbsolute(configured)) fail(409, '服务端 Codex 登录目录须为绝对路径');
    const home = await realpath(configured).catch(() => fail(409, '本机 Codex 登录目录尚不可用'));
    if (before && home !== before.home) fail(409, '已选择的本机登录目录发生变化');
    const result = await diagnose(executable, home, root);
    if (!result) fail(409, '本机 Codex 登录未验证或进程退出未确认');
    return tx(db, () => {
      const current = pinnedSelection(db);
      if (current?.executable !== before?.executable || current?.home !== before?.home) fail(409, '本机 Agent 选择已变化，请刷新');
      const ready = readyToDispatch(db, result.billing);
      db.prepare(`INSERT INTO local_agent_selection(id,agent_id,executable,home,auth_type,verified_at,actor_id)
        VALUES(1,'codex',?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET agent_id='codex',executable=excluded.executable,
        home=excluded.home,auth_type=excluded.auth_type,verified_at=excluded.verified_at,actor_id=excluded.actor_id`)
        .run(executable, home, result.authType, utc(), request.principal.user_id);
      if (ready) db.prepare(`INSERT INTO governance_settings(key,value,updated_at) VALUES('scheduler_enabled','true',?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).run(utc());
      audit(db, request.principal.user_id, 'local_agent.connect', 'codex', { auth_type: result.authType });
      return { active_id: 'codex', auth_status: 'authenticated', auth_type: result.authType,
        execution_enabled: ready, budget_configuration_required: !ready };
    });
  });
}
