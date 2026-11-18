import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { callCanonical } from './canonical.ts';
import type { Fields, Task, WorkbenchStore } from './store.ts';
import { fail, fields, integer, now, principalOf, requiredText } from './store.ts';
import { displayJson, parseSession, type RoutingJob } from './sessions.ts';
import { workbenchRuntime } from './runtime.ts';

function setting(store: WorkbenchStore, key: string) {
  return store.row('governance_settings', 'key', key)?.value === true;
}

export function ensureSemantic(store: WorkbenchStore, job: RoutingJob, time: string) {
  store.db.prepare(`INSERT INTO event_routing_sessions(event_id,state_version,status,outcome_unknown,updated_at)
    VALUES (?,1,'idle',0,?) ON CONFLICT(event_id) DO NOTHING`).run(job.event_id, time);
  const initial = displayJson(job.context);
  store.db.prepare(`INSERT INTO event_routing_messages(event_id,role,content,item_key,data,created_at)
    VALUES (?, 'user', ?, 'initial-input', ?, ?) ON CONFLICT(event_id,item_key) DO NOTHING`)
    .run(job.event_id, initial, JSON.stringify({ status: 'prepared_input', source: 'model_context',
      historical_snapshot: Boolean(job.output) }), time);
  if (!job.output) {
    store.db.prepare(`UPDATE event_routing_messages SET content=? WHERE event_id=?
      AND item_key='initial-input' AND json_extract(data,'$.status')='prepared_input'`).run(initial, job.event_id);
  } else if (!store.db.prepare(`SELECT 1 FROM event_routing_messages WHERE event_id=? AND role='assistant' AND content=?`)
    .get(job.event_id, job.output)) {
    const key = 'legacy-output:' + createHash('sha256').update(JSON.stringify(job.output)).digest('hex');
    const data = { status: 'historical_snapshot', historical_snapshot: true, thread_id: job.thread_id, turn_id: job.turn_id };
    store.db.prepare(`INSERT INTO event_routing_messages(event_id,role,content,item_key,data,created_at)
      VALUES (?,'assistant',?,?,?,?)`).run(job.event_id, job.output, key, JSON.stringify(data), time);
  }
  return store.row('event_routing_sessions', 'event_id', job.event_id)!;
}

export async function postSessionMessage(app: FastifyInstance, store: WorkbenchStore, request: FastifyRequest,
  ident: string, body: Fields) {
  const principal = principalOf(request);
  const { kind, id } = parseSession(ident);
  const content = requiredText(body.content, 100000, '内容不能为空或过长');
  const expected = body.expected_state_version == null ? null : integer(body.expected_state_version, 'expected_state_version');
  if (body.change_goal !== undefined && typeof body.change_goal !== 'boolean') fail(422, 'change_goal 无效');
  if (kind === 'worker') {
    const task = store.row<Task>('tasks', 'id', id);
    if (!task || !store.allowedWorker(task, principal)) fail(404, '会话不存在');
    return callCanonical(app, request, '/api/v1/tasks/:id/messages', `/api/v1/tasks/${id}/messages`,
      { content, change_goal: body.change_goal ?? false, expected_state_version: expected });
  }
  if (principal.role !== 'admin') fail(404, '会话不存在');
  if ([...content].length > 20000) fail(kind === 'semantic' ? 409 : 422, '请输入 1 至 20000 字的消息');
  const text = content.trim();
  if (kind === 'semantic') return store.write(() => {
    const job = store.row<RoutingJob>('semantic_routing_jobs', 'event_id', id);
    if (!job || !setting(store, 'semantic_routing_enabled')) fail(409, '语义路由会话不存在或尚未启用');
    const time = now();
    const row = ensureSemantic(store, job, time);
    if (row.state_version !== expected) fail(409, '会话版本已变化，请刷新');
    if (row.outcome_unknown || job.status === 'unknown') fail(409, '上轮结果未知，请先核验');
    const { lastInsertRowid } = store.db.prepare(`INSERT INTO event_routing_messages(event_id,role,content,data,created_at)
      VALUES (?, 'user', ?, ?, ?)`).run(id, text, JSON.stringify({ status: 'queued', actor: principal.user_id }), time);
    store.db.prepare(`UPDATE event_routing_sessions SET status=CASE WHEN status='running' THEN status ELSE 'queued' END,
      state_version=state_version+1, updated_at=? WHERE event_id=?`).run(time, id);
    return store.required('event_routing_messages', Number(lastInsertRowid));
  });
  const runtime = workbenchRuntime(app);
  const wake = runtime?.wakeProjectRouter;
  const { enabled, result } = store.write(() => {
    const project = store.row('projects', 'id', id);
    if (!project) fail(404, '会话不存在');
    if (!project.enabled) fail(409, '项目不存在或已停用');
    const time = now();
    store.db.prepare(`INSERT INTO router_sessions(project_id,status,state_version,outcome_unknown,updated_at)
      VALUES (?,'idle',1,0,?) ON CONFLICT(project_id) DO NOTHING`).run(id, time);
    const row = store.row('router_sessions', 'project_id', id)!;
    if (expected !== null && row.state_version !== expected) fail(409, '会话已更新，请刷新后重试');
    if (row.outcome_unknown) fail(409, '上次 Router 运行结果未知，请先核验后解除保护');
    const enabled = setting(store, 'router_agent_enabled');
    if (enabled && (!wake || runtime?.projectRouterAvailable?.() === false)) fail(409, '尚未配置 Router 的 Codex 执行引擎');
    const data = JSON.stringify({ status: enabled ? 'queued' : 'note' });
    const { lastInsertRowid } = store.db.prepare(`INSERT INTO router_messages(project_id,role,content,data,created_at)
      VALUES (?, 'user', ?, ?, ?)`).run(id, text, data, time);
    store.db.prepare(`UPDATE router_sessions SET state_version=state_version+1, updated_at=?,
      status=CASE WHEN ? THEN 'running' ELSE status END,
      last_error=CASE WHEN ? THEN NULL ELSE last_error END WHERE project_id=?`).run(time, Number(enabled), Number(enabled), id);
    store.audit(principal.user_id, 'router.message', id, { mode: enabled ? 'agent' : 'note' });
    return { enabled, result: store.required('router_messages', Number(lastInsertRowid)) };
  });
  if (enabled && wake) {
    try { wake(id); } catch { fail(409, '消息已排队，Router 唤醒结果未确认，请核对会话'); }
  }
  return result;
}

export async function reconcileSession(app: FastifyInstance, store: WorkbenchStore, request: FastifyRequest,
  ident: string, body: Fields) {
  const principal = principalOf(request);
  const binding = parseSession(ident);
  const { kind, id } = binding;
  if (kind === 'worker' || principal.role !== 'admin') fail(404, '会话不存在');
  const evidence = requiredText(body.evidence, 10000, '请填写核验说明');
  const expected = integer(body.expected_state_version, 'expected_state_version');
  const stopped = workbenchRuntime(app)?.hasStoppedSession;
  if (!stopped || !await stopped(binding).catch(() => false)) fail(409, '请核验模型进程已退出并填写证据');
  return store.write(() => {
    const time = now();
    if (kind === 'router') {
      const row = store.row('router_sessions', 'project_id', id);
      if (!row?.outcome_unknown) fail(409, '没有需要核验的未知结果');
      if (row.state_version !== expected) fail(409, '会话已更新，请刷新');
      store.db.prepare(`UPDATE router_sessions SET status='idle',outcome_unknown=0,last_error=NULL,
        state_version=state_version+1,updated_at=? WHERE project_id=?`).run(time, id);
      store.db.prepare(`INSERT INTO router_messages(project_id,role,content,data,created_at)
        VALUES (?, 'system', ?, '{"status":"reconciled"}', ?)`).run(id, evidence, time);
      store.audit(principal.user_id, 'router.reconcile', id, { evidence, state_version: expected + 1 });
      return store.row('router_sessions', 'project_id', id);
    }
    const job = store.row<RoutingJob>('semantic_routing_jobs', 'event_id', id);
    if (!job) fail(409, '会话不存在');
    const row = ensureSemantic(store, job, time);
    if (row.state_version !== expected || !(row.outcome_unknown || job.status === 'unknown')) {
      fail(409, '会话版本或核验状态已变化');
    }
    store.db.prepare(`UPDATE event_routing_sessions SET status='idle',outcome_unknown=0,last_error=NULL,
      state_version=state_version+1 WHERE event_id=?`).run(id);
    store.db.prepare("UPDATE semantic_routing_jobs SET status='rejected' WHERE event_id=? AND status='unknown'").run(id);
    store.db.prepare(`UPDATE event_routing_messages SET data=json_set(data,'$.status','held_after_unknown')
      WHERE event_id=? AND json_extract(data,'$.status') IN ('queued','running')`).run(id);
    const data = JSON.stringify({ status: 'reconciled', actor: principal.user_id });
    store.db.prepare(`INSERT INTO event_routing_messages(event_id,role,content,data,created_at)
      VALUES (?, 'system', ?, ?, ?)`).run(id, evidence, data, time);
    return store.row('event_routing_sessions', 'event_id', id);
  });
}
