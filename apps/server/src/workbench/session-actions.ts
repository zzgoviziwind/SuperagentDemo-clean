import { isDeepStrictEqual } from 'node:util';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { roleOf } from '../auth.ts';
import { workbenchRuntime } from './runtime.ts';
import { parseSession, sessionDetail } from './sessions.ts';
import { fail, fields, integer, now, principalOf, requireAdmin, type Event, type Fields, type Principal,
  type Task, type WorkbenchStore } from './store.ts';

const handoffStates = new Set(['paused', 'failed', 'review_ready', 'completed', 'cancelled']);
const finalStates = new Set(['completed', 'cancelled']);

function activeAttempt(store: WorkbenchStore, task: Task) {
  return task.last_error === '正在停止执行' || Boolean(store.db.prepare(`SELECT 1 FROM execution_attempts
    WHERE task_id=? AND status IN ('claimed','running','waiting_approval') LIMIT 1`).get(task.id));
}

function handoff(store: WorkbenchStore, ident: string, principal: Principal) {
  const session = parseSession(ident);
  if (session.kind !== 'worker') fail(422, '请从事件的执行任务接管');
  return store.write(() => {
    let task = store.row<Task>('tasks', 'id', session.id);
    if (!task || !store.allowedWorker(task, principal)) fail(404, '任务不存在');
    if (!handoffStates.has(task.status) || task.outcome_unknown || activeAttempt(store, task)) {
      fail(409, '请先暂停任务并等待执行退出；未知结果须先核验');
    }
    if (store.row('project_execution_nodes', 'project_id', task.project_id)?.node_id) {
      fail(409, '远端执行任务需先在执行设备核验并接管，暂不提供本机接管');
    }
    const previous = store.db.prepare(`SELECT 1 FROM events WHERE task_id=? AND event_type='manual_handoff'
      AND json_extract(data,'$.state_version')=? AND json_extract(data,'$.control_version')=? LIMIT 1`)
      .get(task.id, task.state_version, task.control_version);
    if (!previous) {
      if (!finalStates.has(task.status)) {
        store.db.prepare(`UPDATE tasks SET status='paused',state_version=state_version+1,
          control_version=control_version+1,updated_at=? WHERE id=?`).run(now(), task.id);
        store.db.prepare("UPDATE approvals SET status='expired' WHERE task_id=? AND status='pending'").run(task.id);
        task = store.required<Task>('tasks', task.id);
      }
      store.addEvent(task.id, 'manual_handoff', '已准备人工接管材料', {
        state_version: task.state_version, control_version: task.control_version, actor: principal.user_id,
      });
    }
    const project = store.row('projects', 'id', task.project_id);
    const summary = store.rows('artifacts', "WHERE task_id=? AND kind='summary' ORDER BY id DESC LIMIT 1", task.id)[0];
    const text = [`继续事件任务 #${task.id}：${task.title}`, `目标：${task.goal}`, `验收要求：${task.acceptance_criteria ?? ''}`,
      `工作目录：${task.workspace_path || project?.repo_path || '尚未创建'}`, `原 Codex 会话：${task.codex_thread_id || '尚未创建'}`,
      `当前状态：${task.status}；任务版本：${task.state_version}`, `最近交付摘要：${summary?.content ?? '暂无'}`,
      '先核对现有修改与执行证据，再继续。不要自动对外回复、提交、部署或修改业务数据库。',
      '平台任务需保持暂停；人工操作结果不会自动同步回平台，请返回事件补充验收证据。'].join('\n');
    return { task_id: task.id, thread_id: task.codex_thread_id, workspace_path: task.workspace_path, content: text };
  });
}

const coordinationSchema = z.object({
  target_task_id: z.int().positive(),
  event_id: z.int().positive().nullable().default(null),
  source_reference: z.string().max(1000).default(''),
  evidence: z.string().min(1).max(10000).refine(value => Boolean(value.trim())),
  expected_state_version: z.int().positive(),
  request_key: z.string().min(1).max(120),
});

function linkedTasks(store: WorkbenchStore, event: Event): Set<number> {
  const ids = new Set(store.db.prepare('SELECT task_id FROM event_targets WHERE event_id=?').all(event.id)
    .map(row => Number(row.task_id)));
  if (event.task_id !== null) ids.add(event.task_id);
  return ids;
}

function canSeeReceipt(store: WorkbenchStore, event: Event, target: Task, principal: Principal) {
  if (principal.role === 'admin') return true;
  return [...linkedTasks(store, event)].some(id => {
    const row = store.row<Task>('tasks', 'id', id);
    return row?.project_id === target.project_id && store.allowedWorker(row, principal);
  });
}

function requestCoordination(store: WorkbenchStore, ident: string, input: unknown, principal: Principal) {
  const parsed = coordinationSchema.safeParse(input);
  if (!parsed.success) fail(422, '调配申请字段无效');
  const body = parsed.data;
  if (body.event_id === null && !body.source_reference.trim()) fail(422, '请提供待获取来源的明确编号或引用');
  return store.write(() => {
    const { session } = sessionDetail(store, ident, principal);
    const target = store.row<Task>('tasks', 'id', body.target_task_id);
    if (!target || !store.allowedWorker(target, principal)) fail(404, '目标任务不存在');
    if (target.project_id !== session.project_id) fail(409, '不允许跨项目关联');
    if (body.event_id !== null) {
      const event = store.row<Event>('events', 'id', body.event_id);
      if (!event || !canSeeReceipt(store, event, target, principal)) fail(404, '来源事件不存在');
      if ([...linkedTasks(store, event)].some(id => store.row<Task>('tasks', 'id', id)?.project_id !== target.project_id)) {
        fail(409, '事件已有跨项目关联，不能追加');
      }
    }
    const previous = store.rows<Event>('events', `WHERE task_id=? AND event_type='coordination_request'
      AND json_extract(data,'$.request_key')=? ORDER BY id LIMIT 1`, target.id, body.request_key)[0];
    if (previous) {
      const old = coordinationSchema.safeParse({ request_key: previous.data.request_key, ...fields(previous.data.request) });
      if (!old.success || !isDeepStrictEqual(old.data, body) || previous.data.session_id !== session.id) {
        fail(409, '请求键已用于其他内容');
      }
      return previous;
    }
    if (target.state_version !== body.expected_state_version) fail(409, '目标任务版本已变化');
    const data = { request_key: body.request_key, request: body, session_id: session.id, actor: principal.user_id,
      status: body.event_id === null ? 'awaiting_source' : 'pending' };
    const result = store.db.prepare(`INSERT INTO events(task_id,source,event_type,content,data,created_at)
      VALUES (?,'web','coordination_request',?,?,?)`).run(target.id, body.evidence, JSON.stringify(data), now());
    return store.required<Event>('events', Number(result.lastInsertRowid));
  });
}

function authorizedActor(app: FastifyInstance, store: WorkbenchStore, event: Event, target: Task, project: Fields) {
  if (!['dingtalk', 'redmine'].includes(event.source) || !event.external_id
    || fields(event.data.metadata).self_authored === true) fail(403, '来源身份无权访问目标任务');
  const identity = store.rows('governance_identities', 'WHERE source=? AND actor_id=? AND enabled=1 LIMIT 1',
    event.source, String(event.data.actor_id ?? ''))[0];
  const user = identity?.user_id;
  const resolve = workbenchRuntime(app)?.resolveRole;
  const role = typeof user === 'string' ? (resolve ? resolve(user) : roleOf(process.env, user)) : undefined;
  const grants = typeof identity?.id === 'number' ? store.row('governance_identity_grants', 'identity_id', identity.id) : undefined;
  if (typeof user !== 'string' || !(role === 'admin' || role === 'member' && store.taskOwner(target) === user)
    || !project.enabled || project.archived || target.outcome_unknown || finalStates.has(target.status)
    || !Array.isArray(grants?.permissions) || !grants.permissions.includes('request')
    || !Array.isArray(grants.project_ids) || !grants.project_ids.some(id => String(id) === String(target.project_id))) {
    fail(403, '来源身份无权访问目标任务');
  }
  const bindings = event.source === 'dingtalk' ? project.dingtalk_chat_ids : project.redmine_project_ids;
  if (!Array.isArray(bindings) || !event.data.project_external_id
    || !bindings.some(value => String(value) === String(event.data.project_external_id))) fail(409, '来源未绑定目标项目');
  return user;
}

function appendReceipt(store: WorkbenchStore, event: Event, task: Task, actor: string) {
  const time = now();
  const attachments = Array.isArray(event.data.attachments) && event.data.attachments.length > 0;
  const data = { ...Object.fromEntries(Object.entries(event.data).filter(([key]) => !key.startsWith('_'))),
    actor, source_event_id: event.id, subscription_id: null, routing_status: 'delivered', requires_interrupt: false,
    ...(attachments ? { attachments_status: 'pending' } : {}) };
  const message = store.db.prepare(`INSERT INTO events(task_id,source,event_type,content,data,created_at)
    VALUES (?,?,'message',?,?,?)`).run(task.id, event.source, event.content, JSON.stringify(data), time);
  const status = task.status === 'review_ready' ? 'waiting_input' : attachments && task.status === 'queued' ? 'waiting_resource' : task.status;
  const error = status === 'waiting_input' && task.status === 'review_ready' ? '收到订阅事件，请确认后继续'
    : status === 'waiting_resource' && task.status === 'queued' ? '正在准备来源附件' : (task.last_error as string | null);
  store.db.prepare(`UPDATE tasks SET revision=revision+1,control_version=control_version+1,state_version=state_version+1,
    status=?,last_error=?,updated_at=? WHERE id=?`).run(status, error, time, task.id);
  store.db.prepare("UPDATE approvals SET status='expired' WHERE task_id=? AND status='pending'").run(task.id);
  store.db.prepare('INSERT INTO event_targets(event_id,task_id,message_event_id,created_at) VALUES(?,?,?,?)')
    .run(event.id, task.id, message.lastInsertRowid, time);
  if (attachments) store.db.prepare(`INSERT INTO event_attachment_jobs(event_id,task_id,revision,control_version,status,results)
    VALUES (?,?,?,?,'pending','[]')`).run(message.lastInsertRowid, task.id, task.revision + 1, task.control_version + 1);
}

function applyCoordination(app: FastifyInstance, store: WorkbenchStore, ident: string, id: number, principal: Principal) {
  return store.write(() => {
    const { session } = sessionDetail(store, ident, principal);
    const row = store.row<Event>('events', 'id', id);
    if (!row || row.event_type !== 'coordination_request' || row.task_id === null) fail(404, '申请不存在');
    const target = store.row<Task>('tasks', 'id', row.task_id);
    if (!target) fail(404, '目标任务不存在');
    if (session.project_id !== target.project_id) fail(409, '不允许跨项目调配');
    if (session.kind === 'worker' && session.task_id !== target.id && session.id !== row.data.session_id) fail(404, '申请不存在');
    if (row.data.status === 'applied') return row;
    const body = fields(row.data.request);
    const event = typeof body.event_id === 'number' ? store.row<Event>('events', 'id', body.event_id) : undefined;
    if (!event) fail(409, '来源尚未获取，不能应用');
    const project = store.row('projects', 'id', target.project_id) ?? fail(403, '来源身份无权访问目标任务');
    const actor = authorizedActor(app, store, event, target, project);
    if (target.state_version !== body.expected_state_version) fail(409, '目标任务版本已变化，请重新申请');
    if (['running','waiting_approval'].includes(target.status) || activeAttempt(store, target)) {
      fail(409, '请先暂停目标 Worker 并等待执行退出');
    }
    const linked = linkedTasks(store, event);
    if ([...linked].some(task => store.row<Task>('tasks', 'id', task)?.project_id !== target.project_id)) {
      fail(409, '事件已有跨项目关联，不能追加');
    }
    if (!linked.has(target.id)) appendReceipt(store, event, target, actor);
    const data = { ...row.data, status: 'applied', applied_by: principal.user_id,
      retained_task_ids: [...linked].filter(task => task !== target.id).sort((left, right) => left - right),
      effect: '追加事件关联；保留原任务及其执行证据，不停止或迁移原 Worker' };
    store.db.prepare('UPDATE events SET data=? WHERE id=?').run(JSON.stringify(data), row.id);
    return { ...row, data };
  });
}

export function registerSessionActions(app: FastifyInstance, store: WorkbenchStore): void {
  const root = '/api/v1/sessions/:id';
  app.post<{ Params: { id: string } }>(root + '/handoff', request => handoff(store, request.params.id, principalOf(request)));
  app.post<{ Params: { id: string } }>(root + '/coordination', request =>
    requestCoordination(store, request.params.id, request.body, principalOf(request)));
  app.post<{ Params: { id: string; request_id: string } }>(root + '/coordination/:request_id/apply', request => {
    const principal = requireAdmin(request, '仅管理员可应用调配');
    return applyCoordination(app, store, request.params.id, integer(request.params.request_id, 'request_id'), principal);
  });
}
