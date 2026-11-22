import type { FastifyInstance } from 'fastify';
import { isDeepStrictEqual } from 'node:util';
import type { SQLInputValue } from 'node:sqlite';
import type { Event, Fields, Principal, Task, WorkbenchStore } from './store.ts';
import { fail, fields, integer, now, page, principalOf, queryText, requireAdmin, requiredText } from './store.ts';
import { syncDingTalkHistory } from './dingtalk-history.ts';
import { workbenchRuntime } from './runtime.ts';
import { upgradeTriageNotices } from '../../../../packages/channels/feishu-notices.ts';

const externalSources = new Set(['dingtalk', 'redmine']);
const terminal = new Set(['completed', 'cancelled']);
const humanMessages = new Set(['message', 'goal_changed', 'project_rebound']);
const visibleTypes = new Set([...humanMessages, 'created', 'collaboration_result']);

function visibleMessage(event: Event): boolean {
  return (event.external_id != null && (externalSources.has(event.source) || event.source === 'field'))
    || (visibleTypes.has(event.event_type) && ['web', 'coordination'].includes(event.source));
}

function actionable(event: Event): boolean {
  return visibleMessage(event) && !['self_context','context_only'].includes(String(event.data.routing_status))
    && !(event.source === 'web' && humanMessages.has(event.event_type));
}

function groupEvents(store: WorkbenchStore, id: number): Event[] {
  return store.rows<Event>('events', `WHERE task_id = ? OR id IN (
    SELECT event_id FROM event_targets WHERE task_id = ?
  ) ORDER BY id`, id, id).filter(event => !externalSources.has(event.source) || !event.data.source_event_id);
}

function outcomes(events: Event[]): Map<unknown, Fields> {
  return new Map(events.filter(e => e.event_type === 'event_resolution' && Object.hasOwn(e.data, 'event_id'))
    .map(e => [e.data.event_id, e.data]));
}

function processing(event: Event, groupId: number, outcome?: Fields): Fields {
  return outcome ?? fields(fields(event.data.group_outcomes)[groupId]);
}

function eventView(event: Event, groupId: number, outcome?: Fields) {
  const result = processing(event, groupId, outcome);
  return { ...event, requires_resolution: actionable(event), visible_message: visibleMessage(event),
    processing: Object.keys(result).length ? result : { status: 'pending', evidence: '' } };
}

function groupProjection(store: WorkbenchStore, task: Task) {
  const events = groupEvents(store, task.id);
  const results = outcomes(events);
  const pending = events.filter(event => actionable(event)
    && !['resolved', 'dismissed'].includes(String(processing(event, task.id, results.get(event.id)).status))).length;
  let status = task.status === 'completed' && pending ? 'needs_review' : task.status;
  const current = events.filter(event => event.source === 'runtime'
    && event.data.revision === task.revision && event.data.control_version === task.control_version);
  const decision = current.findLast(event => event.event_type === 'reply_decision')?.data.decision ?? null;
  if (task.kind === 'reply' && status === 'review_ready' && !task.outcome_unknown) {
    const sent=store.db.prepare(`SELECT 1 FROM reply_drafts d JOIN approvals a ON a.id=d.approval_id
      JOIN delivery_records l ON l.action_id='reply-'||a.id WHERE d.task_id=? AND a.revision=? AND a.control_version=?
      AND json_extract(l.result,'$.write_status')='succeeded' LIMIT 1`).get(task.id,task.revision,task.control_version);
    if (sent || current.some(event => event.event_type === 'reply_sent')) status = 'reply_sent';
    else if (decision === 'skip') status = 'reply_skipped';
  }
  return { events, results, group: { ...task, worker_id: `worker:${task.id}`, event_count: events.length,
    pending_event_count: pending, processing_status: status, reply_decision: decision } };
}

function groupState(group: ReturnType<typeof groupProjection>['group']): string {
  const status = group.processing_status;
  if (group.outcome_unknown || ['paused', 'waiting_resource', 'failed'].includes(status)) return 'attention';
  if (['queued', 'running'].includes(status)) return 'active';
  if (['completed', 'reply_sent', 'reply_skipped'].includes(status)) return 'completed';
  return status === 'cancelled' ? 'closed' : 'review';
}

export function noActionReason(event: Pick<Event,'source'|'event_type'|'content'|'data'>): string | null {
  const data = event.data;
  const meta = fields(data.metadata);
  const attachments = Array.isArray(data.attachments) ? data.attachments.length > 0 : Boolean(data.attachments);
  if (event.source === 'redmine') {
    if (event.event_type !== 'issue.changed' || meta.issue_is_closed !== true || !data.issue_id
      || event.content.trim() || attachments || !Array.isArray(meta.details)) return null;
    const details = meta.details.map(fields);
    const status = (detail: Fields) => detail.property === 'attr' && detail.name === 'status_id';
    return details.every(detail => status(detail) || detail.property === 'cf') && details.some(status)
      ? 'redmine_closed_status_notice' : null;
  }
  if (event.source !== 'dingtalk' || event.event_type !== 'message.received' || data.issue_id || attachments
    || meta.reply_to_message_id || meta.quoted_message
    || (Array.isArray(meta.forward_messages) ? meta.forward_messages.length > 0 : meta.forward_messages)
    || meta.needs_confirmation || (Array.isArray(meta.uncertain_mentions)?meta.uncertain_mentions.length:meta.uncertain_mentions)) return null;
  const content = event.content.trim();
  if (meta.sender_name === '考勤小助手' && /^(?:考勤小助手\s*)?请查收你的(?:上周|本周)考勤统计/.test(content)) {
    return 'attendance_notice';
  }
  return !meta.at_me && /^(?:好|好的|可以|收到|嗯|OK)[。！!\s]*$/i.test(content) ? 'acknowledgement_only' : null;
}

const closedReceiptStatuses = ['ignored', 'self_echo', 'dismissed'];
const unassignedSources = `task_id IS NULL AND source IN ('dingtalk', 'redmine') AND external_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM event_targets target WHERE target.event_id=events.id)`;

export function nextTriageNotice(store: WorkbenchStore, eventId?: number): number | undefined {
  const rows = store.db.prepare(`SELECT id,source,event_type,content,data FROM events WHERE ${unassignedSources}
    AND json_extract(data,'$.routing_status')='pending_confirmation'
    AND json_extract(data,'$.routing_reason') IS NOT 'private_policy_hold'
    AND (? IS NULL OR id=?) AND NOT EXISTS (SELECT 1 FROM feishu_triage_notices n
      WHERE n.event_id=events.id AND n.status!='retrying') ORDER BY id`).iterate(eventId ?? null, eventId ?? null);
  for (const row of rows) {
    const event = { source: String(row.source), event_type: String(row.event_type), content: String(row.content),
      data: fields(JSON.parse(String(row.data))) };
    if (!noActionReason(event)) return Number(row.id);
  }
}

function receiptView(event: Event) {
  const status = event.data.routing_status;
  const reason = noActionReason(event);
  const explicitlyClosed = closedReceiptStatuses.includes(String(status));
  const state = explicitlyClosed || ((status == null || status === 'pending_confirmation') && reason)
    ? 'closed' : status === 'semantic_pending' ? 'active' : 'triage';
  return { ...event, state, triage_reason: (state === 'closed' && !explicitlyClosed ? reason : null)
    ?? event.data.routing_reason ?? null };
}

function receiptBundles(rows: Event[]): Event[][] {
  const parents = new Map(rows.map(row => [row.id, row.id]));
  const messageIds = new Map<string, number[]>();
  const issues = new Map<string, number>();
  const siblings = new Map<string, number>();
  const buckets = new Map<number, Event[]>();

  function root(id: number): number {
    while (parents.get(id) !== id) {
      const grandparent = parents.get(parents.get(id)!)!;
      parents.set(id, grandparent);
      id = grandparent;
    }
    return id;
  }
  function join(left: number, right: number) {
    const a = root(left);
    const b = root(right);
    parents.set(Math.max(a, b), Math.min(a, b));
  }
  function reference(row: Event, field: string): string | undefined {
    const meta = fields(row.data.metadata);
    const parts = [meta.profile, row.data.thread_id, meta[field]];
    if (row.source === 'dingtalk' && !meta.needs_confirmation
      && parts.every(part => typeof part === 'string' && part)) return JSON.stringify(parts);
  }
  for (const row of rows) {
    const key = reference(row, 'message_id');
    if (key) {
      const matches = messageIds.get(key) ?? [];
      matches.push(row.id);
      messageIds.set(key, matches);
    }
    const endpoint = fields(row.data.metadata).redmine_endpoint;
    const issue = String(row.data.issue_id || '');
    if (row.source === 'redmine' && typeof endpoint === 'string' && endpoint && /^\d+$/.test(issue)) {
      const issueKey = JSON.stringify([endpoint, issue]);
      const firstId = issues.get(issueKey) ?? row.id;
      join(row.id, firstId);
      issues.set(issueKey, firstId);
    }
  }
  for (const row of rows) {
    const key = reference(row, 'reply_to_message_id');
    if (!key || key === reference(row, 'message_id')) continue;
    const anchors = messageIds.get(key);
    if (anchors?.length === 1 && anchors[0] < row.id) join(row.id, anchors[0]);
    if (!anchors) {
      const firstId = siblings.get(key) ?? row.id;
      join(row.id, firstId);
      siblings.set(key, firstId);
    }
  }
  for (const row of rows) {
    const id = root(row.id);
    const bucket = buckets.get(id) ?? [];
    bucket.push(row);
    buckets.set(id, bucket);
  }
  return [...buckets.values()];
}

interface IndexItem {
  key: string;
  group: ReturnType<typeof groupProjection>['group'] | null;
  event?: Fields;
  state: string;
  messages: Event[];
}

function visibleTasks(store: WorkbenchStore, principal: Principal, project?: number) {
  const tasks = project === undefined ? store.rows<Task>('tasks', 'ORDER BY id DESC')
    : store.rows<Task>('tasks', 'WHERE project_id = ? ORDER BY id DESC', project);
  return tasks.filter(task => store.allowedWorker(task, principal));
}

function indexGroup(store: WorkbenchStore, task: Task): IndexItem {
  const { group, events, results } = groupProjection(store, task);
  return { key: `group:${task.id}`, group, state: groupState(group),
    messages: events.filter(visibleMessage).map(event => eventView(event, task.id, results.get(event.id))) };
}

function casefold(input: string): string {
  return [...input].map(char => {
    if (char === 'ı') return char;
    if (char === 'ẞ') return 'ss';
    const upper = char.toUpperCase();
    // Unicode case folding uses uppercase for Cherokee and expands ligatures.
    return /[\u13a0-\u13ff]/u.test(upper) ? upper : upper.toLowerCase();
  }).join('');
}

function index(store: WorkbenchStore, principal: Principal, query: Fields, feishuTriageEnabled: boolean) {
  const { start, limit } = page(query, 'offset', 30);
  const project = query.project_id === undefined ? undefined : integer(query.project_id, 'project_id');
  const search = casefold(queryText(query.q, 'q').trim());
  const source = queryText(query.source, 'source');
  const status = queryText(query.status, 'status');
  const eventId = query.event_id === undefined ? undefined : integer(query.event_id, 'event_id');
  let items = visibleTasks(store, principal, project).map(task => indexGroup(store, task));
  if (principal.role === 'admin' && project === undefined) {
    const unassigned = store.rows<Event>('events', `WHERE ${unassignedSources} ORDER BY id`);
    for (const rows of receiptBundles(unassigned)) {
      const first = rows[0];
      const messages = rows.map(receiptView);
      const state = ['triage', 'active', 'closed'].find(value => messages.some(event => event.state === value))!;
      items.push({ key: `message:${first.id}`, group: null, state, messages,
        event: { id: first.id, project_id: null, worker_id: null, project_assessment: first.data.project_assessment ?? null } });
    }
  }
  if (eventId !== undefined) items = items.filter(item => item.messages.some(event => event.id === eventId));
  if (search) items = items.filter(item => casefold([item.group?.title ?? '', ...item.messages.map(e => e.content)]
    .join('\n')).includes(search));
  if (source) items = items.filter(item => item.messages.some(event => event.source === source));
  const counts: Record<string, number> = {};
  for (const item of items) counts[item.state] = (counts[item.state] ?? 0) + 1;
  if (query.counts_only === '1') return { counts };
  if (status === 'needs_action') items = items.filter(item => ['review', 'attention'].includes(item.state));
  else if (status === 'finished') items = items.filter(item => ['completed', 'closed'].includes(item.state));
  else if (['triage', 'active', 'closed'].includes(status)) items = items.filter(item => item.state === status);
  else if (status) items = items.filter(item => item.state === status || item.group?.processing_status === status
    || (!item.group && item.messages.some(event => event.data.routing_status === status)));
  const latest = (item: IndexItem) => item.messages.length
    ? item.messages.reduce((value, event) => event.created_at > value ? event.created_at : value, '')
    : item.group?.updated_at ?? '';
  const descending = (a: string, b: string) => a === b ? 0 : a > b ? -1 : 1;
  const ordered = items.map(item => ({ item, latest: latest(item) }))
    .sort((a, b) => Number(a.item.state === 'closed') - Number(b.item.state === 'closed')
      || descending(a.latest, b.latest) || descending(a.item.key, b.item.key));
  const notice = store.db.prepare('SELECT status FROM feishu_triage_notices WHERE event_id=?');
  return { items: ordered.slice(start, start + limit).map(({ item }) => item.state !== 'triage' || item.group ? item : {
    ...item, messages: item.messages.map(event => ({ ...event,
      triage_notice_status: notice.get(event.id)?.status ?? (feishuTriageEnabled ? null : 'disabled') })),
  }), total: items.length,
    counts, has_more: start + limit < items.length };
}

function ownedGroup(store: WorkbenchStore, id: number, principal: Principal): Task {
  const task = store.row<Task>('tasks', 'id', id);
  if (!task || !store.allowedWorker(task, principal)) fail(404, '事件组不存在');
  return task;
}

function advance(store: WorkbenchStore, task: Task, expected: number): void {
  if (task.outcome_unknown) fail(409, '执行结果未知，请先核验');
  const updated = store.db.prepare(`UPDATE tasks SET state_version = state_version + 1, updated_at = ?
    WHERE id = ? AND state_version = ?`).run(now(), task.id, expected);
  if (updated.changes !== 1) fail(409, '事件组已变化，请刷新');
}

function followEnabled(input: unknown): boolean {
  if (typeof input === 'boolean') return input;
  if (typeof input !== 'string' && typeof input !== 'number') fail(422, 'enabled 无效');
  const value = String(input).toLowerCase();
  if (['1', 'on', 't', 'true', 'y', 'yes'].includes(value)) return true;
  if (['0', 'off', 'f', 'false', 'n', 'no'].includes(value)) return false;
  return fail(422, 'enabled 无效');
}

function createTriageTask(store: WorkbenchStore, body: Fields, kind: string, actor: string): number {
  const id = body.project_id == null ? 0 : integer(body.project_id, 'project_id');
  const project = store.row('projects', 'id', id);
  if (!project?.enabled || project.archived) fail(422, '请选择可用项目');
  const title = requiredText(body.title, 300, '请填写事件名称和处理要求').trim();
  const goal = requiredText(body.goal, 20000, '请填写事件名称和处理要求').trim();
  const time = now();
  const task = store.db.prepare(`INSERT INTO tasks (project_id, owner_id, title, goal, kind, source,
    acceptance_criteria, status, revision, state_version, control_version, outcome_unknown, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'web', '', 'queued', 1, 1, 1, 0, ?, ?) RETURNING id`).get(id, actor, title, goal, kind, time, time);
  const taskId = Number(task?.id);
  store.db.prepare('INSERT INTO governance_task_owners(task_id,user_id) VALUES (?,?)').run(taskId, actor);
  store.audit(actor, 'task.assign', taskId, { user_id: actor });
  return taskId;
}

const triageStates = ['queued', 'paused', 'waiting_input', 'review_ready', 'failed'];

function linkTriageTask(store: WorkbenchStore, body: Fields, principal: Principal): number {
  if (body.group_id == null || body.expected_state_version == null) fail(422, '请选择要关联的已有事件');
  const id = integer(body.group_id, 'group_id');
  const task = ownedGroup(store, id, principal);
  const project = store.row('projects', 'id', task.project_id);
  if (!project?.enabled || project.archived || !triageStates.includes(task.status)) {
    fail(409, '请选择可补充消息的事件，执行中的事件请先暂停');
  }
  advance(store, task, integer(body.expected_state_version, 'expected_state_version'));
  store.db.prepare(`UPDATE tasks SET revision = revision + 1, control_version = control_version + 1,
    last_error = CASE WHEN status = 'review_ready' THEN '收到人工关联的消息，请确认后继续' ELSE last_error END,
    status = CASE WHEN status = 'review_ready' THEN 'waiting_input' ELSE status END WHERE id = ?`).run(id);
  store.db.prepare("UPDATE approvals SET status='expired' WHERE task_id=? AND status='pending'").run(id);
  return id;
}

function linkTriageReceipt(store: WorkbenchStore, row: Event, id: number, actor: string) {
  const input = { source_event_id: row.id, routing_status: 'manually_linked', actor };
  const message = store.db.prepare(`INSERT INTO events (task_id, source, event_type, content, data, created_at)
    VALUES (?, ?, 'message', ?, ?, ?)`).run(id, row.source, row.content, JSON.stringify(input), now());
  store.db.prepare(`INSERT INTO event_targets (event_id, task_id, message_event_id, created_at)
    VALUES (?, ?, ?, ?)`).run(row.id, id, message.lastInsertRowid, now());
  const meta = fields(row.data.metadata);
  if (row.source !== 'dingtalk' || !meta.profile || !meta.message_id || !row.data.thread_id) return {};
  const declared = Array.isArray(row.data.attachments) ? row.data.attachments : [];
  const attachments = declared.length ? declared : /\[图片消息\]\s*\(mediaId=[^\s)]+\)/u.test(row.content)
    ? [{ kind: 'image', source: 'dingtalk_message' }] : [];
  if (!attachments.length) return {};
  store.db.prepare(`INSERT INTO event_attachment_jobs (event_id, task_id, revision, control_version, status, results)
    SELECT ?, id, revision, control_version, 'pending', '[]' FROM tasks WHERE id = ?`).run(row.id, id);
  store.db.prepare("UPDATE tasks SET status='waiting_resource',last_error='正在准备来源附件' WHERE id=? AND status='queued'").run(id);
  return { attachments, attachments_status: 'pending' };
}

function triage(store: WorkbenchStore, body: Fields, principal: Principal) {
  const { action } = body;
  const kind = body.kind === undefined ? 'analysis' : body.kind;
  if (action !== 'close' && action !== 'create' && action !== 'link') fail(422, 'action 无效');
  if (kind !== 'analysis' && kind !== 'repair' && kind !== 'reply') fail(422, 'kind 无效');
  if (!Array.isArray(body.event_ids) || !body.event_ids.length || body.event_ids.length > 100) fail(422, 'event_ids 无效');
  const ids = [...new Set(body.event_ids.map(id => integer(id, 'event_id')))];
  const inList = '(' + ids.map(() => '?').join(',') + ')';
  const bind = (query: string, ...parameters: SQLInputValue[]) => store.db.prepare(query).run(...parameters);
  return store.write(() => {
    const rows = store.rows<Event>('events', `WHERE id IN ${inList} ORDER BY id`, ...ids);
    const linked = store.db.prepare(`SELECT 1 FROM event_targets WHERE event_id IN ${inList} LIMIT 1`).get(...ids);
    if (rows.length !== ids.length || linked || rows.some(row => row.task_id != null || !row.external_id
      || !externalSources.has(row.source))) fail(409, '所选消息已关联或不可处理，请刷新事件');
    const jobs = store.rows('semantic_routing_jobs', `WHERE event_id IN ${inList}`, ...ids);
    if (jobs.some(job => job.status === 'running')) fail(409, '正在识别所选消息，请稍后刷新');
    if (action !== 'close' && rows.some(row => fields(row.data.metadata).self_authored
      || ['self_echo', 'self_echo_candidate'].includes(String(row.data.routing_status)))) {
      fail(409, '本账号发言和渠道回声不能作为新的处理来源');
    }
    const taskId = action === 'create' ? createTriageTask(store, body, kind, principal.user_id)
      : action === 'link' ? linkTriageTask(store, body, principal) : null;
    const status = taskId === null ? 'dismissed' : 'manually_linked';
    const messages = rows.map(row => {
      const attachment = taskId === null ? {} : linkTriageReceipt(store, row, taskId, principal.user_id);
      const data = { ...row.data, ...attachment, routing_status: status,
        routing_reason: taskId === null ? 'closed_manually' : 'linked_manually',
        triage_actor: principal.user_id, triaged_at: now() };
      bind('UPDATE events SET task_id=?, data=? WHERE id=?', taskId, JSON.stringify(data), row.id);
      store.audit(principal.user_id, 'event.triage.' + action, row.id,
        { task_id: taskId, source: row.source, external_id: row.external_id, status });
      return receiptView({ ...row, task_id: taskId, data });
    });
    for (const job of jobs) {
      if (job.status !== 'queued' || typeof job.event_id !== 'number') continue;
      bind("UPDATE semantic_routing_jobs SET status='closed' WHERE event_id=?", job.event_id);
      bind("UPDATE event_routing_sessions SET status='idle',state_version=state_version+1 WHERE event_id=?", job.event_id);
    }
    return taskId === null ? { messages } : indexGroup(store, store.required<Task>('tasks', taskId));
  });
}

export function registerEventGroups(app: FastifyInstance, store: WorkbenchStore): void {
  upgradeTriageNotices(store.db);
  const root = '/api/v1/event-groups';
  app.get(root, request => visibleTasks(store, principalOf(request)).map(task => groupProjection(store, task).group));
  app.get(`${root}/index`, request => index(store, principalOf(request), fields(request.query), app.hasDecorator('feishuTriageDelivery')));
  app.post(`${root}/triage`, request => triage(store, fields(request.body),
    requireAdmin(request, '仅管理员可处理未分派的来源消息')));
  app.post<{ Params: { id: string } }>(`${root}/:id/sync-own-dingtalk`, async request => {
    const principal = requireAdmin(request, '仅管理员可从已连接钉钉同步消息');
    const id = integer(request.params.id, 'id');
    return syncDingTalkHistory(store, id, () => groupEvents(store, ownedGroup(store, id, principal).id),
      principal.user_id, workbenchRuntime(app));
  });
  app.get(`${root}/triage-options`, request => {
    requireAdmin(request, '仅管理员可处理未分派的来源消息');
    const projects = store.rows('projects', 'WHERE enabled = 1 AND archived = 0 ORDER BY name');
    const names = new Map(projects.map(p => [p.id, p.name]));
    const groups = store.rows<Task>('tasks', `WHERE outcome_unknown = 0
      AND status IN ('queued', 'paused', 'waiting_input', 'review_ready', 'failed') ORDER BY id DESC`);
    return { projects: projects.map(({ id, name }) => ({ id, name })),
      groups: groups.filter(t => names.has(t.project_id)).map(t => ({
        id: t.id, title: t.title, project: names.get(t.project_id), state_version: t.state_version,
      })) };
  });
  app.get<{ Params: { id: string } }>(`${root}/:id`, request => {
    const principal = principalOf(request);
    const id = integer(request.params.id, 'id');
    const { group, events, results } = groupProjection(store, ownedGroup(store, id, principal));
    return { group, events: events.map(event => eventView(event, id, results.get(event.id))),
      following: store.rows('worker_subscriptions', 'WHERE task_id = ? ORDER BY id', id) };
  });
  app.post<{ Params: { id: string; event_id: string } }>(`${root}/:id/events/:event_id/resolution`, request => {
    const principal = principalOf(request);
    const id = integer(request.params.id, 'id');
    const eventId = integer(request.params.event_id, 'event_id');
    const { status, evidence, expected_state_version: expected } = fields(request.body);
    if (status !== 'resolved' && status !== 'dismissed' && status !== 'pending') fail(422, 'status 无效');
    const content = requiredText(evidence, 10000, '请填写处理依据');
    const version = integer(expected, 'expected_state_version');
    return store.write(() => {
      const task = ownedGroup(store, id, principal);
      const event = groupEvents(store, id).find(row => row.id === eventId);
      if (!event || !actionable(event)) fail(404, '事件不属于当前事件组');
      advance(store, task, version);
      const outcome = { status, evidence: content, actor: principal.user_id, at: now() };
      store.addEvent(id, 'event_resolution', content, { event_id: eventId, ...outcome });
      return eventView(event, id, outcome);
    });
  });
  app.post<{ Params: { id: string; subscription_id: string } }>(`${root}/:id/following/:subscription_id`, request => {
    const principal = principalOf(request);
    const id = integer(request.params.id, 'id');
    const subscriptionId = integer(request.params.subscription_id, 'subscription_id');
    const body = fields(request.body);
    const enabled = followEnabled(body.enabled);
    const expected = integer(body.expected_state_version, 'expected_state_version');
    return store.write(() => {
      const task = ownedGroup(store, id, principal);
      const subscription = store.row('worker_subscriptions', 'id', subscriptionId);
      if (!subscription || subscription.task_id !== id) fail(404, '跟进关系不存在');
      if (enabled && terminal.has(task.status)) fail(409, '事件组已结束');
      advance(store, task, expected);
      store.db.prepare('UPDATE worker_subscriptions SET enabled = ? WHERE id = ?').run(Number(enabled), subscriptionId);
      store.addEvent(id, 'following_changed', enabled ? '恢复持续跟进' : '停止持续跟进',
        { subscription_id: subscriptionId, enabled });
      return { ...subscription, enabled };
    });
  });
  app.post<{ Params: { id: string } }>(`${root}/:id/rename`, request => {
    const principal = principalOf(request);
    const id = integer(request.params.id, 'id');
    const body = fields(request.body);
    const title = requiredText(body.title, 300, '事件名称不能为空').trim();
    const expected = integer(body.expected_state_version, 'expected_state_version');
    return store.write(() => {
      const task = ownedGroup(store, id, principal);
      const result = store.db.prepare(`UPDATE tasks SET title = ?, state_version = state_version + 1, updated_at = ?
        WHERE id = ? AND state_version = ?`).run(title, now(), id, expected);
      if (result.changes !== 1) fail(409, '事件已变化，请刷新后重命名');
      store.addEvent(id, 'group_renamed', title, { previous_title: task.title, actor: principal.user_id });
      return store.required<Task>('tasks', id);
    });
  });
  app.post<{ Params: { id: string } }>(`${root}/:id/delegations`, request => {
    const principal = principalOf(request);
    const id = integer(request.params.id, 'id');
    const body = fields(request.body);
    const goal = requiredText(body.goal, 20000, '请填写协作目标');
    const requestKey = body.request_key;
    if (typeof requestKey !== 'string' || !requestKey.length || [...requestKey].length > 100) fail(422, 'request_key 无效');
    const kind = body.kind === undefined ? 'analysis' : body.kind;
    if (kind !== 'analysis' && kind !== 'repair') fail(422, 'kind 无效');
    const expected = integer(body.expected_state_version, 'expected_state_version');
    const submitted = { goal, request_key: requestKey, kind, expected_state_version: expected };
    const key = `${id}:${requestKey}`;
    return store.write(() => {
      const task = ownedGroup(store, id, principal);
      const previous = store.rows<Event>('events', "WHERE source = 'coordination' AND external_id = ?", key)[0];
      if (previous) {
        if (!isDeepStrictEqual(previous.data.request, submitted)) fail(409, '请求键已用于其他内容');
        return previous;
      }
      if (terminal.has(task.status)) fail(409, '已结束的事件组不能委派');
      if (!store.row('projects', 'id', task.project_id)?.enabled) fail(409, '项目已禁用');
      advance(store, task, expected);
      const owner = store.taskOwner(task);
      if (typeof owner !== 'string') fail(409, '无法确认任务所有者');
      const time = now();
      const child = store.db.prepare(`INSERT INTO tasks
        (project_id, owner_id, title, goal, kind, acceptance_criteria, status, source, revision,
          control_version, state_version, outcome_unknown, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, '返回证据与未完成事项，由主 Worker 汇总核验。', 'queued', 'web', 1, 1, 1, 0, ?, ?)
        RETURNING id`).get(task.project_id, owner, `协作：${[...goal].slice(0, 100).join('')}`, goal, kind, time, time);
      const childId = Number(child?.id);
      store.addEvent(childId, 'created', goal, { parent_group_id: id });
      const data = { child_group_id: childId, request: submitted, status: 'pending' };
      const { lastInsertRowid } = store.db.prepare(`INSERT INTO events (task_id, source, external_id, event_type, content, data, created_at)
        VALUES (?, 'coordination', ?, 'collaboration_requested', ?, ?, ?)`).run(id, key, goal, JSON.stringify(data), now());
      return store.required<Event>('events', Number(lastInsertRowid));
    });
  });
}
