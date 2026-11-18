import type { FastifyInstance } from 'fastify';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { Event, Task, WorkbenchStore } from './store.ts';
import { cursorPage, fail, fields, integer, now, page, queryText, requireAdmin, requiredText } from './store.ts';
import type { RoutingJob } from './sessions.ts';
import { trace } from './trace.ts';
import { roleOf } from '../auth.ts';
import { workbenchRuntime } from './runtime.ts';
import { ensureSemantic } from './session-writes.ts';

const inboxStatuses = new Set(['all', 'pending_confirmation', 'routed', 'ignored', 'dismissed',
  'manually_linked', 'self_echo', 'self_echo_candidate', 'semantic_pending']);
const invalidInbox = '收件箱筛选或分页参数无效';

function subscriptions(store: WorkbenchStore) {
  const byTask = new Map(store.rows<Task>('tasks').map(task => [task.id, task]));
  const byProject = new Map(store.rows('projects').map(project => [project.id, project.name]));
  const references = store.rows<{ id: number; project_id: number; route_key: string; task_id: number }>(
    'task_routes', 'ORDER BY id');
  const following = store.rows<{ id: number; project_id: number; thread_id: string; task_id: number }>(
    'worker_subscriptions', 'ORDER BY id');
  const summary = (row: { project_id: number; task_id: number }) => {
    const task = byTask.get(row.task_id);
    return { task_title: task?.title ?? null, task_status: task?.status ?? null,
      project_name: byProject.get(row.project_id) ?? null };
  };
  const referenceKind = (key: string) => {
    if (key.startsWith('issue:')) return 'issue';
    if (key.startsWith('dingtalk:message:')) return 'dingtalk_message';
    return key.startsWith('redmine:message:') ? 'redmine_message' : 'unknown';
  };
  return { items: [...references.map(row => ({ ...row, ...summary(row), reference_kind: referenceKind(row.route_key) })),
    ...following.map(row => ({ ...row, ...summary(row), subscription_type: 'explicit',
      route_key: row.thread_id, reference_kind: 'thread' }))],
  scope: '显式多对多线程订阅与历史单任务引用兼容' };
}

function correctionTasks(app: FastifyInstance, store: WorkbenchStore, job: RoutingJob) {
  const event = store.row<Event>('events', 'id', job.event_id);
  const project = store.row('projects', 'id', job.project_id);
  if (!event || !project?.enabled) return [];
  const identity = store.rows('governance_identities', 'WHERE source = ? AND actor_id = ? AND enabled = 1 LIMIT 1',
    event.source, String(event.data.actor_id ?? ''))[0];
  if (typeof identity?.user_id !== 'string') return [];
  const resolve = workbenchRuntime(app)?.resolveRole;
  const role = resolve ? resolve(identity.user_id) : roleOf(process.env, identity.user_id);
  if (role !== 'admin' && role !== 'member') return [];
  if (typeof identity.id !== 'number') return [];
  const grant = store.row('governance_identity_grants', 'identity_id', identity.id);
  if (!Array.isArray(grant?.project_ids) || !grant.project_ids.some(id => String(id) === String(job.project_id))
    || !Array.isArray(grant.permissions) || !grant.permissions.includes('request')) return [];
  return store.rows<Task>('tasks', 'WHERE project_id = ? ORDER BY id LIMIT 100', job.project_id)
    .filter(task => !task.outcome_unknown && !['completed', 'cancelled'].includes(task.status)
      && (role === 'admin' || store.taskOwner(task) === identity.user_id))
    .map(({ id, title, state_version }) => ({ id, title, state_version }));
}

const stages = [
  ['trigger', '事件持久接收'],
  ['fast_filter', '确定性身份、项目和请求规则'],
  ['slow_filter', '可配置 Codex 结构化判定与持久队列'],
  ['subscription', '多对多线程订阅及历史引用匹配'],
  ['router', '订阅 FastPath 与模型 SlowPath，确定性权限及版本校验后应用'],
  ['worker', '任务调度'],
  ['delivery', '草稿与审批'],
  ['session_db', '任务、事件与会话持久化'],
  ['execution', '本机 Codex 与共享卷 daemon 执行'],
  ['watchdog', '独立模型巡检、持久会话与证据、版本校验控制及人工纠正'],
];

const decisionSchema = z.strictObject({
  action: z.enum(['create', 'dispatch', 'ignore', 'confirm']),
  kind: z.enum(['analysis', 'repair', 'reply']),
  task_id: z.int().positive().nullable(),
  state_version: z.int().positive().nullable(),
  reason: z.string().max(2000).refine(value => !!value.trim()),
}).refine(decision => decision.action === 'dispatch' ? decision.task_id !== null && decision.state_version !== null
  : decision.task_id === null && decision.state_version === null);

export function registerReceipts(app: FastifyInstance, store: WorkbenchStore): void {
  app.get('/api/v1/architecture', request => {
    requireAdmin(request);
    const counts = store.db.prepare(`SELECT
      (SELECT count(*) FROM events WHERE source IN ('dingtalk', 'redmine') AND external_id IS NOT NULL) AS events,
      (SELECT count(*) FROM task_routes) + (SELECT count(*) FROM worker_subscriptions WHERE enabled = 1) AS subscriptions`).get();
    return { stages: stages.map(([stage, capability]) => ({ stage, capability })), counts,
      subscription_scope: '显式多对多线程订阅与历史单任务引用兼容',
      router_note: '语义路由默认关闭；启用后模型判定经权限与版本校验应用；对话 Router 独立配置' };
  });
  app.get('/api/v1/events', request => {
    requireAdmin(request);
    const query = fields(request.query);
    const { start, limit } = page(query, 'after', 50, invalidInbox);
    const status = queryText(query.routing_status, 'routing_status', 'pending_confirmation');
    const source = queryText(query.source, 'source');
    const search = queryText(query.q, 'q');
    if (!inboxStatuses.has(status)) fail(422, invalidInbox);
    const literal = search.replace(/[/%_]/g, '/$&');
    const rows = store.rows<Event>('events', `WHERE id > ? AND source IN ('dingtalk', 'redmine') AND external_id IS NOT NULL
      AND (? = 'all' OR json_extract(data, '$.routing_status') = ?) AND (? = '' OR source = ?)
      AND (? = '' OR content LIKE ? ESCAPE '/')
      ORDER BY id LIMIT ?`, start, status, status, source, source, search, `%${literal}%`, limit + 1);
    return cursorPage(rows, start, limit, row => row.id);
  });
  app.get<{ Params: { event_id: string } }>('/api/v1/events/:event_id/trace', request => {
    requireAdmin(request);
    return trace(store, integer(request.params.event_id, 'event_id'));
  });
  app.get('/api/v1/subscriptions', request => {
    requireAdmin(request);
    return subscriptions(store);
  });
  app.get('/api/v1/routing/jobs', request => {
    requireAdmin(request);
    const { start, limit } = page(fields(request.query), 'after', 50);
    const rows = store.rows<RoutingJob>('semantic_routing_jobs', 'WHERE event_id > ? ORDER BY event_id LIMIT ?', start, limit + 1);
    const result = cursorPage(rows, start, limit, row => row.event_id);
    return { ...result, items: result.items.map(job => ({ ...job, project_id: job.project_id || null,
      routing_session_id: `semantic:${job.event_id}`, correction_tasks: correctionTasks(app, store, job) })) };
  });
  app.post('/api/v1/routing/schedule', async request => {
    const principal = requireAdmin(request);
    const body = fields(request.body);
    const id = body.event_id == null ? undefined : integer(body.event_id, 'event_id');
    const schedule = workbenchRuntime(app)?.scheduleSemantic;
    if (!schedule) fail(409, '语义分派调度服务尚未接入');
    let result;
    try { result = await schedule(id, principal.user_id); }
    catch { fail(409, '分派调度结果未确认，请查看原消息与分派记录'); }
    if (!result || !Number.isSafeInteger(result.checked) || result.checked < 0 || result.checked > 100
      || !Array.isArray(result.routed_event_ids) || result.routed_event_ids.length > result.checked
      || new Set(result.routed_event_ids).size !== result.routed_event_ids.length
      || result.routed_event_ids.some(eventId => !Number.isSafeInteger(eventId) || (id !== undefined && eventId !== id)
        || store.row<Event>('events', 'id', eventId)?.data.routing_status !== 'routed')) {
      fail(409, '分派调度结果未确认，请查看原消息与分派记录');
    }
    return result;
  });
  app.post<{ Params: { event_id: string } }>('/api/v1/routing/jobs/:event_id/correction', async request => {
    const principal = requireAdmin(request);
    const id = integer(request.params.event_id, 'event_id');
    const body = fields(request.body);
    const evidence = requiredText(body.evidence, 4000, '需填写核验说明并等待模型退出');
    const parsed = decisionSchema.safeParse(body.decision);
    if (!parsed.success) fail(409, '判定字段、目标或版本无效');
    const decision = parsed.data;
    const historyOnly = store.write(() => {
      const job = store.row<RoutingJob>('semantic_routing_jobs', 'event_id', id);
      const event = store.row<Event>('events', 'id', id);
      if (!job || !event) fail(409, '判定任务不存在');
      if (fields(job.context).mode === 'unassigned_project') fail(409, '未归属项目的研判只能通过事件中心确认归属');
      if (['dismissed', 'manually_linked'].includes(String(event.data.routing_status))) {
        fail(409, '消息已关闭或人工关联，请从事件中心处理');
      }
      if (event.data.routing_status === 'routed' || (job.status === 'ignored' && isDeepStrictEqual(job.decision, decision))) {
        const time = now();
        ensureSemantic(store, job, time);
        const data = JSON.stringify({ status: 'correction_recorded_without_reapply', decision });
        store.db.prepare(`INSERT INTO event_routing_messages(event_id,role,content,data,created_at)
          VALUES (?, 'system', ?, ?, ?)`).run(id, evidence, data, time);
        store.db.prepare('UPDATE event_routing_sessions SET state_version=state_version+1 WHERE event_id=?').run(id);
        return { ...job, newly_applied: false };
      }
      if (job.status === 'running') fail(409, '需填写核验说明并等待模型退出');
      if (decision.action === 'dispatch' && !correctionTasks(app, store, job).some(task =>
        task.id === decision.task_id && task.state_version === decision.state_version)) fail(409, '目标或版本不在授权快照中');
      return null;
    });
    if (historyOnly) return historyOnly;
    const apply = workbenchRuntime(app)?.applySemanticCorrection;
    if (!apply) fail(409, '语义分派执行服务尚未接入');
    let applied;
    try { applied = await apply(id, decision, evidence, principal.user_id); }
    catch { fail(409, '分派纠正结果未确认，请查看原消息与分派记录'); }
    const persisted = store.row<RoutingJob>('semantic_routing_jobs', 'event_id', id);
    if (!persisted || !isDeepStrictEqual(persisted.decision, decision)
      || typeof applied.newly_applied !== 'boolean' || (applied.newly_applied && persisted.status !== 'applied')) {
      fail(409, '分派纠正结果未确认，请查看原消息与分派记录');
    }
    return { ...persisted, newly_applied: applied.newly_applied };
  });
}
