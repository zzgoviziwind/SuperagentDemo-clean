import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { once } from 'node:events';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnOwned } from '@superagent/windows-job';
import { FakeCodex, type CodexEvent } from '../../../../packages/runtime/index.ts';
import { offlineEnvironment } from '../../../../packages/runtime/fixtures/environment.ts';
import { openStorage, type Storage } from '../../../../packages/storage/src/index.ts';
import { registerAuth } from '../auth.ts';
import { registerControls } from '../controls.ts';
import { registerIntake } from '../intake.ts';
import { registerChannels, connectorStatuses } from '../deliveries/channels.ts';
import { buildWorkerPrompt, WORKER_PROMPTS } from '../worker/prompts.ts';
import { createWorkbenchScheduler, enqueueSemanticReceipt, registerWorkbench,
  type WorkbenchModelClient, type WorkbenchModelDriver, type WorkbenchModelKind } from './index.ts';
import { fields, now } from './store.ts';
import { readCodexThread } from './thread-reader.ts';
import type { WorkbenchSchedulerOptions } from './scheduler.ts';

const base = realpathSync(tmpdir());
const prefix = '/api/v1';
const identities = [
  { user_id: 'admin', role: 'admin', token: 'offline-admin' },
  { user_id: 'alice', role: 'member', token: 'offline-alice' },
  { user_id: 'bob', role: 'member', token: 'offline-bob' },
  { user_id: 'viewer', role: 'viewer', token: 'offline-viewer' },
];
const env = { SUPERAGENT_USERS_JSON: JSON.stringify(identities) };

async function imageProtocolFixture(cwd: string, thread: string, prompt: string, paths: readonly string[]) {
  const script = [
    "import { readFileSync, realpathSync } from 'node:fs';",
    "import { dirname } from 'node:path';",
    "let body = ''; for await (const part of process.stdin) body += part;",
    "const { method, params } = JSON.parse(body);",
    "const [text, ...images] = params.input;",
    "const png = '89504e470d0a1a0a';",
    "if (method !== 'turn/start' || text.type !== 'text' || !images.length || !images.every(({type,path}) =>",
    "  type === 'localImage' && dirname(realpathSync(path)) === process.cwd() && readFileSync(path).subarray(0,8).toString('hex') === png)) process.exit(7);",
    "const binding = {threadId: params.threadId, turnId: 'offline-image-turn'};",
    "const frames = [{method:'item/completed', params:{...binding, item:{type:'agentMessage', id:'offline-image-result',text:'离线样例结果', simulated:true}}},",
    "  {method:'turn/completed', params:{...binding, turn:{id:binding.turnId, status:'completed'}}}];",
    "process.stdout.write(JSON.stringify({ binding, frames }));",
  ].join('\n');
  const owned = await spawnOwned(process.execPath, ['--input-type=module', '-e', script], { cwd, env: offlineEnvironment(cwd) });
  const child = owned.child;
  let output = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
  const closed = once(child, 'close');
  child.stdin.end(JSON.stringify({ method: 'turn/start', params: { threadId: thread,
    input: [{ type: 'text', text: prompt }, ...paths.map(path => ({ type: 'localImage', path }))] } }));
  const timer = setTimeout(owned.terminate, 5_000);
  try {
    const [code] = await closed;
    if (code !== 0) throw new Error('离线图片协议未确认');
    const reply = JSON.parse(output);
    if (reply.binding.threadId !== thread || typeof reply.binding.turnId !== 'string' || reply.frames.length !== 2)
      throw new Error('离线图片轮次归属无效');
    return { binding: reply.binding as { threadId: string; turnId: string }, frames: reply.frames as CodexEvent[] };
  } finally { clearTimeout(timer); }
}

function fixture(text: (kind: WorkbenchModelKind) => unknown, meter = false,
  exitAt?: 'before_turn_response') {
  const submitted: { thread: string; kind: WorkbenchModelKind; prompt: string; turn?: string }[] = [];
  const observed: { thread: unknown; turn: unknown; text: unknown }[] = [];
  const imageInputs: { path: string; bytes: Buffer }[] = [];
  const startupErrors: string[] = [];
  const driver: WorkbenchModelDriver = { source: 'offline-codex-fixture', available: () => true, imagesAvailable: () => true,
    async open(cwd, kind, signal) {
      const client = await FakeCodex.start({ cwd, scenario: 'reply', persistThreads: true, exitAt, signal }).catch(error => {
        startupErrors.push(String(error));
        throw error;
      });
      let imageFrames: CodexEvent[] | undefined;
      const startImages = (client as WorkbenchModelClient).startTurnWithImages?.bind(client);
      return { billing: meter ? 'metered' : 'fixture', startThread: mode => client.startThread(mode),
        resumeThread: thread => client.resumeThread(thread), async startTurn(thread, prompt, profile) {
          const evidence: (typeof submitted)[number] = { thread, prompt, kind };
          submitted.push(evidence);
          const binding = await client.startTurn(thread, prompt, profile);
          evidence.turn = binding.turnId;
          return binding;
        }, async startTurnWithImages(thread, prompt, profile, paths) {
          for (const path of paths) imageInputs.push({ path, bytes: readFileSync(path) });
          const evidence: (typeof submitted)[number] = { thread, prompt, kind };
          submitted.push(evidence);
          const result = startImages ? { binding: await startImages(thread, prompt, profile, paths), frames: undefined }
            : await imageProtocolFixture(cwd, thread, prompt, paths);
          const { binding, frames } = result;
          imageFrames = frames;
          evidence.turn = binding.turnId;
          return binding;
        }, close: () => client.close(), async *events() {
          for await (const packet of imageFrames ?? client.events()) {
            const item = fields(packet.params.item);
            if (packet.method === 'item/completed' && item.type === 'agentMessage') {
              if (item.simulated !== true || item.text !== '离线样例结果') throw new Error('预期独立假协议的本轮响应');
              observed.push({ thread: packet.params.threadId, turn: packet.params.turnId, text: item.text });
              if (kind !== 'router') {
                yield { ...packet, params: { ...packet.params, item: { ...item, text: JSON.stringify(text(kind)) } } };
                continue;
              }
            }
            yield packet;
          }
        } };
    },
  };
  return { driver, observed, submitted, startupErrors, imageInputs };
}

describe('冻结 SQLite 工作台调度', () => {
  let root: string;
  let app: FastifyInstance | undefined;
  let storage: Storage | undefined;
  const db = () => storage!.db;
  function setting(key: string, value: unknown) {
    db().prepare(`INSERT INTO governance_settings(key,value,updated_at) VALUES(?,?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).run(key, JSON.stringify(value), now());
  }
  function sample() {
    root = mkdtempSync(join(base, '工作台 副本-'));
    const source = process.env.WORKBENCH_FROZEN_DB;
    if (source) copyFileSync(source, join(root, 'sample.db'));
  }
  async function boot(driver: WorkbenchModelDriver, pollMs = 0, stopWorker?: (taskId: number) => Promise<boolean>,
    ports?: WorkbenchSchedulerOptions['ports']) {
    storage = openStorage(join(root, 'sample.db'), { stateRoot: root });
    const { lease } = storage.startController('workbench-' + Math.random());
    app = Fastify();
    app.setErrorHandler((error, _request, reply) => reply.code(Number(fields(error).statusCode ?? 500))
      .send({ detail: error instanceof Error ? error.message : '服务失败' }));
    app.addHook('onClose', async () => storage?.close());
    registerAuth(app, env);
    registerIntake(app, db(), env);
    registerControls(app, db());
    registerChannels(app, storage, lease, root, ports ? { ...env, SUPERAGENT_DRIVER: 'fixture' } : env);
    const runtime = createWorkbenchScheduler(db(), { lease, stateRoot: root, driver, env, pollMs, stopWorker, ports });
    registerWorkbench(app, db(), runtime);
    await app.ready();
    return runtime;
  }
  function post(path: string, payload: object, user = 'admin') {
    return app!.inject({ method: 'POST', url: prefix + path, headers: { authorization: 'Bearer offline-' + user }, payload });
  }
  function get(path: string, user = 'admin') {
    return app!.inject({ url: prefix + path, headers: { authorization: 'Bearer offline-' + user } });
  }
  function seed() {
    const projectId = 91301;
    db().prepare(`INSERT INTO projects(id,name,repo_path,repositories,reference_dirs,base_branch,test_command,allowed_paths,
      redmine_project_ids,dingtalk_chat_ids,enabled,archived,created_at)
      VALUES (?,'调度项目',?,'[]','[]','main','','[]','["91301"]','[]',1,0,?)`).run(projectId, root, now());
    db().prepare("INSERT INTO governance_identities(id,source,actor_id,user_id,enabled) VALUES(91301,'redmine','mapped-alice','alice',1)").run();
    db().prepare('INSERT INTO governance_identity_grants(identity_id,project_ids,permissions) VALUES(?,?,?)')
      .run(91301, JSON.stringify([projectId]), JSON.stringify(['request']));
    return projectId;
  }
  function incoming(external_id: string, actor_id = 'mapped-alice') {
    return { source: 'redmine', external_id, event_type: 'issue.comment', actor_id,
      project_external_id: '91301', content: '请核对任务进度', occurred_at: now(), metadata: {} };
  }
  async function close() {
    if (app) await app.close();
    else storage?.close();
    app = undefined;
    storage = undefined;
  }
  afterEach(async () => {
    await close();
    if (root) {
      expect(dirname(realpathSync(root))).toBe(base);
      rmSync(root, { recursive: true });
    }
  });

  it('从冻结库副本发起语义分派、Router 与 Watchdog，本轮证据和权限重启后仍可读', async () => {
    sample();
    let target = 0;
    const wire = fixture(kind => kind === 'semantic'
      ? { action: 'dispatch', kind: 'analysis', task_id: target, state_version: 1, reason: '属于原任务' }
      : { action: 'pause', reason: '验证需要人工暂停' }, true);
    const runtime = await boot(wire.driver);
    const projectId = seed();
    db().exec(`INSERT INTO governance_budget_accounts(id,hard_limit_micros,currency,spent_micros,reserved_micros)
      VALUES('global',1000,'USD',0,0) ON CONFLICT(id) DO UPDATE SET hard_limit_micros=1000`);
    setting('budget_reservation_estimate_micros', 50);
    setting('semantic_routing_enabled', false);
    setting('router_agent_enabled', false);
    setting('watchdog_enabled', false);
    const bridge = '/conversation-providers/bridge/operations';
    const create = { request_key: 'fixture.create', action: 'create', project_id: projectId, title: '合成任务', content: '只读调查' };
    const created = await post(bridge, create, 'alice');
    expect(created.statusCode, created.body).toBe(200);
    target = created.json().result.id;
    expect((await get(bridge + '/fixture.create', 'alice')).json().payload_hash)
      .toBe('3d50ba2e4e0b633e854229d17ddfbbafcc137564384f6f69445ef78d776504d6');
    expect((await post(bridge, create, 'alice')).json()).toMatchObject({ session_id: `worker:${target}`, duplicate: true });
    expect((await post(`/operations/watchdog/tasks/${target}/run`, {})).statusCode).toBe(409);
    expect(await runtime.tick()).toBe(false);
    expect(wire.submitted).toHaveLength(0);
    setting('semantic_routing_enabled', true);
    setting('router_agent_enabled', true);
    setting('watchdog_enabled', true);
    const delivery = await post('/events', incoming('workbench-approved'));
    expect(delivery.statusCode, delivery.body).toBe(200);
    const id = delivery.json().id;
    db().exec('BEGIN IMMEDIATE');
    const entered = enqueueSemanticReceipt(db(), id, env);
    db().exec('COMMIT');
    // A host that wired intake directly already enqueued it before this assertion.
    expect(entered || delivery.json().data.routing_status === 'semantic_pending').toBe(true);
    expect(enqueueSemanticReceipt(db(), id, env)).toBe(false);
    await post('/events', incoming('unmapped', 'unknown-actor'));
    const router = `/sessions/router%3A${projectId}/messages`;
    const routerMessage = { request_key: 'fixture.router', action: 'message', session_id: `router:${projectId}`,
      content: '当前进展？', expected_state_version: 1 };
    expect((await post(bridge, routerMessage)).statusCode).toBe(200);
    expect((await post(bridge, routerMessage)).json().duplicate).toBe(true);
    expect(await runtime.tick()).toBe(true);
    expect(wire.observed, JSON.stringify({ startup: wire.startupErrors,
      runs: db().prepare('SELECT phase,status,last_error FROM workbench_model_runs').all() })).toHaveLength(1);
    expect(db().prepare('SELECT status,thread_id,turn_id FROM semantic_routing_jobs WHERE event_id=?').get(id))
      .toMatchObject({ status: 'applied', thread_id: wire.observed[0].thread, turn_id: wire.observed[0].turn });
    expect(db().prepare('SELECT task_id FROM event_targets WHERE event_id=?').all(id)).toMatchObject([{ task_id: target }]);
    expect(db().prepare("SELECT status FROM tasks WHERE id=?").get(target)?.status).toBe('waiting_input');
    expect(await runtime.tick()).toBe(true);
    const first = (await get(`/sessions/router%3A${projectId}`)).json();
    expect(first.messages.at(-1)).toMatchObject({ role: 'assistant', content: '离线样例结果' });
    expect((await post(router, { content: '继续说明', expected_state_version: first.session.state_version })).statusCode).toBe(200);
    expect(await runtime.tick()).toBe(true);
    expect(wire.observed[1].thread).toBe(wire.observed[2].thread);
    expect(wire.observed[1].turn).not.toBe(wire.observed[2].turn);
    const watch = await post(`/operations/watchdog/tasks/${target}/run`, {});
    expect(watch.statusCode, watch.body).toBe(200);
    expect((await get(`/operations/watchdog?task_id=${target}`)).json().items[0]).toMatchObject({ id: watch.json().run_id,
      status: 'completed', turn_id: wire.observed[3].turn, conclusion: { action: 'pause', applied: 'needs_human' } });
    expect(db().prepare('SELECT COUNT(*) AS count FROM workbench_model_runs WHERE status=\'completed\' AND turn_id IS NOT NULL').get()?.count).toBe(4);
    expect(db().prepare("SELECT count(*) AS count FROM governance_budget_reservations WHERE request_key LIKE 'workbench:%' AND status='unknown'")
      .get()?.count).toBe(4);
    expect(wire.submitted[0].prompt).toContain('请核对任务进度');
    expect(wire.submitted.map(item => item.turn)).toEqual(wire.observed.map(item => item.turn));
    db().prepare(`INSERT INTO approvals(task_id,revision,control_version,action_hash,action,status,created_at) VALUES (?,2,2,'fixture','{}','pending',?)`)
      .run(target, now());
    expect((await get('/approvals', 'alice')).json()).toMatchObject([{ task_id: target }]);
    expect((await get('/approvals', 'bob')).json()).toEqual([]);
    expect((await get('/approvals', 'viewer')).json()).toEqual([]);
    expect((await get('/codex-prompts', 'alice')).statusCode).toBe(403);
    const prompts = (await get('/codex-prompts')).json();
    expect(prompts.reply[0].text).toBe(WORKER_PROMPTS.reply);
    expect(prompts.analysis[0].text).toContain(buildWorkerPrompt('analysis', { goal: '【任务目标】' }).split('\n')[0]);
    expect(wire.submitted[0].prompt.startsWith(prompts.semantic_routing[0].text)).toBe(true);
    expect((await get('/overview')).json().connectors).toEqual(connectorStatuses(app!));
    await close();
    const restarted = await boot(wire.driver);
    expect(await restarted.tick()).toBe(false);
    expect(wire.submitted).toHaveLength(4);
    expect((await post(bridge, create, 'alice')).json().duplicate).toBe(true);
    expect((await get(`/sessions/router%3A${projectId}`)).json().session.codex_thread_id).toBe(wire.observed[2].thread);
    expect((await get(`/events/${id}/trace`)).json().target_tasks[0].id).toBe(target);
  }, 60_000);

  it('拒绝跨项目和撤销授权，协议失联后重启不再派发，预算不足前不发起 turn/start', async () => {
    sample();
    const failing = fixture(() => ({}), true, 'before_turn_response');
    const runtime = await boot(failing.driver);
    const projectId = seed();
    setting('semantic_routing_enabled', true);
    setting('router_agent_enabled', true);
    setting('watchdog_enabled', false);
    setting('budget_reservation_estimate_micros', 100);
    db().exec(`INSERT INTO governance_budget_accounts(id,hard_limit_micros,currency,spent_micros,reserved_micros)
      VALUES('global',1000,'USD',0,0) ON CONFLICT(id) DO UPDATE SET hard_limit_micros=1000`);
    const lost = (await post('/events', incoming('workbench-unknown'))).json().id;
    expect(await runtime.tick()).toBe(true);
    expect(failing.submitted, JSON.stringify({ startup: failing.startupErrors,
      runs: db().prepare('SELECT phase,status,last_error FROM workbench_model_runs').all() })).toHaveLength(1);
    expect(failing.observed).toHaveLength(0);
    expect(db().prepare('SELECT status,turn_id FROM semantic_routing_jobs WHERE event_id=?').get(lost))
      .toMatchObject({ status: 'unknown', turn_id: null });
    const foreign = (await post('/events', { ...incoming('workbench-cross-project'), project_external_id: 'unbound' })).json().id;
    expect(enqueueSemanticReceipt(db(), foreign, env)).toBe(false);
    expect(db().prepare('SELECT event_id FROM semantic_routing_jobs WHERE event_id=?').get(foreign)).toBeUndefined();
    const next = (await post('/events', incoming('workbench-role-revoked'))).json().id;
    enqueueSemanticReceipt(db(), next, env);
    db().exec('UPDATE governance_identity_grants SET permissions=\'[]\' WHERE identity_id=91301');
    expect(typeof next).toBe('number');
    expect(await runtime.tick()).toBe(false);
    expect(failing.submitted).toHaveLength(1);
    expect(db().prepare('SELECT status FROM semantic_routing_jobs WHERE event_id=?').get(next)?.status).toBe('rejected');
    const bridgePending = `INSERT INTO conversation_bridge_operations(actor_id,request_key,payload_hash,status,created_at,updated_at)
      VALUES ('admin','lost-bridge','hash','pending','2026-11-17T08:00:00+00:00','2026-11-17T08:00:00+00:00')`;
    db().exec(bridgePending);
    await close();
    const success = fixture(() => ({}), true);
    const restarted = await boot(success.driver);
    expect(await restarted.tick()).toBe(false);
    expect(success.submitted).toHaveLength(0);
    expect((await get('/conversation-providers/bridge/operations/lost-bridge')).json().status).toBe('unknown');
    expect((await get(`/sessions/semantic%3A${lost}`)).json().session.outcome_unknown).toBe(true);
    expect(db().prepare("SELECT status FROM governance_budget_reservations WHERE request_key LIKE 'workbench:%'").get()?.status)
      .toBe('unknown');
    db().exec("UPDATE governance_budget_accounts SET hard_limit_micros=reserved_micros+spent_micros WHERE id='global'");
    expect((await post(`/sessions/router%3A${projectId}/messages`, { content: '新问题', expected_state_version: 1 })).statusCode).toBe(200);
    expect(await restarted.tick()).toBe(true);
    expect(success.submitted).toHaveLength(0);
    expect((await get(`/sessions/router%3A${projectId}`)).json().session.last_error).toContain('预算预留');
  }, 60_000);

  it('开启后的后台轮询接收入站消息与巡检，只有确认 Worker 退出才完成暂停', async () => {
    sample();
    const wire = fixture(kind => kind === 'semantic'
      ? { action: 'create', kind: 'analysis', task_id: null, state_version: null, reason: '启动独立分析' }
      : { action: 'pause', reason: '需要暂停并复核' });
    const stopped: number[] = [];
    const runtime = await boot(wire.driver, 50, async taskId => {
      const row = db().prepare('SELECT status,last_error FROM tasks WHERE id=?').get(taskId);
      expect(row).toMatchObject({ status: 'waiting_resource', last_error: '正在停止执行' });
      stopped.push(taskId);
      return true;
    });
    const projectId = seed();
    setting('semantic_routing_enabled', true);
    setting('router_agent_enabled', false);
    setting('watchdog_enabled', false);
    const receipt = await post('/events', incoming('automatic'));
    expect(receipt.statusCode, receipt.body).toBe(200);
    const eventId = receipt.json().id;
    await vi.waitFor(() => expect(db().prepare('SELECT status FROM semantic_routing_jobs WHERE event_id=?').get(eventId)?.status)
      .toBe('applied'), { timeout: 20_000 });
    const taskId = Number(db().prepare('SELECT task_id FROM event_targets WHERE event_id=?').get(eventId)?.task_id);
    expect(db().prepare('SELECT owner_id,project_id,kind FROM tasks WHERE id=?').get(taskId))
      .toMatchObject({ owner_id: 'alice', project_id: projectId, kind: 'analysis' });
    expect((await post('/events', incoming('automatic'))).json()).toMatchObject({ id: eventId, duplicate: true });
    db().prepare("UPDATE tasks SET status='running' WHERE id=?").run(taskId);
    setting('watchdog_enabled', true);
    await vi.waitFor(() => expect(db().prepare('SELECT status FROM tasks WHERE id=?').get(taskId)?.status).toBe('paused'),
      { timeout: 20_000 });
    expect(stopped).toEqual([taskId]);
    expect(db().prepare("SELECT json_extract(conclusion,'$.applied') AS applied FROM watchdog_runs WHERE task_id=?").get(taskId)?.applied)
      .toBe('paused');
    expect(wire.observed).toHaveLength(2);
    expect(await runtime.tick()).toBe(false);
  }, 60_000);

  it('未分配直聊只写授权项目建议，由人工确认，空提及数组和 DWS 类型遵守 intake', async () => {
    sample();
    let receiptId = 0;
    let candidate = 91301;
    const wire = fixture(() => ({ project_status: 'suggested', proposed_project_id: candidate,
      evidence_event_ids: [receiptId], reason: '消息明确使用项目名', missing_context: '' }));
    const runtime = await boot(wire.driver);
    const project = seed();
    db().prepare("INSERT INTO governance_identities(id,source,actor_id,user_id,enabled) VALUES(91302,'dingtalk','private-alice','alice',1)").run();
    db().prepare('INSERT INTO governance_identity_grants(identity_id,project_ids,permissions) VALUES(?,?,?)')
      .run(91302, JSON.stringify([project]), JSON.stringify(['request']));
    setting('semantic_routing_enabled', true);
    setting('watchdog_enabled', false);
    const baseMessage = { source: 'dingtalk', event_type: 'message.received', actor_id: 'private-alice', thread_id: 'fixture-direct',
      project_external_id: 'not-bound', content: '调度项目的报告怎么显示？', occurred_at: now(),
      metadata: { profile: 'fixture', conversation_type: 'direct', dws_event_type: 'user_im_message_receive_o2o_all',
        uncertain_mentions: [] } };
    const received = await post('/events', { ...baseMessage, external_id: 'project-assessment' });
    expect(received.statusCode, received.body).toBe(200);
    receiptId = received.json().id;
    const job = () => db().prepare('SELECT project_id,status FROM semantic_routing_jobs WHERE event_id=?').get(receiptId);
    if (!job()) {
      const scheduled = await post('/routing/schedule', { event_id: receiptId });
      expect(scheduled.json()).toEqual({ checked: 1, routed_event_ids: [] });
    }
    expect(job()).toMatchObject({ project_id: 0, status: 'queued' });
    expect(await runtime.tick()).toBe(true);
    expect(db().prepare('SELECT project_id,status,turn_id FROM semantic_routing_jobs WHERE event_id=?').get(receiptId))
      .toMatchObject({ project_id: 0, status: 'assessed', turn_id: wire.observed[0].turn });
    const index = (await get('/event-groups/index?source=dingtalk')).json();
    expect(index.items.find((row: { event?: { id: number } }) => row.event?.id === receiptId).event)
      .toMatchObject({ project_id: null, project_assessment: { proposed_project_id: project, evidence_event_ids: [receiptId] } });
    expect(db().prepare('SELECT task_id FROM events WHERE id=?').get(receiptId)?.task_id).toBeNull();
    const confirmation = await post('/event-groups/triage', { action: 'create', project_id: project, event_ids: [receiptId],
      title: '人工确认', goal: '只读核对' });
    expect(confirmation.statusCode, confirmation.body).toBe(200);
    expect(confirmation.json().group.project_id).toBe(project);
    candidate = project + 1;
    receiptId = (await post('/events', { ...baseMessage, external_id: 'ungranted-proposal' })).json().id;
    expect(await runtime.tick()).toBe(true);
    expect(db().prepare('SELECT status FROM semantic_routing_jobs WHERE event_id=?').get(receiptId)?.status).toBe('rejected');
    expect(db().prepare("SELECT json_extract(data,'$.project_assessment') AS proposal FROM events WHERE id=?").get(receiptId)?.proposal)
      .toBeNull();
    for (const [external_id, metadata] of [
      ['ambiguous-mentions', { ...baseMessage.metadata, uncertain_mentions: ['other'] }],
      ['not-a-direct-event', { ...baseMessage.metadata, dws_event_type: 'user_im_message_receive_group' }],
    ] as const) {
      const id = (await post('/events', { ...baseMessage, external_id, metadata })).json().id;
      expect(db().prepare('SELECT event_id FROM semantic_routing_jobs WHERE event_id=?').get(id)).toBeUndefined();
    }
    expect(await runtime.tick()).toBe(false);
    expect(wire.observed).toHaveLength(2);
  }, 60_000);

  it('原始 thread/read 仅发送握手和读取帧，旧桥接版本仍可握手和调用', async () => {
    sample();
    await boot(fixture(() => ({})).driver);
    const childScript = [
      "import { createInterface } from 'node:readline';",
      "let ready = false;",
      "for await (const line of createInterface({input: process.stdin})) {",
      "  const p = JSON.parse(line);",
      "  if (p.method === 'initialize') process.stdout.write(JSON.stringify({id:p.id,result:{}}) + '\\n');",
      "  else if (p.method === 'initialized') ready = true;",
      "  else if (p.method === 'thread/read' && ready && p.params.includeTurns === true && p.params.threadId === 'raw-thread') {",
      "    process.stdout.write(JSON.stringify({id:p.id,result:{thread:{id:'raw-thread',turns:[{id:'raw-turn',items:[{type:'agentMessage',text:'原始读取回执'}]}]}}}) + '\\n');",
      "  } else process.exit(6);",
      "}",
    ].join('\n');
    const raw = await readCodexThread(() => spawnOwned(process.execPath, ['--input-type=module', '-e', childScript],
      { cwd: root, env: offlineEnvironment(root) }), 'raw-thread', AbortSignal.timeout(10_000));
    expect(raw).toMatchObject({ thread: { id: 'raw-thread', turns: [{ id: 'raw-turn', items: [{ text: '原始读取回执' }] }] } });
    const oldMcp = (method: string, params: object) => app!.inject({ method: 'POST',
      url: prefix + '/conversation-providers/mcp', headers: { authorization: 'Bearer offline-admin', 'mcp-protocol-version': '2024-11-05' },
      payload: { jsonrpc: '2.0', id: 1, method, params } });
    expect((await oldMcp('initialize', { protocolVersion: '2024-11-05' })).json())
      .toMatchObject({ result: { protocolVersion: '2024-11-05' } });
    expect((await oldMcp('tools/call', { name: 'superagent_status', arguments: {} })).json().result.isError).toBe(false);
    const getMcp = await get('/conversation-providers/mcp');
    expect(getMcp.statusCode).toBe(405);
    expect(getMcp.headers.allow).toBe('POST');
  }, 60_000);

  it('回滚恢复入口冻结未完成记录且不启动调度或模型', async () => {
    sample();
    const wire = fixture(() => ({}));
    storage = openStorage(join(root, 'sample.db'), { stateRoot: root });
    const { lease } = storage.startController('rollback-test');
    const runtime = createWorkbenchScheduler(db(), { lease, stateRoot: root, driver: wire.driver, env });
    runtime.recoverOnly();
    db().prepare(`INSERT INTO workbench_model_runs(id,kind,scope_id,item_id,lease_epoch,phase,status,
      evidence_source,created_at,updated_at) VALUES('rollback-run','watchdog',1,NULL,?,'turn_intent','running','fixture',?,?)`)
      .run(lease.epoch, now(), now());
    const comparison = 'comparison-' + 'b'.repeat(32);
    const dir = join(root, 'workbench-model', comparison);
    mkdirSync(dir, { recursive: true });
    const abandoned = join(dir, 'source-3-12345678-1234-4321-9134-1234567890ab.png');
    const unrelated = join(dir, 'unrelated.png');
    writeFileSync(abandoned, 'abandoned-image');
    writeFileSync(unrelated, 'other file');
    db().prepare(`INSERT INTO workbench_model_runs(id,kind,scope_id,item_id,lease_epoch,phase,status,
      evidence_source,created_at,updated_at) VALUES(?,'assessment',3,NULL,?,'turn_intent','running','fixture',?,?)`)
      .run(comparison, lease.epoch, now(), now());
    db().prepare(`INSERT INTO conversation_bridge_operations(actor_id,request_key,payload_hash,status,created_at,updated_at)
      VALUES('admin','rollback-bridge','fixture','pending',?,?)`).run(now(), now());
    runtime.recoverOnly();
    expect(db().prepare("SELECT status,phase FROM workbench_model_runs WHERE id='rollback-run'").get())
      .toMatchObject({ status: 'unknown', phase: 'turn_intent' });
    expect(db().prepare("SELECT status FROM conversation_bridge_operations WHERE request_key='rollback-bridge'").get()?.status)
      .toBe('unknown');
    expect(existsSync(abandoned)).toBe(false);
    expect(readFileSync(unrelated, 'utf8')).toBe('other file');
    expect(await runtime.tick()).toBe(false);
    expect(wire.submitted).toEqual([]);
    await runtime.close();
  });

  it('并发评估真实假协议调用和私聊证据，关闭模型分派时手动调度仍可重试确定性分派', async () => {
    sample();
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP44KAAAAN0AVEsSGUpAAAAAElFTkSuQmCC', 'base64');
    let ids: number[] = [];
    const wire = fixture(() => ({ project_status: 'suggested', proposed_project_id: 91301,
      evidence_event_ids: ids, reason: '同一报告问题', missing_context: '',
      relationship: 'same_issue', relationship_reason: '两条消息描述同一个显示行为' }));
    const prior = new Date(Date.now() - 120_000).toISOString();
    const at = new Date(Date.now() - 60_000).toISOString();
    const reader = vi.fn(async () => ({ complete: true, conversationId: 'assessment-thread', messages: [
      { conversationId: 'assessment-thread', senderId: 'self', messageId: 'previous',
        occurredAt: prior, text: '请确认报告显示问题' },
      { conversationId: 'assessment-thread', senderId: 'private-actor', messageId: 'two',
        occurredAt: at, text: '第二条报告消息' },
    ] }));
    const readImages = vi.fn(async () => [{ contentType: 'image/png', bytes: png }]);
    await boot(wire.driver, 0, undefined, { readOwnDingTalk: reader, readOwnDingTalkImages: readImages });
    const project = seed();
    setting('semantic_routing_enabled', false);
    setting('watchdog_enabled', false);
    setting('connectors.dingtalk', { enabled: true, profile: 'p', self_ids: ['self'], executable: ['disabled-test'] });
    db().prepare("INSERT INTO governance_identities(id,source,actor_id,user_id,enabled) VALUES(91302,'dingtalk','private-actor','alice',1)").run();
    db().prepare('INSERT INTO governance_identity_grants(identity_id,project_ids,permissions) VALUES(?,?,?)')
      .run(91302, JSON.stringify([project]), '["request"]');
    for (const message of ['one', 'two']) {
      const event = await post('/events', { source: 'dingtalk', event_type: 'message.received',
        external_id: 'assessment-' + message, actor_id: 'private-actor', thread_id: 'assessment-thread',
        content: message === 'two' ? '[图片消息](mediaId=synthetic-png)' : '请核对报告显示',
        occurred_at: at, metadata: { profile: 'p', message_id: message,
          dws_event_type: 'user_im_message_receive_o2o_all' } });
      expect(event.statusCode, event.body).toBe(200);
      ids.push(event.json().id);
    }
    expect((await post('/routing/assessments', { event_ids: ids }, 'viewer')).statusCode).toBe(403);
    db().prepare("UPDATE events SET data=json_set(data,'$.thread_id','foreign') WHERE id=?").run(ids[0]);
    expect((await post('/routing/assessments', { event_ids: ids })).statusCode).toBe(422);
    db().prepare("UPDATE events SET data=json_set(data,'$.thread_id','assessment-thread') WHERE id=?").run(ids[0]);
    expect(readImages).not.toHaveBeenCalled();
    const requests = await Promise.all(Array.from({ length: 4 }, () => post('/routing/assessments', { event_ids: ids })));
    expect(requests.map(row => row.statusCode)).toEqual([200, 200, 200, 200]);
    expect(requests.map(row => row.json())).toEqual(Array(4).fill(requests[0].json()));
    expect(wire.observed, requests[0].body).toHaveLength(1);
    expect(requests[0].json()).toMatchObject({ status: 'assessed', event_ids: ids, thread_id: wire.observed[0].thread,
      turn_id: wire.observed[0].turn, evidence_turn_id: wire.observed[0].turn, visual_inputs: [ids[1]],
      evidence: [{ tool: 'chat_evidence', status: 'verified', message_count: 1 },
        { tool: 'source_image', event_id: ids[1], status: 'verified', images: [{ content_type: 'image/png', bytes: png.length }] }],
      decision: { relationship: 'same_issue', proposed_project_id: project } });
    expect(wire.observed).toHaveLength(1);
    expect(reader).toHaveBeenCalledTimes(1);
    expect(readImages).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ eventId: ids[1], anchorId: 'two',
      peer: 'private-actor', conversation: 'assessment-thread', profile: 'p', selfIds: ['self'] }), expect.any(AbortSignal));
    expect(wire.imageInputs).toHaveLength(1);
    expect(wire.imageInputs[0].bytes).toEqual(png);
    expect(existsSync(wire.imageInputs[0].path)).toBe(false);
    expect(wire.submitted[0].prompt).toContain('"visual_input_event_ids":[' + ids[1] + ']');
    expect(wire.submitted[0].prompt).not.toContain(png.toString('base64'));
    expect(db().prepare('SELECT count(*) AS n FROM event_targets WHERE event_id IN (?,?)').get(...ids)?.n).toBe(0);
    const recorded = db().prepare("SELECT details FROM governance_audit WHERE action='event.readonly_assessment' AND resource=?")
      .get(requests[0].json().assessment_id);
    expect(JSON.parse(String(recorded?.details))).toEqual(requests[0].json());
    expect(recorded?.details).not.toContain(wire.imageInputs[0].path);
    expect(recorded?.details).not.toContain(png.toString('base64'));
    await close();
    await boot(wire.driver, 0, undefined, { readOwnDingTalk: reader, readOwnDingTalkImages: readImages });
    const replay = await post('/routing/assessments', { event_ids: ids });
    expect(replay.json()).toEqual(requests[0].json());
    expect(wire.submitted).toHaveLength(1);
    expect(readImages).toHaveBeenCalledTimes(1);
    db().exec("UPDATE governance_identities SET enabled=0 WHERE id=91301");
    const pending = await post('/events', incoming('manual-schedule'));
    const pendingId = pending.json().id;
    expect(pending.json().data.routing_status).toBe('pending_confirmation');
    db().exec("UPDATE governance_identities SET enabled=1 WHERE id=91301");
    const scheduled = await post('/routing/schedule', { event_id: pendingId });
    expect(scheduled.statusCode, scheduled.body).toBe(200);
    expect(scheduled.json()).toEqual({ checked: 1, routed_event_ids: [pendingId] });
    expect(wire.observed).toHaveLength(1);

    readImages.mockImplementationOnce(async () => []);
    const missing = await post('/routing/assessments', { event_ids: ids, request_key: 'missing-image' });
    expect(missing.json()).toMatchObject({ status: 'incomplete', evidence_turn_id: null, visual_inputs: [],
      evidence: [expect.anything(), { tool: 'source_image', event_id: ids[1], status: 'unavailable', error: 'no_verified_image' }] });
    readImages.mockImplementationOnce(async () => [{ contentType: 'image/png', bytes: Buffer.from('not a PNG') }]);
    const invalid = await post('/routing/assessments', { event_ids: ids, request_key: 'invalid-image' });
    expect(invalid.json()).toMatchObject({ status: 'incomplete', visual_inputs: [],
      evidence: [expect.anything(), { tool: 'source_image', event_id: ids[1], status: 'unavailable', error: 'no_verified_image' }] });

    const beforeRevoked = wire.submitted.length;
    readImages.mockImplementationOnce(async () => {
      db().prepare("UPDATE events SET data=json_set(data,'$.metadata.message_id','replaced') WHERE id=?").run(ids[1]);
      return [{ contentType: 'image/png', bytes: png }];
    });
    const revoked = await post('/routing/assessments', { event_ids: ids, request_key: 'revoked-image' });
    expect(revoked.json()).toMatchObject({ status: 'incomplete', evidence: [], thread_id: null, visual_inputs: [] });
    expect(wire.submitted).toHaveLength(beforeRevoked);

    db().prepare("UPDATE events SET data=json_set(data,'$.metadata.message_id','two','$.attachments',json('[]')),content='没有原图' WHERE id=?").run(ids[1]);
    const beforeText = readImages.mock.calls.length;
    const textOnly = await post('/routing/assessments', { event_ids: ids, request_key: 'text-only' });
    expect(textOnly.json()).toMatchObject({ status: 'incomplete', evidence_turn_id: null, visual_inputs: [],
      evidence: [{ tool: 'chat_evidence', status: 'verified', message_count: 1 }] });
    expect(readImages).toHaveBeenCalledTimes(beforeText);
    expect(wire.imageInputs).toHaveLength(1);

    db().prepare("UPDATE events SET content='[图片消息](mediaId=synthetic-png)' WHERE id=?").run(ids[1]);
    wire.driver.imagesAvailable = () => false;
    const unsupported = await post('/routing/assessments', { event_ids: ids, request_key: 'unsupported-image-driver' });
    expect(unsupported.json()).toMatchObject({ status: 'incomplete', evidence_turn_id: null, visual_inputs: [],
      evidence: [expect.anything(), { tool: 'source_image', event_id: ids[1], status: 'unavailable',
        error: 'model_image_input_unavailable' }] });
    expect(readImages).toHaveBeenCalledTimes(beforeText);
  }, 60_000);
});
