import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import Fastify from 'fastify';
import { describe, expect, test } from 'vitest';
import { ZodError } from 'zod';
import { openStorage, StorageConflict } from '../../../../packages/storage/index.ts';
import { registerAuth } from '../auth.js';
import { registerControls } from '../controls.js';
import { utc } from '../sql.js';
import { registerWorker } from './index.ts';
import { acceptTask } from './acceptance.ts';

const stamp = '2026-11-18T00:00:00.000000+00:00';
const token = 'fixture-only';

async function host(run: (fixture: Awaited<ReturnType<typeof harness>>) => Promise<void>, options: NodeJS.ProcessEnv = {}) {
  const root = await mkdtemp(join(await realpath(tmpdir()), '离线 Worker '));
  try {
    const fixture = await harness(root, options);
    try { await run(fixture); } finally { await fixture.close(); }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function harness(root: string, options: NodeJS.ProcessEnv) {
  const env: NodeJS.ProcessEnv = { SUPERAGENT_API_TOKEN: token, SUPERAGENT_DRIVER: 'fixture', ...options };
  const store = openStorage(join(root, 'fixture.db'), { stateRoot: root });
  const { lease } = store.startController('fixture-controller');
  const { db } = store;
  db.prepare(`INSERT INTO projects(id,name,repo_path,repositories,base_branch,test_command,allowed_paths,dingtalk_chat_ids,
    redmine_project_ids,enabled,archived,created_at) VALUES(1,'离线项目',?,'[]','main','','["."]','[]','[]',1,0,?)`)
    .run(root, stamp);
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, _, reply) => {
    const status = error instanceof StorageConflict ? 409 : error instanceof ZodError ? 422 : (error as { statusCode?: number }).statusCode ?? 500;
    reply.code(status).send({ detail: (error as Error).message });
  });
  registerAuth(app, env);
  const controls = registerWorker(app, store, lease, root, env);
  registerControls(app, db, controls);
  await app.ready();
  return {
    db, controls, env, root,
    insert(id: number, kind: 'reply' | 'repair' | 'analysis') {
      db.prepare(`INSERT INTO tasks(id,title,kind,owner_id,outcome_unknown,goal,project_id,status,revision,state_version,
        control_version,source,acceptance_criteria,created_at,updated_at) VALUES(?,'离线任务',?,'admin',0,'合成目标',1,'queued',1,1,1,'web','',?,?)`)
        .run(id, kind, stamp, stamp);
    },
    scheduler(enabled: boolean) {
      db.prepare(`INSERT INTO governance_settings(key,value,updated_at) VALUES('scheduler_enabled',?,?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(JSON.stringify(enabled), utc());
    },
    get(id: number) { return db.prepare('SELECT * FROM tasks WHERE id=?').get(id)!; },
    approval(id: number) { return db.prepare('SELECT * FROM approvals WHERE task_id=?').get(id)!; },
    request(method: 'GET' | 'POST', url: string, payload?: object) {
      return app.inject({ method, url: `/api/v1/${url}`, headers: { authorization: `Bearer ${token}`, host: 'localhost' }, payload });
    },
    post(url: string, payload: object) {
      return this.request('POST', url, payload);
    },
    async close() { try { await app.close(); } finally { store.close(); } },
  };
}

async function until(read: () => unknown, expected: string, waitMs = 8_000) {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (read() === expected) return;
    await delay(50);
  }
  expect(read()).toBe(expected);
}

describe('Host uses the real fixture process and storage transactions', () => {
  test('reply respects the scheduling gate and reaches manual acceptance with same-turn evidence', async () => host(async f => {
    f.insert(1, 'reply');
    await delay(450);
    expect(f.get(1).status).toBe('queued');
    f.scheduler(true);
    await until(() => f.get(1).status, 'review_ready');
    const task = f.get(1);
    const artifacts = f.db.prepare('SELECT kind,content,attempt_id FROM artifacts WHERE task_id=1 ORDER BY id').all();
    expect(artifacts.map(row => row.kind)).toEqual(['summary', 'verification']);
    expect(artifacts[0].attempt_id).toBeTruthy();
    expect(artifacts[1].attempt_id).toBe(artifacts[0].attempt_id);
    expect(JSON.parse(String(artifacts[1].content))).toMatchObject({ host_checked: true, evidence_source: 'offline-codex-fixture',
      thread_id: task.codex_thread_id, turn_id: task.codex_turn_id, turn_status: 'completed' });
    expect(f.db.prepare('SELECT id FROM context_manifests').all()).toHaveLength(0);
    expect(() => acceptTask(f.db, task, 1, { accepted: true, revision: 1 }, false)).toThrow('离线验证需在夹具模式下验收');
    expect((await f.post('tasks/1/acceptance', { accepted: true, revision: 2 })).statusCode).toBe(409);
    expect((await f.post('tasks/1/acceptance', { accepted: true, revision: 1 })).statusCode).toBe(200);
    expect(f.get(1).status).toBe('completed');
  }), 15_000);

  test('decision mode binds the persisted manifest to the acknowledged turn', async () => host(async f => {
    f.insert(1, 'reply');
    f.db.prepare(`INSERT INTO decisions(project_id,task_id,kind,content,status,revision,actor,created_at)
      VALUES(1,1,'constraint','合成约束','active',1,'admin',?)`).run(stamp);
    f.scheduler(true);
    await until(() => f.get(1).status, 'review_ready');
    const manifest = f.db.prepare('SELECT * FROM context_manifests WHERE task_id=1').get()!;
    const attempt = f.db.prepare('SELECT * FROM execution_attempts WHERE task_id=1').get()!;
    expect(attempt.manifest_id).toBe(manifest.id);
    expect(manifest).toMatchObject({ attempt_id: attempt.id, thread_id: attempt.thread_id, turn_id: attempt.turn_id, revision: 1 });
    expect(JSON.parse(String(manifest.items))).toMatchObject([{ type: 'decision', included: true }]);
  }, { SUPERAGENT_CONTEXT_MODE: 'decisions' }), 15_000);

  test('fixture is disabled unless selected, even when scheduling is enabled', async () => host(async f => {
    f.insert(1, 'reply');
    f.scheduler(true);
    await delay(500);
    expect(f.get(1).status).toBe('queued');
    expect(f.db.prepare('SELECT id FROM execution_attempts').all()).toHaveLength(0);
    expect(await f.controls.stop(1)).toBe(false);
  }, { SUPERAGENT_DRIVER: undefined }), 15_000);

  test('repair approval precedes a verified Git diff, independent test command and manual acceptance', async () => host(async f => {
    f.insert(1, 'repair');
    f.scheduler(true);
    await until(() => f.get(1).status, 'waiting_approval');
    const approval = f.approval(1);
    const endpoint = `approvals/${approval.id}/decision`;
    expect((await f.post(endpoint, { decision: 'approve', action_hash: 'wrong' })).statusCode).toBe(409);
    expect(f.approval(1).status).toBe('pending');
    const answer = await f.post(endpoint, { decision: 'approve', action_hash: approval.action_hash });
    expect(answer.statusCode).toBe(200);
    expect(answer.json().status).toBe('approved');
    await until(() => f.get(1).status, 'review_ready');
    const task = f.get(1);
    const artifacts = f.db.prepare('SELECT kind,content,attempt_id FROM artifacts WHERE task_id=1 ORDER BY id').all();
    expect(artifacts.map(row => row.kind)).toEqual(['summary', 'verification', 'changes']);
    expect(JSON.parse(String(artifacts[1].content))).toMatchObject({ repair_verified: true, evidence_source: 'offline-codex-fixture',
      thread_id: task.codex_thread_id, turn_id: task.codex_turn_id, test: { source: 'host-command', exit_code: 0 } });
    expect(JSON.parse(String(artifacts[2].content))).toMatchObject({ changed: ['fixture-value.txt'], untracked: [] });
    const changed = join(String(task.workspace_path), 'fixture-value.txt');
    expect(await readFile(changed, 'utf8')).toBe('after\n');
    await writeFile(changed, 'tampered\n');
    expect((await f.post('tasks/1/acceptance', { accepted: true, revision: 1 })).statusCode).toBe(409);
    await writeFile(changed, 'after\n');
    expect((await f.post('tasks/1/acceptance', { accepted: true, revision: 1 })).statusCode).toBe(200);
    expect(f.get(1).status).toBe('completed');
  }), 20_000);

  test('analysis completes only with a restricted Host file read and an unchanged Git baseline', async () => host(async f => {
    f.insert(1, 'analysis');
    f.scheduler(true);
    await until(() => f.get(1).status, 'review_ready');
    const proof = f.db.prepare("SELECT content FROM artifacts WHERE task_id=1 AND kind='verification'").get()!;
    expect(JSON.parse(String(proof.content))).toMatchObject({ analysis_verified: true, evidence_source: 'offline-codex-fixture',
      reads: [{ source: 'host-filesystem-read', path: '合成输入.txt', sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }] });
    const changes = f.db.prepare("SELECT content FROM artifacts WHERE task_id=1 AND kind='changes'").get()!;
    expect(JSON.parse(String(changes.content))).toMatchObject({ diff: '', changed: [], untracked: [] });
    expect((await f.post('tasks/1/acceptance', { accepted: true, revision: 1 })).statusCode).toBe(200);
  }), 20_000);

  test('local agent routes never accept a browser executable or use an account in fixture mode', async () => host(async f => {
    const response = await f.request('GET', 'agents/local');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ active_id: null });
    const request = { agent_id: 'codex', use_existing_login: true };
    expect((await f.post('agents/local/connect', { ...request, executable: 'any.exe' })).statusCode).toBe(422);
    expect((await f.post('agents/local/connect', request)).statusCode).toBe(409);
    expect(f.db.prepare('SELECT id FROM local_agent_selection').all()).toHaveLength(0);
    expect(f.db.prepare('SELECT id FROM governance_budget_reservations').all()).toHaveLength(0);
  }), 15_000);

  test('explicit account selection pins discovery paths used in later diagnosis', async () => host(async f => {
    const syntheticHome = join(f.root, '合成登录');
    await mkdir(syntheticHome);
    f.env.SUPERAGENT_CODEX_EXECUTABLE = await realpath(process.execPath);
    f.env.SUPERAGENT_CODEX_HOME = await realpath(syntheticHome);
    const expectedHome = f.env.SUPERAGENT_CODEX_HOME;
    await writeFile(join(f.root, 'app-server'), `const stream = require('node:readline').createInterface({input:process.stdin});
      stream.on('line', raw => {
        const msg = JSON.parse(raw);
        if (msg.method === 'initialize') console.log(JSON.stringify({id:msg.id,result:{userAgent:'codex-cli/1.2.3'}}));
        if (msg.method === 'account/read' && process.env.CODEX_HOME === ${JSON.stringify(expectedHome)} && msg.params.refreshToken === false)
          console.log(JSON.stringify({id:msg.id,result:{account:{type:'chatgpt',planType:'plus'}}}));
      });`);
    const before = await f.request('GET', 'agents/local');
    expect(before.json().items[0]).toMatchObject({ installed: true, selected: false, connection_state: 'not_selected' });
    const connected = await f.post('agents/local/connect', { agent_id: 'codex', use_existing_login: true });
    expect(connected.statusCode).toBe(200);
    expect(connected.json()).toMatchObject({ active_id: 'codex', auth_type: 'chatgpt', execution_enabled: true });
    const selection = f.db.prepare('SELECT executable,home,auth_type FROM local_agent_selection WHERE id=1').get()!;
    expect(selection).toMatchObject({ executable: f.env.SUPERAGENT_CODEX_EXECUTABLE, home: expectedHome, auth_type: 'chatgpt' });
    f.env.SUPERAGENT_CODEX_EXECUTABLE = join(f.root, 'nonexistent.exe');
    f.env.SUPERAGENT_CODEX_HOME = join(f.root, 'unused');
    const same = await f.request('GET', 'agents/local');
    expect(same.json().items[0]).toMatchObject({ executable: selection.executable, selected: true, version: '1.2.3' });
  }, { SUPERAGENT_DRIVER: 'codex' }), 20_000);

  test('approval acknowledgement lost: pending action freezes until manual current-version reconciliation', async () => host(async f => {
    f.insert(1, 'repair');
    f.scheduler(true);
    await until(() => f.get(1).status, 'waiting_approval');
    const approval = f.approval(1);
    const response = await f.post(`approvals/${approval.id}/decision`, { decision: 'reject', action_hash: approval.action_hash });
    expect(response.statusCode).toBe(503);
    await until(() => f.get(1).status, 'waiting_resource');
    expect(f.approval(1).status).toBe('unknown');
    expect(f.get(1).outcome_unknown).toBe(1);
    const version = Number(f.get(1).state_version);
    const report = { outcome: 'stopped', evidence: '已经观察到离线进程退出', expected_state_version: version };
    expect((await f.post('tasks/1/reconcile', { ...report, expected_state_version: version - 1 })).statusCode).toBe(409);
    expect((await f.post('tasks/1/reconcile', report)).statusCode).toBe(200);
    expect(f.get(1).status).toBe('paused');
    expect(f.get(1).outcome_unknown).toBe(0);
  }, { SUPERAGENT_FIXTURE_EXIT_AT: 'after_approval_response' }), 15_000);

  test('stop confirms the known fixture ended and the control caller owns the state transition', async () => host(async f => {
    f.insert(1, 'repair');
    f.scheduler(true);
    await until(() => f.get(1).status, 'waiting_approval');
    expect(await f.controls.stop(1)).toBe(true);
    expect(f.get(1).status).toBe('waiting_approval');
    expect(await f.controls.stop(1)).toBe(false);
    const approval = f.approval(1);
    expect((await f.post(`approvals/${approval.id}/decision`, { decision: 'reject', action_hash: approval.action_hash })).statusCode).toBe(409);
  }), 15_000);
});

async function seedRepo(directory: string, branch: string, files: Record<string, string>) {
  await mkdir(directory, { recursive: true });
  for (const [name, text] of Object.entries(files)) await writeFile(join(directory, name), text, 'utf8');
  const git = (args: string[], input?: string) => execFileSync('git', ['-C', directory, '-c', 'core.autocrlf=false',
    '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args],
  { windowsHide: true, encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'], env: {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: directory, TMP: directory,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_TERMINAL_PROMPT: '0',
  } }).trim();
  git(['init', '--quiet', '--template=', `--initial-branch=${branch}`]);
  git(['add', '--', '.']);
  const tree = git(['write-tree']);
  const commit = git(['commit-tree', tree], '合成测试基线\n');
  git(['update-ref', `refs/heads/${branch}`, commit]);
  return commit;
}

describe('Phase 2 Worker semantics', () => {
  test('isolates two Git repos and checks repair with a real command and acceptance recheck', async () => host(async f => {
    const source = join(f.root, '源 Git 项目');
    const backend = join(source, '后端');
    const frontend = join(source, '前端');
    const first = await seedRepo(backend, 'server-main', { 'fixture-value.txt': 'before\n', '合成输入.txt': '分析输入\n' });
    const second = await seedRepo(frontend, 'ui-main', { 'frontend.txt': 'stay\n' });
    const repos = [{ path: '后端', base_branch: 'server-main' }, { path: '前端', base_branch: 'ui-main' }];
    f.db.prepare('UPDATE projects SET repo_path=?,repositories=?,test_command=? WHERE id=1').run(source, JSON.stringify(repos),
      JSON.stringify([process.execPath, '-e', 'const fs=require("node:fs"),a=require("node:assert/strict");a.equal(fs.readFileSync("后端/fixture-value.txt","utf8"),"after\\n");a.equal(fs.readFileSync("前端/frontend.txt","utf8"),"stay\\n");']));
    f.insert(1, 'repair');
    f.scheduler(true);
    await until(() => f.get(1).status, 'waiting_approval', 20_000);
    const approval = f.approval(1);
    expect((await f.post(`approvals/${approval.id}/decision`, { decision: 'approve', action_hash: approval.action_hash })).statusCode).toBe(200);
    await until(() => f.get(1).status, 'review_ready', 20_000);
    const task = f.get(1);
    const attempt = f.db.prepare('SELECT base_sha FROM execution_attempts WHERE task_id=1').get()!;
    expect(JSON.parse(String(attempt.base_sha))).toEqual({ 后端: first, 前端: second });
    expect(await readFile(join(backend, 'fixture-value.txt'), 'utf8')).toBe('before\n');
    expect(await readFile(join(String(task.workspace_path), '后端', 'fixture-value.txt'), 'utf8')).toBe('after\n');
    const proof = JSON.parse(String(f.db.prepare("SELECT content FROM artifacts WHERE task_id=1 AND kind='verification'").get()?.content));
    expect(proof).toMatchObject({ workspace_kind: 'project', evidence_source: 'offline-codex-fixture', repair_verified: true,
      test: { exit_code: 0, command_sha256: expect.stringMatching(/^[a-f0-9]{64}$/) } });
    await writeFile(join(String(task.workspace_path), '前端', 'frontend.txt'), 'tampered\n');
    expect((await f.post('tasks/1/acceptance', { accepted: true, revision: 1 })).statusCode).toBe(409);
    await writeFile(join(String(task.workspace_path), '前端', 'frontend.txt'), 'stay\n');
    expect((await f.post('tasks/1/acceptance', { accepted: true, revision: 1 })).statusCode).toBe(200);
  }), 55_000);

  test('analysis reads the committed baseline of a dirty source repo; repair refuses that source', async () => host(async f => {
    const source = join(f.root, 'dirty source');
    await seedRepo(source, 'main', { '合成输入.txt': 'committed\n', 'fixture-value.txt': 'before\n' });
    await writeFile(join(source, '合成输入.txt'), 'uncommitted\n');
    f.db.prepare('UPDATE projects SET repo_path=? WHERE id=1').run(source);
    f.insert(1, 'analysis');
    f.insert(2, 'repair');
    f.scheduler(true);
    await until(() => f.get(1).status, 'review_ready');
    await until(() => f.get(2).status, 'failed');
    expect(await readFile(join(String(f.get(1).workspace_path), '合成输入.txt'), 'utf8')).toBe('committed\n');
    expect(await readFile(join(source, '合成输入.txt'), 'utf8')).toBe('uncommitted\n');
    expect(f.get(2).codex_turn_id).toBeNull();
    expect((await f.post('tasks/1/acceptance', { accepted: true, revision: 1 })).statusCode).toBe(200);
  }), 25_000);

  test('steers a live bound reply and resumes its thread in the same workspace on the next process', async () => host(async f => {
    f.insert(1, 'reply');
    f.scheduler(true);
    await until(() => f.get(1).codex_turn_id ? 'bound' : '', 'bound');
    const initial = f.get(1);
    expect((await f.post('tasks/1/messages', { content: '第一次补充' })).statusCode).toBe(200);
    await until(() => f.get(1).status, 'review_ready');
    expect((await f.post('tasks/1/acceptance', { accepted: false, revision: 1 })).statusCode).toBe(200);
    expect((await f.post('tasks/1/controls', { action: 'resume' })).statusCode).toBe(200);
    await until(() => f.get(1).codex_turn_id && f.get(1).codex_turn_id !== initial.codex_turn_id ? 'bound' : '', 'bound');
    expect(f.get(1)).toMatchObject({ codex_thread_id: initial.codex_thread_id, workspace_path: initial.workspace_path });
    expect((await f.post('tasks/1/messages', { content: '第二次补充' })).statusCode).toBe(200);
    await until(() => f.get(1).status, 'review_ready');
    const event = f.db.prepare("SELECT data FROM events WHERE task_id=1 AND event_type='worker_thread_bound' ORDER BY id DESC LIMIT 1").get();
    expect(JSON.parse(String(event?.data))).toMatchObject({ resumed: true, thread_id: initial.codex_thread_id });
  }, { SUPERAGENT_FIXTURE_HOLD_REPLY: '1' }), 20_000);

  test('waiting approval releases a slot and approval rechecks capacity before dispatch', async () => host(async f => {
    f.insert(1, 'repair');
    f.insert(2, 'reply');
    f.scheduler(true);
    await until(() => f.get(1).status, 'waiting_approval');
    await until(() => f.get(2).codex_turn_id ? 'bound' : '', 'bound');
    const approval = f.approval(1);
    const endpoint = `approvals/${approval.id}/decision`;
    expect((await f.post(endpoint, { decision: 'approve', action_hash: approval.action_hash })).statusCode).toBe(409);
    expect(f.approval(1).status).toBe('pending');
    await f.post('tasks/2/messages', { content: '释放运行槽' });
    await until(() => f.get(2).status, 'review_ready');
    const response = await f.post(endpoint, { decision: 'approve', action_hash: approval.action_hash });
    expect(response.statusCode).toBe(200);
    await until(() => f.get(1).status, 'review_ready');
  }, { SUPERAGENT_FIXTURE_HOLD_REPLY: '1' }), 20_000);

  test('absolute deadline expires a bound turn while waiting for a protocol event', async () => host(async f => {
    f.insert(1, 'reply');
    f.scheduler(true);
    await until(() => f.get(1).codex_turn_id ? 'bound' : '', 'bound');
    await until(() => f.get(1).status, 'waiting_resource');
    expect(f.get(1).outcome_unknown).toBe(1);
    expect(f.get(1).last_error).toContain('绝对期限');
    expect(f.db.prepare('SELECT id FROM artifacts WHERE task_id=1').all()).toHaveLength(0);
  }, { SUPERAGENT_FIXTURE_HOLD_REPLY: '1', SUPERAGENT_WORKER_MAX_RUN_MS: '4000' }), 15_000);

  test('waiting approval still expires at the attempt deadline', async () => host(async f => {
    f.insert(1, 'repair');
    f.scheduler(true);
    await until(() => f.get(1).status, 'waiting_approval');
    const approval = f.approval(1);
    await until(() => f.get(1).status, 'waiting_resource');
    expect(f.approval(1).status).toBe('expired');
    expect(f.get(1)).toMatchObject({ outcome_unknown: 1, last_error: expect.stringContaining('绝对期限') });
    expect((await f.post(`approvals/${approval.id}/decision`, { decision: 'approve', action_hash: approval.action_hash })).statusCode).toBe(409);
  }, { SUPERAGENT_WORKER_MAX_RUN_MS: '6500' }), 20_000);

  test('an edited project configuration fences the active run and forbids completion', async () => host(async f => {
    f.insert(1, 'reply');
    f.scheduler(true);
    await until(() => f.get(1).codex_turn_id ? 'bound' : '', 'bound');
    f.db.prepare("UPDATE projects SET allowed_paths='[]' WHERE id=1").run();
    await until(() => f.get(1).status, 'waiting_resource');
    expect(f.get(1).outcome_unknown).toBe(1);
    expect(f.db.prepare('SELECT id FROM artifacts WHERE task_id=1').all()).toHaveLength(0);
  }, { SUPERAGENT_FIXTURE_HOLD_REPLY: '1' }), 15_000);

  test.each(['history', 'environment', 'shared'])('blocks %s project configuration before claiming locally', async mode => host(async f => {
    if (mode === 'history') f.db.prepare("INSERT INTO project_execution_nodes(project_id,node_id) VALUES(1,'previous')").run();
    if (mode === 'shared') f.db.prepare("UPDATE projects SET reference_access='directories' WHERE id=1").run();
    f.insert(1, 'analysis');
    f.scheduler(true);
    await until(() => f.get(1).status, 'waiting_resource');
    expect(f.get(1).outcome_unknown).toBe(0);
    expect(f.get(1).last_error).toContain('现场切换需单控制器');
    expect(f.db.prepare('SELECT id FROM execution_attempts WHERE task_id=1').all()).toHaveLength(0);
  }, mode === 'environment' ? { SUPERAGENT_PROJECT_EXECUTION_NODES: '{"1":"configured"}' } : {}), 15_000);
});
