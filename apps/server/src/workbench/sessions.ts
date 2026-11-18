import type { FastifyInstance } from 'fastify';
import type { Event, Fields, Principal, Task, WorkbenchStore } from './store.ts';
import { fail, fields, integer, principalOf } from './store.ts';
import { workbenchRuntime, type SessionBinding } from './runtime.ts';

export interface RoutingJob extends Fields {
  event_id: number;
  project_id: number;
  thread_id: string | null;
  turn_id: string | null;
  status: string;
  output: string;
  created_at: string;
  updated_at: string;
}

export function routingMode(job?: RoutingJob): string {
  if (job?.turn_id) return 'agent';
  if (job?.status === 'queued' || job?.status === 'running') return 'pending';
  return job?.status === 'unknown' ? 'unknown' : 'rules';
}

export function targetTaskIds(store: WorkbenchStore, eventId: number, taskId: number | null): number[] {
  const linked = store.db.prepare('SELECT task_id FROM event_targets WHERE event_id = ?').all(eventId);
  const ids = new Set(linked.map(row => Number(row.task_id)));
  if (taskId) ids.add(taskId);
  return [...ids].sort((a, b) => a - b);
}

function worker(task: Task) {
  return { id: `worker:${task.id}`, kind: 'worker', task_kind: task.kind, project_id: task.project_id,
    task_id: task.id, title: task.title, status: task.status, codex_thread_id: task.codex_thread_id,
    state_version: task.state_version, mode: 'codex' };
}

function router(store: WorkbenchStore, project: Fields, mode: string) {
  const row = store.row('router_sessions', 'project_id', project.id as number);
  return { id: `router:${project.id}`, kind: 'router', project_id: project.id, task_id: null,
    title: project.name, status: row?.status ?? 'idle', codex_thread_id: row?.codex_thread_id ?? null,
    state_version: row?.state_version ?? 1, outcome_unknown: row?.outcome_unknown ?? false,
    last_error: row?.last_error ?? null, mode };
}

function routerMode(store: WorkbenchStore) {
  return store.row('governance_settings', 'key', 'router_agent_enabled')?.value ? 'agent' : 'rules';
}

function semanticSession(store: WorkbenchStore, job: RoutingJob) {
  const row = store.row('event_routing_sessions', 'event_id', job.event_id);
  const event = store.row<Event>('events', 'id', job.event_id);
  return { id: `semantic:${job.event_id}`, kind: 'routing', project_id: job.project_id || null, task_id: null,
    event_id: job.event_id, title: event ? [...event.content].slice(0, 100).join('') : `事件 ${job.event_id}`,
    status: row?.status ?? job.status, routing_status: job.status, codex_thread_id: job.thread_id,
    codex_turn_id: job.turn_id, state_version: row?.state_version ?? 1,
    outcome_unknown: Boolean(row?.outcome_unknown || job.status === 'unknown'),
    last_error: row?.last_error || job.error, mode: routingMode(job), ai_invoked: Boolean(job.turn_id),
    worker_session_ids: targetTaskIds(store, job.event_id, event?.task_id ?? null).map(id => `worker:${id}`) };
}

function historyRow(id: string, role: string, content: string, created_at: string) {
  return { id, role, content, created_at };
}

function timestamp(value: unknown): string | undefined {
  const milliseconds = typeof value === 'number' ? value
    : typeof value === 'string' && /(?:Z|[+-]\d{2}:?\d{2})$/.test(value) ? Date.parse(value) : NaN;
  if (!Number.isFinite(milliseconds) || Math.abs(milliseconds) > 8.64e15) return;
  const tail = typeof value === 'string' ? /\.(\d+)(?:Z|[+-]\d{2}:?\d{2})$/.exec(value)?.[1]?.slice(3, 6)
    : String(((Math.round(milliseconds * 1000) % 1000) + 1000) % 1000).padStart(3, '0');
  return new Date(Math.floor(milliseconds)).toISOString().replace('Z', `${(tail ?? '').padEnd(3, '0')}Z`);
}

function workerMessages(store: WorkbenchStore, task: Task) {
  const events = store.rows<Event>('events', 'WHERE task_id = ? ORDER BY id', task.id);
  const delivered = new Set(store.db.prepare('SELECT message_event_id FROM event_targets WHERE task_id = ?')
    .all(task.id).map(row => row.message_event_id));
  const external = (event: Event) => ['dingtalk', 'redmine'].includes(event.source)
    && (['routed', 'self_context', 'manually_linked'].includes(String(event.data.routing_status))
      || (event.data.routing_status === 'delivered' && delivered.has(event.id)));
  const created = (event: Event) => event.source === 'web' && event.event_type === 'created';
  const assistant = (event: Event) => event.source === 'runtime' && event.event_type === 'assistant_message';
  const visible = events.filter(event => external(event) || assistant(event)
    || (event.source === 'coordination' && event.event_type === 'collaboration_result')
    || (event.source === 'web' && ['created', 'message', 'goal_changed', 'project_rebound'].includes(event.event_type)));
  const linked = new Set(visible.filter(assistant).map(event => event.data.artifact_id));
  const messages: Fields[] = visible.filter(event => event.content).map(event => {
    const meta = fields(event.data.metadata);
    return { ...historyRow(`event:${event.id}`, assistant(event) ? 'assistant' : 'user', event.content,
      timestamp(event.data.occurred_at || event.created_at) ?? event.created_at),
      data: { sender: meta.sender_name || event.data.actor_id || event.data.actor
        || (['runtime', 'coordination'].includes(event.source) ? 'SuperAgent' : 'operator'),
      source: event.source, direction: meta.self_authored ? 'own_account' : event.external_id ? 'received' : 'local' } };
  });
  const artifacts = store.rows<{ id: number; content: string; created_at: string }>('artifacts',
    "WHERE task_id = ? AND kind = 'summary' ORDER BY id", task.id);
  for (const row of artifacts) {
    if (!linked.has(row.id)) messages.push(historyRow(`artifact:${row.id}`, 'assistant', row.content, row.created_at));
  }
  if (!visible.some(event => created(event) || external(event))) {
    messages.push(historyRow(`goal:${task.id}`, 'user', task.goal, task.created_at));
  }
  const sortKey = (row: Fields) => `${timestamp(row.created_at) ?? row.created_at}\n${row.id}`;
  return messages.sort((a, b) => sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0);
}

export function displayJson(value: unknown, sort = false): string {
  if (Array.isArray(value)) return `[${value.map(item => displayJson(item, sort)).join(', ')}]`;
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value);
    if (sort) keys.sort();
    return `{${keys.map(key => `${JSON.stringify(key)}: ${displayJson(fields(value)[key], sort)}`).join(', ')}}`;
  }
  return JSON.stringify(value);
}

function semanticMessages(store: WorkbenchStore, job: RoutingJob): Fields[] {
  const messages = store.rows('event_routing_messages', 'WHERE event_id = ? ORDER BY id', job.event_id);
  if (!messages.some(message => fields(message.data).source === 'model_context')) {
    messages.unshift({ ...historyRow(`legacy-input:${job.event_id}`, 'user', displayJson(job.context), job.created_at),
      data: { historical_snapshot: true, source: 'model_context' } });
  }
  if (job.output && !messages.some(message => message.role === 'assistant' && message.content === job.output)) {
    messages.push({ ...historyRow(`legacy-output:${job.event_id}`, 'assistant', job.output, job.updated_at),
      data: { historical_snapshot: true, source: 'saved_model_output' } });
  }
  return messages;
}

const historySource = 'persisted_visible_messages';

function history(session: Fields, messages: Fields[], reason: string) {
  return { session, messages, transcript: { complete: false, source: historySource, reason } };
}

export function parseSession(ident: string): SessionBinding {
  const parts = /^(worker|router|semantic):\s*\+?(\d+)\s*$/.exec(ident);
  const id = Number(parts?.[2]);
  if (!parts || !Number.isSafeInteger(id) || id <= 0) fail(404, '会话不存在');
  return { kind: parts[1] as SessionBinding['kind'], id };
}

export function sessionDetail(store: WorkbenchStore, ident: string, principal: Principal) {
  const { kind, id } = parseSession(ident);
  if (kind === 'worker') {
    const task = store.row<Task>('tasks', 'id', id);
    if (!task || !store.allowedWorker(task, principal)) fail(404, '会话不存在');
    return history(worker(task), workerMessages(store, task), '历史可能只有任务摘要，完整可见记录需读取 transcript');
  }
  if (principal.role !== 'admin') fail(404, '会话不存在');
  if (kind === 'router') {
    const project = store.row('projects', 'id', id);
    if (!project) fail(404, '会话不存在');
    return history(router(store, project, routerMode(store)),
      store.rows('router_messages', 'WHERE project_id = ? ORDER BY id', id),
      '平台可见消息记录，完整模型记录需读取 transcript');
  }
  const job = store.row<RoutingJob>('semantic_routing_jobs', 'event_id', id);
  if (!job) fail(404, '会话不存在');
  return history(semanticSession(store, job), semanticMessages(store, job), '平台保存的可见消息，完整模型项目记录请读取 transcript 接口');
}

export function listSessions(store: WorkbenchStore, principal: Principal, id?: number) {
  const filters = (key: string, order: string) => id === undefined ? `ORDER BY ${order}` : `WHERE ${key} = ? ORDER BY ${order}`;
  const params = id === undefined ? [] : [id];
  const sessions: Fields[] = store.rows<Task>('tasks', filters('project_id', 'id DESC'), ...params)
    .filter(task => store.allowedWorker(task, principal)).map(worker);
  if (principal.role === 'admin') {
    const mode = routerMode(store);
    sessions.push(...store.rows('projects', filters('id', 'id'), ...params).map(project => router(store, project, mode)));
    sessions.push(...store.rows<RoutingJob>('semantic_routing_jobs', filters('project_id', 'event_id DESC'), ...params)
      .map(job => semanticSession(store, job)));
  }
  return sessions;
}

const threadItemTypes = new Set(['userMessage', 'agentMessage', 'commandExecution', 'fileChange', 'mcpToolCall',
  'dynamicToolCall', 'webSearch', 'imageView', 'enteredReviewMode', 'exitedReviewMode', 'contextCompaction', 'error']);

async function transcript(app: FastifyInstance, store: WorkbenchStore, id: string, principal: Principal) {
  const detail = sessionDetail(store, id, principal);
  const threadId = detail.session.codex_thread_id;
  const fallback = { session_id: id, thread_id: threadId, source: historySource, complete: false,
    items: detail.messages, reason: threadId ? '历史仅有平台保存消息，未取得完整 Codex 可见记录'
      : '尚无真实 Codex 线程，当前显示平台记录' };
  const read = workbenchRuntime(app)?.readThread;
  if (!read || typeof threadId !== 'string' || !threadId) return fallback;
  const binding = parseSession(id);
  let raw: unknown;
  try { raw = await read({ ...binding, threadId, includeTurns: true }, AbortSignal.timeout(15_000)); }
  catch { return { ...fallback, reason: '模型会话读取暂不可用，当前显示平台历史' }; }
  const latest = sessionDetail(store, id, principal);
  if (latest.session.codex_thread_id !== threadId) return { ...fallback, items: latest.messages,
    thread_id: latest.session.codex_thread_id, reason: '会话绑定已变化，当前显示平台历史' };
  const outer = fields(raw);
  const thread = fields(outer.thread ?? outer);
  if (thread.id !== threadId || !Array.isArray(thread.turns)) {
    return { ...fallback, reason: 'Codex 返回记录与平台会话不匹配，当前显示平台历史' };
  }
  const items = thread.turns.flatMap((turn: unknown) => {
    const row = fields(turn);
    return (Array.isArray(row.items) ? row.items : []).map(fields).filter(item => threadItemTypes.has(String(item.type)))
      .map(item => ({ ...item, turn_id: row.id ?? null }));
  });
  return { session_id: id, thread_id: threadId, source: 'codex_thread', complete: true, items, reason: null };
}

export function registerSessions(app: FastifyInstance, store: WorkbenchStore): void {
  const root = '/api/v1/sessions';
  app.get(root, request => {
    const principal = principalOf(request);
    const query = fields(request.query);
    const id = query.project_id === undefined ? undefined : integer(query.project_id, 'project_id');
    return listSessions(store, principal, id);
  });
  app.get<{ Params: { id: string } }>(`${root}/:id`, request =>
    sessionDetail(store, request.params.id, principalOf(request)));
  app.get<{ Params: { id: string } }>(`${root}/:id/transcript`, request =>
    transcript(app, store, request.params.id, principalOf(request)));
  app.get<{ Params: { id: string } }>(`${root}/:id/coordination`, request => {
    const { session } = sessionDetail(store, request.params.id, principalOf(request));
    if (typeof session.project_id !== 'number') return [];
    if (session.kind === 'worker') return store.rows('events',
      "WHERE event_type = 'coordination_request' AND task_id = ? ORDER BY id", session.task_id as number);
    return store.rows('events', `WHERE event_type = 'coordination_request'
      AND task_id IN (SELECT id FROM tasks WHERE project_id = ?) ORDER BY id`, session.project_id);
  });
}
