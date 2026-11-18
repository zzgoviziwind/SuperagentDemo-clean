import { createHash } from 'node:crypto';
import { z } from 'zod';
import { accessSchema, admission, selectAdmissionProject } from '../admission.js';
import { roleOf } from '../auth.ts';
import { evaluateRules } from '../rules.js';
import { settings } from '../settings.js';
import { noActionReason } from './event-groups.ts';
import type { SemanticDecision } from './runtime.ts';
import type { Event, Fields, Task, WorkbenchStore } from './store.ts';
import { fields, now } from './store.ts';

const routingSources = new Set(['dingtalk', 'redmine']);
const allowedKinds = new Set(['analysis', 'repair', 'reply']);
const appendable = new Set(['queued', 'paused', 'waiting_input', 'review_ready', 'failed']);

const decisionSchema = z.strictObject({
  action: z.enum(['create', 'dispatch', 'ignore', 'confirm']),
  kind: z.enum(['analysis', 'repair', 'reply']),
  task_id: z.int().positive().nullable(),
  state_version: z.int().positive().nullable(),
  reason: z.string().trim().min(1).max(2000),
}).refine(d => d.action === 'dispatch' ? d.task_id !== null && d.state_version !== null
  : d.task_id === null && d.state_version === null);

export function modelDecision(value: unknown): SemanticDecision | undefined {
  const result = decisionSchema.safeParse(value);
  return result.success ? result.data : undefined;
}

export interface Admission {
  project: Fields & { id: number; name: string };
  actor: string;
  role: 'admin' | 'member';
  thread?: string;
  externalActor?: string;
  reference?: string;
  fixedTarget?: number;
  candidates: { id: number; title: string; kind: string; state_version: number }[];
}

const string = (value: unknown) => typeof value === 'string' && value ? value : undefined;
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const readOnly = /仅(?:做)?分析|只(?:做)?分析|只读|分析即可|(?:不要|不允许|禁止|不)(?:修改|改动|改写|调整)(?:(?:任何)?(?:代码|文件)|(?=[，。,；;\s]|$))/gu;
const writeRequest = /修复|修改|改动|改写|实现|新增|优化|调整|增加功能|\b(fix|implement|modify)\b/iu;

function intent(text: string) {
  const read = [...text.matchAll(readOnly)].length > 0;
  const write = writeRequest.test(text.replaceAll(readOnly, ''));
  return read && write ? 'conflict' : write ? 'repair' : read ? 'analysis' : undefined;
}

function rulesAllow(store: WorkbenchStore, event: Event, auth: Admission, kind: string): boolean {
  const blocked = evaluateRules(store.db, event.source, auth.project.id, kind,
    { thread_id: auth.thread, actor_id: auth.externalActor });
  return !blocked.has('pause') && !blocked.has('quiet');
}

function references(store: WorkbenchStore, event: Event, projectId: number, profile: string, thread?: string) {
  const data = event.data;
  const meta = fields(data.metadata);
  const issue = data.issue_id == null || data.issue_id === '' ? undefined : String(data.issue_id);
  const issues = new Set([...event.content.matchAll(/#(\d+)\b/g)].map(match => match[1]));
  if (issue) issues.add(issue);
  if (issues.size > 1 || [...issues].some(id => !/^\d+$/.test(id))) return;
  const ref = issues.size ? 'issue:' + [...issues][0] : undefined;
  const quote = meta.reply_to_message_id;
  const targets = new Set<number>();
  if (ref) {
    const existing = store.db.prepare('SELECT task_id FROM task_routes WHERE project_id=? AND route_key=?').get(projectId, ref);
    if (typeof existing?.task_id === 'number') targets.add(existing.task_id);
  }
  if (event.source === 'dingtalk' && quote != null) {
    if (!thread || typeof quote !== 'string' || !quote.trim() || quote.length > 255 || quote === meta.message_id) return;
    const matched = store.db.prepare(`SELECT DISTINCT e.task_id FROM events e JOIN tasks t ON t.id=e.task_id
      WHERE e.source='dingtalk' AND t.project_id=? AND json_extract(e.data,'$.thread_id')=?
      AND COALESCE(json_extract(e.data,'$.metadata.profile'),'')=? AND json_extract(e.data,'$.metadata.message_id')=?
      AND json_extract(e.data,'$.routing_status') IN ('routed','manually_linked','self_context')`).all(projectId, thread, profile, quote);
    if (matched.length !== 1) return;
    targets.add(Number(matched[0].task_id));
  }
  if (thread) {
    for (const row of store.db.prepare(`SELECT s.task_id FROM worker_subscriptions s JOIN tasks t ON t.id=s.task_id
      WHERE s.enabled AND s.project_id=? AND t.project_id=s.project_id AND s.source=? AND s.thread_id=? AND s.profile=?
      AND t.status NOT IN ('completed','cancelled')`).all(projectId, event.source, thread, profile)) targets.add(Number(row.task_id));
  }
  // The deterministic intake owns multi-target fanout. A model must not pick one recipient of a fanout.
  if (targets.size > 1) return;
  return { reference: ref, fixedTarget: [...targets][0] };
}

function sourceAdmission(store: WorkbenchStore, event: Event, env: NodeJS.ProcessEnv, resolve?: typeofRole) {
  const data = event.data;
  const metadata = fields(data.metadata);
  const uncertain = metadata.uncertain_mentions;
  const externalActor = string(data.actor_id);
  const thread = string(data.thread_id);
  if (!routingSources.has(event.source) || !event.external_id || !externalActor || !event.content.trim()
    || metadata.self_authored || (Array.isArray(uncertain) ? uncertain.length > 0 : Boolean(uncertain))
    || metadata.needs_confirmation || noActionReason(event)
    || intent(event.content) === 'conflict'
    || !((event.source === 'dingtalk' ? ['message.received'] : ['issue.comment', 'issue.changed', 'issue.updated'])
      .includes(string(data.original_event_type) ?? event.event_type))) return;
  const cfg = settings(store.db);
  const policy = fields(cfg.dingtalk_response_policy);
  const access = accessSchema.safeParse(cfg.dingtalk_request_access);
  const hasAccess = event.source === 'dingtalk' && cfg.dingtalk_request_access != null;
  if (hasAccess && !access.success) return;
  const effectiveAccess = hasAccess && access.success ? access.data : null;
  const source = { source: event.source, actor_id: externalActor, thread_id: thread, content: event.content, metadata };
  const { actor, candidates } = admission(store.db, source, effectiveAccess);
  if (typeof actor?.user_id !== 'string') return;
  const role = resolve ? resolve(actor.user_id) : roleOf(env, actor.user_id);
  if ((role !== 'admin' && role !== 'member') || !list(JSON.parse(String(actor.permissions ?? '[]'))).includes('request')) return;
  const direct = event.source === 'dingtalk' && metadata.dws_event_type === 'user_im_message_receive_o2o_all';
  if (event.source === 'dingtalk') {
    if (direct ? policy.direct_messages === 'off' : policy.group_messages === 'off'
      || (policy.group_messages === 'mentions' && metadata.at_me !== true)
      || (policy.group_messages === 'requests' && policy.group_scope === 'selected' && !list(policy.group_chat_ids).includes(thread))) return;
    if (!direct && !(cfg.dingtalk_route_all_mentions === true && metadata.at_me === true)
      && !/[？?]|请|分析|排查|检查|修复|修改|实现|新增|调整/u.test(event.content)) return;
  }
  return { source, actor: actor.user_id, role, grants: list(JSON.parse(String(actor.project_ids ?? '[]'))),
    direct, policy, effectiveAccess, candidates, externalActor, thread, metadata };
}

function currentBinding(store: WorkbenchStore, event: Event, scope: NonNullable<ReturnType<typeof sourceAdmission>>) {
  const { source, direct, policy, effectiveAccess, candidates } = scope;
  const data = event.data;
  const externalProject = string(data.project_external_id);
  const key = event.source === 'dingtalk' ? 'dingtalk_chat_ids' : 'redmine_project_ids';
  let projects = externalProject ? store.rows('projects', `WHERE archived=0 AND EXISTS (
    SELECT 1 FROM json_each(${key}) WHERE CAST(value AS TEXT)=?)`, externalProject) : [];
  if (!projects.length && direct && typeof policy.default_project_id === 'number') {
    projects = store.rows('projects', 'WHERE id=? AND NOT archived', policy.default_project_id);
  }
  if (effectiveAccess) {
    const chosen = selectAdmissionProject(store.db, event.id, source, effectiveAccess, candidates ?? []);
    return { projects: chosen.projects, clarification: chosen.clarification };
  }
  return { projects, clarification: false };
}

export function admitSemantic(store: WorkbenchStore, event: Event, env: NodeJS.ProcessEnv): Admission | undefined {
  const scope = sourceAdmission(store, event, env);
  if (!scope) return;
  const { actor, role, grants, externalActor, thread, metadata } = scope;
  const { projects, clarification } = currentBinding(store, event, scope);
  if (clarification) return;
  if (projects.length !== 1 || !projects[0].enabled || typeof projects[0].id !== 'number' || projects[0].archived) return;
  const project = store.row<Admission['project']>('projects', 'id', projects[0].id)!;
  if (!grants.some(id => String(id) === String(project.id))) return;
  const pointers = references(store, event, project.id, string(metadata.profile) ?? '', thread);
  if (!pointers) return;
  const auth: Admission = { project, actor, role, thread, externalActor, ...pointers, candidates: [] };
  auth.candidates = store.rows<Task>('tasks', 'WHERE project_id=? ORDER BY updated_at DESC,id DESC LIMIT 100', project.id)
    .filter(task => appendable.has(task.status) && !task.outcome_unknown && allowedKinds.has(task.kind)
      && (role === 'admin' || store.taskOwner(task) === auth.actor)
      && (auth.fixedTarget === undefined || auth.fixedTarget === task.id) && rulesAllow(store, event, auth, task.kind))
    .map(({ id, title, kind, state_version }) => ({ id, title, kind, state_version }));
  return auth;
}

type typeofRole = (user: string) => ReturnType<typeof roleOf>;
export function unassignedContext(store: WorkbenchStore, event: Event, env: NodeJS.ProcessEnv,
  options: { allowBound?: boolean; resolveRole?: typeofRole } = {}) {
  const scope = sourceAdmission(store, event, env, options.resolveRole);
  const profile = scope?.metadata.profile;
  if (!scope?.direct || !scope.thread || typeof profile !== 'string' || !profile) return;
  const { projects } = currentBinding(store, event, scope);
  if (!options.allowBound && projects.length === 1 && projects[0].enabled) return;
  const { thread, externalActor, grants, actor } = scope;
  const at = Date.parse(event.created_at);
  if (!Number.isFinite(at)) return;
  const start = new Date(at - 7 * 86400_000).toISOString().replace('Z', '000+00:00');
  const profiles = store.rows('projects', `WHERE enabled AND NOT archived
    AND id IN (SELECT value FROM json_each(?)) ORDER BY id LIMIT 100`, JSON.stringify(grants))
    .filter(row => {
      const blocked = evaluateRules(store.db, event.source, Number(row.id), 'analysis',
        { thread_id: thread, actor_id: externalActor });
      return !blocked.has('pause') && !blocked.has('quiet');
    }).map(row => ({ id: row.id, name: row.name }));
  if (!profiles.length) return;
  const history = store.rows<Event>('events', `WHERE source='dingtalk' AND id<? AND external_id IS NOT NULL
    AND created_at>=? AND created_at<=? AND json_extract(data,'$.thread_id')=?
    AND json_extract(data,'$.metadata.profile')=? AND json_extract(data,'$.metadata.dws_event_type')='user_im_message_receive_o2o_all'
    AND (json_extract(data,'$.actor_id')=? OR json_extract(data,'$.metadata.self_authored')=1)
    ORDER BY id DESC LIMIT 30`, event.id, start, event.created_at, thread, profile, externalActor)
    .reverse().map(row => ({ event_id: row.id, time: row.data.occurred_at ?? row.created_at,
      direction: fields(row.data.metadata).self_authored === true ? 'own_account' : 'received',
      content: row.content.slice(0, 1500) }));
  return { mode: 'unassigned_project', project_id: null, event_id: event.id, actor,
    content: event.content.slice(0, 6000), conversation_type: 'direct', tasks: [],
    candidates: profiles, history, media_pending: list(event.data.attachments).length > 0 };
}

const assessmentSchema = z.strictObject({
  project_status: z.enum(['suggested', 'needs_context', 'no_project']),
  proposed_project_id: z.int().positive().nullable(),
  evidence_event_ids: z.array(z.int().positive()).max(10),
  reason: z.string().trim().min(1).max(2000),
  missing_context: z.string().max(1000),
});

export function validAssessment(value: unknown, snapshot: unknown, current: ReturnType<typeof unassignedContext>) {
  const parsed = assessmentSchema.safeParse(value);
  if (!parsed.success || !current) return;
  const decision = parsed.data;
  const before = fields(snapshot);
  const allowed = new Set([before.event_id, ...list(before.history).map(row => fields(row).event_id)]);
  const currentIds = new Set([current.event_id, ...current.history.map(row => row.event_id)]);
  if (decision.evidence_event_ids.some(id => !allowed.has(id) || !currentIds.has(id))) return;
  if (decision.project_status === 'suggested') {
    if (!decision.evidence_event_ids.length || !list(before.candidates).some(row => fields(row).id === decision.proposed_project_id)
      || !current.candidates.some(row => row.id === decision.proposed_project_id)) return;
  } else if (decision.proposed_project_id !== null
    || (decision.project_status === 'needs_context' && !decision.missing_context.trim())) return;
  return decision;
}

export function semanticContext(event: Event, auth: Admission) {
  return { mode: 'project_routing', project_id: auth.project.id, project_name: auth.project.name, tasks: auth.candidates,
    source: event.source, event_id: event.id, content: event.content.slice(0, 20_000),
    issue_id: event.data.issue_id ?? null, fixed_target: auth.fixedTarget ?? null };
}

export function semanticState(store: WorkbenchStore, event: Event, status: string, reason: string,
  extra: Fields = {}, taskId = event.task_id): void {
  const time = now();
  const history = list(event.data._lifecycle);
  const attempt = { attempt: history.length + 1, started_at: time, steps: [
    { stage: 'slow_filter', status: status === 'semantic_pending' ? 'pending' : 'passed',
      reason, at: time, detail: { routing_session_id: `semantic:${event.id}` } },
    { stage: 'router', status: status === 'routed' ? 'passed' : 'skipped', reason, at: time },
  ] };
  const data = { ...event.data, ...extra, routing_status: status, routing_reason: reason, _lifecycle: [...history, attempt] };
  store.db.prepare('UPDATE events SET data=?,task_id=? WHERE id=?').run(JSON.stringify(data), taskId, event.id);
}

function attach(store: WorkbenchStore, event: Event, auth: Admission, taskId: number, adding: boolean) {
  const time = now();
  let messageId = event.id;
  if (!adding) {
    const data = { ...event.data, source_event_id: event.id, routing_status: 'delivered', actor: auth.actor };
    messageId = Number(store.db.prepare(`INSERT INTO events(task_id,source,event_type,content,data,created_at)
      VALUES (?,?,'message',?,?,?)`).run(taskId, event.source, event.content, JSON.stringify(data), time).lastInsertRowid);
    store.db.prepare(`UPDATE tasks SET revision=revision+1,state_version=state_version+1,control_version=control_version+1,
      status=CASE WHEN status='paused' THEN status ELSE 'waiting_input' END,updated_at=? WHERE id=?`).run(time, taskId);
    store.db.prepare("UPDATE approvals SET status='expired' WHERE task_id=? AND status='pending'").run(taskId);
  }
  store.db.prepare('INSERT INTO event_targets(event_id,task_id,message_event_id,created_at) VALUES(?,?,?,?)')
    .run(event.id, taskId, messageId, time);
  if (list(event.data.attachments).length) {
    store.db.prepare(`INSERT INTO event_attachment_jobs(event_id,task_id,revision,control_version,status,results)
      SELECT ?,id,revision,control_version,'pending','[]' FROM tasks WHERE id=?`).run(event.id, taskId);
    store.db.prepare("UPDATE tasks SET status='waiting_resource',last_error='正在准备来源附件' WHERE id=? AND status='queued'").run(taskId);
  }
  semanticState(store, event, 'routed', 'semantic_applied', { actor: auth.actor, target_task_ids: [taskId],
    ...(list(event.data.attachments).length ? { attachments_status: 'pending' } : {}) }, taskId);
}

export function applyDecision(store: WorkbenchStore, event: Event, auth: Admission | undefined, decision: SemanticDecision,
  snapshot: unknown): { status: string; taskId?: number } {
  if (event.task_id !== null || event.data.routing_status === 'routed'
    || store.db.prepare('SELECT 1 FROM event_targets WHERE event_id=? LIMIT 1').get(event.id)) return { status: 'observed' };
  if (!auth || !rulesAllow(store, event, auth, decision.kind)) {
    semanticState(store, event, 'pending_confirmation', 'semantic_authorization_changed');
    return { status: 'rejected' };
  }
  if (decision.action === 'confirm' || decision.action === 'ignore') {
    semanticState(store, event, decision.action === 'ignore' ? 'ignored' : 'pending_confirmation',
      decision.action === 'ignore' ? 'semantic_ignored' : 'semantic_confirmation_required');
    return { status: decision.action === 'ignore' ? 'ignored' : 'rejected' };
  }
  if (decision.action === 'dispatch') {
    const candidates = list(fields(snapshot).tasks).map(fields);
    const target = auth.candidates.find(task => task.id === decision.task_id && task.state_version === decision.state_version);
    if (!target || !candidates.some(row => row.id === target.id && row.state_version === target.state_version)
      || !rulesAllow(store, event, auth, target.kind)) {
      semanticState(store, event, 'pending_confirmation', 'semantic_target_or_version_changed');
      return { status: 'rejected' };
    }
    attach(store, event, auth, target.id, false);
    return { status: 'applied', taskId: target.id };
  }
  if (decision.kind === 'repair' && intent(event.content) !== 'repair') {
    semanticState(store, event, 'pending_confirmation', 'semantic_write_not_explicit');
    return { status: 'rejected' };
  }
  if (auth.fixedTarget !== undefined) {
    semanticState(store, event, 'pending_confirmation', 'semantic_reference_requires_existing_target');
    return { status: 'rejected' };
  }
  const time = now();
  const reference = auth.reference ?? event.source + ':message:' + createHash('sha256').update(JSON.stringify(event.external_id)).digest('hex');
  const title = [...event.content.trim().split(/\r?\n/, 1)[0]].slice(0, 300).join('');
  const task = Number(store.db.prepare(`INSERT INTO tasks(project_id,owner_id,title,goal,kind,source,source_ref,
    acceptance_criteria,status,revision,state_version,control_version,outcome_unknown,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,'','queued',1,1,1,0,?,?)`)
    .run(auth.project.id, auth.actor, title, event.content, decision.kind, event.source, reference, time, time).lastInsertRowid);
  store.db.prepare('INSERT INTO governance_task_owners(task_id,user_id) VALUES(?,?)').run(task, auth.actor);
  store.db.prepare('INSERT INTO task_routes(project_id,route_key,task_id) VALUES(?,?,?)').run(auth.project.id, reference, task);
  attach(store, event, auth, task, true);
  return { status: 'applied', taskId: task };
}
