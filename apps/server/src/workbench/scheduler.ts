import { randomUUID } from 'node:crypto';
import { isAbsolute, join, relative } from 'node:path';
import { mkdir, realpath } from 'node:fs/promises';
import type { DatabaseSync } from 'node:sqlite';
import type { Lease } from '../../../../packages/storage/src/index.ts';
import { directory } from '../../../../packages/channels/resources.ts';
import { settleBudget } from '../budget.js';
import { roleOf } from '../auth.ts';
import type { TurnBinding } from '../../../../packages/runtime/index.ts';
import { invokeWorkbenchModel, pinnedWorkbenchDriver, type InvocationResult,
  type WorkbenchModelDriver, type WorkbenchModelKind } from './model-driver.ts';
import { workbenchModelPrompt, type PromptCatalog } from './prompts.ts';
import type { AssessmentImage, SemanticDecision, SessionBinding, WorkbenchRuntime } from './runtime.ts';
import { admitSemantic, applyDecision, modelDecision, semanticContext, semanticState,
  unassignedContext, validAssessment } from './semantic-engine.ts';
import { ensureSemantic } from './session-writes.ts';
import type { RoutingJob } from './sessions.ts';
import { fail, fields, now, type Event, type Fields, type Task, WorkbenchStore } from './store.ts';
import { localThreadReader } from './thread-reader.ts';
import { clearInterruptedAssessmentImages, stageAssessmentImages } from './source-images.ts';

export interface WorkbenchSchedulerOptions {
  lease: Lease;
  stateRoot: string;
  env?: NodeJS.ProcessEnv;
  driver?: WorkbenchModelDriver;
  pollMs?: number;
  timeoutMs?: number;
  ports?: Pick<WorkbenchRuntime, 'readThread' | 'readOwnDingTalk' | 'readOwnDingTalkImages' | 'hasStoppedSession' | 'hasStoppedWatchdog'>;
  stopWorker?(taskId: number): Promise<boolean>;
  workerPrompts?: () => PromptCatalog;
  onError?(error: unknown): void;
}

interface Work {
  id: string;
  kind: WorkbenchModelKind;
  scope: number;
  item: number | null;
  context: unknown;
  lastThread?: string;
  taskVersion?: number;
  actor?: string;
  projectId?: number;
}

export interface WorkbenchScheduler extends WorkbenchRuntime {
  recoverOnly(): void;
  start(): void;
  close(): Promise<void>;
  tick(): Promise<boolean>;
  workerPrompts?: () => PromptCatalog;
}

const restartReason = '服务重启，结果未知，请人工核验';
const semanticWaiting = new Set(['pending_confirmation', 'semantic_pending']);
const truncate = (x: unknown, max: number) => typeof x === 'string' ? x.slice(0, max) : '';

function assertLease(db: DatabaseSync, lease: Lease) {
  const row = db.prepare("SELECT owner,epoch,expires_at FROM controller_leases WHERE id='controller'").get();
  if (row?.owner !== lease.owner || row.epoch !== lease.epoch || Date.parse(String(row.expires_at)) <= Date.now()) {
    fail(409, '工作台控制器租约已丢失');
  }
}

export function enqueueSemanticReceipt(db: DatabaseSync, eventId: number, env: NodeJS.ProcessEnv = process.env): boolean {
  const store = new WorkbenchStore(db);
  if (!db.isTransaction) return store.write(() => enqueueSemanticReceipt(db, eventId, env));
  if (store.row('governance_settings', 'key', 'semantic_routing_enabled')?.value !== true) return false;
  const receipt = store.row<Event>('events', 'id', eventId);
  if (!receipt || receipt.task_id !== null || !semanticWaiting.has(String(receipt.data.routing_status))
    || store.db.prepare('SELECT 1 FROM event_targets WHERE event_id=? LIMIT 1').get(eventId)
    || store.row('semantic_routing_jobs', 'event_id', eventId)) return false;
  const auth = admitSemantic(store, receipt, env);
  const context = auth ? { ...semanticContext(receipt, auth), actor: auth.actor } : unassignedContext(store, receipt, env);
  if (!context) return false;
  const time = now();
  db.prepare(`INSERT INTO semantic_routing_jobs(event_id,project_id,status,context,output,created_at,updated_at)
    VALUES (?,?,'queued',?,'',?,?)`).run(eventId, auth?.project.id ?? 0, JSON.stringify(context), time, time);
  ensureSemantic(store, store.row<RoutingJob>('semantic_routing_jobs', 'event_id', eventId)!, time);
  semanticState(store, receipt, 'semantic_pending', 'semantic_job_queued');
  return true;
}

function createRun(store: WorkbenchStore, work: Work, source: string): void {
  const time = now();
  store.db.prepare(`INSERT INTO workbench_model_runs
    (id,kind,scope_id,item_id,lease_epoch,phase,status,evidence_source,created_at,updated_at)
    VALUES (?,?,?,?,(SELECT epoch FROM controller_leases WHERE id='controller'),'claimed','running',?,?,?)`)
    .run(work.id, work.kind, work.scope, work.item, source, time, time);
}

function setMessage(store: WorkbenchStore, table: 'router_messages' | 'event_routing_messages',
  id: number, state: string, extra: Fields = {}) {
  store.db.prepare(`UPDATE ${table} SET data=json_patch(data,?) WHERE id=?`)
    .run(JSON.stringify({ status: state, ...extra }), id);
}

function addMessage(store: WorkbenchStore, work: Work, role: string, content: string, data: Fields, suffix: string) {
  if (work.kind === 'semantic') {
    store.db.prepare(`INSERT INTO event_routing_messages(event_id,role,content,item_key,data,created_at)
      VALUES (?,?,?,?,?,?)`).run(work.scope, role, content, 'workbench:' + work.id + ':' + suffix, JSON.stringify(data), now());
  } else {
    store.db.prepare('INSERT INTO router_messages(project_id,role,content,data,created_at) VALUES (?,?,?,?,?)')
      .run(work.scope, role, content, JSON.stringify(data), now());
  }
}

export function createWorkbenchScheduler(db: DatabaseSync, options: WorkbenchSchedulerOptions): WorkbenchScheduler {
  if (!isAbsolute(options.stateRoot)) throw new Error('工作台需要绝对状态目录');
  const store = new WorkbenchStore(db);
  const env = options.env ?? process.env;
  const driver = options.driver ?? pinnedWorkbenchDriver(db, env);
  const pollMs = options.pollMs ?? 1000;
  const timeoutMs = options.timeoutMs ?? 120_000;
  if (!Number.isSafeInteger(pollMs) || pollMs < 0 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error('工作台轮询或超时参数无效');
  }
  let started = false;
  let closing = false;
  let active: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let scanAfter = 0;
  const shutdown = new AbortController();
  function write<T>(fn: () => T): T {
    return store.write(() => { assertLease(db, options.lease); return fn(); });
  }
  function flag(key: string) {
    return store.row('governance_settings', 'key', key)?.value === true;
  }
  function appendJob(event: Event): boolean {
    return enqueueSemanticReceipt(db, event.id, env);
  }
  function schedule(eventId?: number) {
    if (!flag('semantic_routing_enabled')) fail(409, '语义路由尚未启用');
    return write(() => {
      const rows = store.rows<Event>('events', `WHERE task_id IS NULL AND external_id IS NOT NULL
        AND source IN ('dingtalk','redmine') AND json_extract(data,'$.routing_status')='pending_confirmation'
        AND NOT EXISTS (SELECT 1 FROM semantic_routing_jobs WHERE event_id=events.id)
        AND (? IS NULL OR id=?) ORDER BY id LIMIT 100`, eventId ?? null, eventId ?? null);
      for (const row of rows) appendJob(row);
      return { checked: rows.length, routed_event_ids: [] };
    });
  }
  function scanIntake() {
    return write(() => {
      const rows = store.rows<Event>('events', `WHERE id>? AND task_id IS NULL AND external_id IS NOT NULL
        AND source IN ('dingtalk','redmine') AND json_extract(data,'$.routing_status')='pending_confirmation'
        AND NOT EXISTS (SELECT 1 FROM semantic_routing_jobs WHERE event_id=events.id)
        ORDER BY id LIMIT 100`, scanAfter);
      for (const row of rows) appendJob(row);
      scanAfter = rows.length === 100 ? rows[99].id : 0;
    });
  }

  function priorThread(kind: WorkbenchModelKind, scope: number, thread: unknown) {
    if (typeof thread !== 'string' || !thread) return;
    const known = db.prepare(`SELECT 1 FROM workbench_model_runs WHERE kind=? AND scope_id=? AND thread_id=?
      AND status='completed' AND tree_exited=1 LIMIT 1`).get(kind, scope, thread);
    return known ? thread : undefined;
  }

  function recover() {
    const reservations = write(() => {
      db.exec(`CREATE TABLE IF NOT EXISTS workbench_model_runs (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, scope_id INTEGER NOT NULL, item_id INTEGER,
        lease_epoch INTEGER NOT NULL, phase TEXT NOT NULL, status TEXT NOT NULL, evidence_source TEXT NOT NULL,
        thread_id TEXT, turn_id TEXT, reservation_id INTEGER, tree_exited INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_error TEXT
      );
      CREATE INDEX IF NOT EXISTS ix_workbench_model_runs_scope ON workbench_model_runs(kind,scope_id,created_at);
      CREATE UNIQUE INDEX IF NOT EXISTS uq_workbench_model_run_active ON workbench_model_runs(kind,scope_id) WHERE status='running';`);
      const records = db.prepare(`SELECT r.id,m.phase FROM governance_budget_reservations r
        JOIN workbench_model_runs m ON r.request_key='workbench:'||m.id
        WHERE r.account_id='global' AND r.status='reserved' AND m.status IN ('running','unknown')`).all();
      const time = now();
      for (const job of store.rows<RoutingJob>('semantic_routing_jobs', "WHERE status='running'")) {
        const event = store.row<Event>('events', 'id', job.event_id);
        if (event?.data.routing_status === 'semantic_pending') semanticState(store, event, 'pending_confirmation', 'semantic_unknown');
        ensureSemantic(store, job, time);
        db.prepare("UPDATE semantic_routing_jobs SET status='unknown',error=?,updated_at=? WHERE event_id=?")
          .run(restartReason, time, job.event_id);
      }
      db.prepare(`UPDATE event_routing_sessions SET status='unknown',outcome_unknown=1,last_error=?,
        state_version=state_version+1,updated_at=? WHERE status='running' OR event_id IN
          (SELECT event_id FROM semantic_routing_jobs WHERE status='unknown') AND NOT outcome_unknown`).run(restartReason, time);
      db.exec(`UPDATE event_routing_messages SET data=json_set(data,'$.status','held_after_unknown')
        WHERE event_id IN (SELECT event_id FROM event_routing_sessions WHERE outcome_unknown)
        AND json_extract(data,'$.status') IN ('queued','running');`);
      db.prepare(`UPDATE router_sessions SET status='waiting_resource',outcome_unknown=1,last_error=?,
        state_version=state_version+1,updated_at=? WHERE status='running' OR project_id IN (
        SELECT scope_id FROM workbench_model_runs WHERE status='running' AND kind='router')`).run(restartReason, time);
      db.exec(`UPDATE router_messages SET data=json_set(data,'$.status','held_after_unknown')
        WHERE project_id IN (SELECT project_id FROM router_sessions WHERE outcome_unknown)
        AND json_extract(data,'$.status') IN ('queued','running');`);
      db.prepare("UPDATE watchdog_runs SET status='unknown',conclusion=? WHERE status='running' OR json_extract(conclusion,'$.applied')='pause_requested'")
        .run(JSON.stringify({ reason: restartReason }));
      db.prepare("UPDATE workbench_model_runs SET status='unknown',last_error=?,updated_at=? WHERE status='running'")
        .run(restartReason, time);
      db.prepare(`UPDATE conversation_bridge_operations SET status='unknown',last_error=?,updated_at=? WHERE status='pending'`)
        .run(restartReason, time);
      return records;
    });
    for (const reservation of reservations) {
      const mayHaveSent = reservation.phase === 'turn_intent' || reservation.phase === 'turn_bound';
      settleBudget(db, Number(reservation.id), mayHaveSent ? null : 0,
        mayHaveSent ? null : { source: 'local_pre_dispatch', evidence: '重启时记录未到派发阶段' }, 'workbench');
    }
    try {
      const interrupted = db.prepare("SELECT id FROM workbench_model_runs WHERE kind='assessment' AND status='unknown'").all();
      clearInterruptedAssessmentImages(options.stateRoot, interrupted.map(row => String(row.id)));
    } catch (error) { options.onError?.(error); }
  }

  function claimSemantic(): Work | undefined {
    if (!flag('semantic_routing_enabled')) return;
    return write(() => {
      const queued = store.rows<RoutingJob>('semantic_routing_jobs', "WHERE status='queued' ORDER BY event_id LIMIT 1")[0];
      const review = !queued ? db.prepare(`SELECT m.id,m.event_id,m.content FROM event_routing_messages m
        JOIN event_routing_sessions s ON s.event_id=m.event_id
        WHERE m.role='user' AND json_extract(m.data,'$.status')='queued' AND NOT s.outcome_unknown
        AND s.status!='running' ORDER BY m.id LIMIT 1`).get() : undefined;
      const job = queued ?? (typeof review?.event_id === 'number'
        ? store.row<RoutingJob>('semantic_routing_jobs', 'event_id', review.event_id) : undefined);
      if (!job) return;
      const event = store.row<Event>('events', 'id', job.event_id);
      const admission = event && admitSemantic(store, event, env);
      const session = store.row('event_routing_sessions', 'event_id', job.event_id);
      const assessment = job.project_id === 0;
      const currentContext = event && (assessment ? unassignedContext(store, event, env)
        : admission?.project.id === job.project_id ? { ...semanticContext(event, admission), actor: admission.actor } : undefined);
      if (!event || !currentContext || job.status === 'unknown'
        || session?.outcome_unknown || ['manually_linked', 'dismissed'].includes(String(event.data.routing_status))
        || (queued && (event.task_id !== null || !semanticWaiting.has(String(event.data.routing_status))
          || db.prepare('SELECT 1 FROM event_targets WHERE event_id=? LIMIT 1').get(event.id)))) {
        if (queued) {
          db.prepare("UPDATE semantic_routing_jobs SET status='rejected',error=?,updated_at=? WHERE event_id=?")
            .run('来源或项目权限已变化，需人工复核', now(), job.event_id);
          if (event?.data.routing_status === 'semantic_pending') semanticState(store, event, 'pending_confirmation', 'semantic_authorization_changed');
        }
        if (typeof review?.id === 'number') setMessage(store, 'event_routing_messages', review.id, 'blocked');
        return;
      }
      ensureSemantic(store, queued ? { ...job, context: currentContext } : job, now());
      const context = review ? { ...currentContext, review: truncate(review.content, 20_000) } : currentContext;
      if (queued) db.prepare("UPDATE semantic_routing_jobs SET status='running',context=?,updated_at=? WHERE event_id=?")
        .run(JSON.stringify(currentContext), now(), job.event_id);
      db.prepare(`UPDATE event_routing_sessions SET status='running',state_version=state_version+1,updated_at=?
        WHERE event_id=?`).run(now(), job.event_id);
      if (typeof review?.id === 'number') setMessage(store, 'event_routing_messages', review.id, 'running');
      const work: Work = { id: randomUUID(), kind: 'semantic', scope: job.event_id, item: Number(review?.id) || null, context,
        lastThread: priorThread('semantic', job.event_id, job.thread_id), projectId: job.project_id, actor: currentContext.actor };
      createRun(store, work, driver.source);
      return work;
    });
  }

  function claimRouter(): Work | undefined {
    if (!flag('router_agent_enabled')) return;
    return write(() => {
      const message = db.prepare(`SELECT m.id,m.project_id,m.content,s.codex_thread_id FROM router_messages m
        JOIN router_sessions s ON s.project_id=m.project_id JOIN projects p ON p.id=m.project_id
        WHERE m.role='user' AND json_extract(m.data,'$.status')='queued' AND NOT s.outcome_unknown
        AND p.enabled AND NOT p.archived ORDER BY m.id LIMIT 1`).get();
      if (typeof message?.id !== 'number' || typeof message.project_id !== 'number') return;
      const project = store.required('projects', message.project_id);
      const tasks = store.rows<Task>('tasks', 'WHERE project_id=? ORDER BY updated_at DESC LIMIT 50', message.project_id)
        .map(({ id, title, status, kind, goal }) => ({ id, title, status, kind, goal: goal.slice(0, 700) }));
      const history = store.rows('router_messages', 'WHERE project_id=? AND id<? ORDER BY id DESC LIMIT 12',
        message.project_id, message.id).reverse().map(row => ({ role: row.role, content: truncate(row.content, 1500) }));
      const context = { project: project.name, tasks, history, message: truncate(message.content, 20_000) };
      setMessage(store, 'router_messages', message.id, 'running');
      db.prepare("UPDATE router_sessions SET status='running',updated_at=? WHERE project_id=?").run(now(), message.project_id);
      const work: Work = { id: randomUUID(), kind: 'router', scope: message.project_id, item: message.id, context,
        lastThread: priorThread('router', message.project_id, message.codex_thread_id) };
      createRun(store, work, driver.source);
      return work;
    });
  }

  function claimWatchdog(taskId?: number): Work | undefined {
    if (!flag('watchdog_enabled')) return;
    return write(() => {
      const interval = store.row('governance_settings', 'key', 'watchdog_interval_seconds')?.value;
      const age = Math.max(5, typeof interval === 'number' ? interval : 60) * 1000;
      const threshold = new Date(Date.now() - age).toISOString().replace('Z', '000+00:00');
      const task = taskId === undefined ? store.rows<Task>('tasks', `WHERE status IN ('running','waiting_approval','waiting_resource')
        AND NOT outcome_unknown AND id NOT IN (SELECT task_id FROM watchdog_runs WHERE status IN ('running','unknown') OR created_at>?)
        ORDER BY updated_at,id LIMIT 1`, threshold)[0] : store.row<Task>('tasks', 'id', taskId);
      if (!task || !store.row('projects', 'id', task.project_id)?.enabled) return;
      const previous = store.rows('watchdog_runs', 'WHERE task_id=? ORDER BY created_at DESC LIMIT 1', task.id)[0];
      if (previous && ['running', 'unknown'].includes(String(previous.status))) return;
      const id = randomUUID();
      const context = {
        task: { id: task.id, status: task.status, goal: task.goal.slice(0, 8000), state_version: task.state_version },
        events: store.rows<Event>('events', 'WHERE task_id=? ORDER BY id DESC LIMIT 30', task.id)
          .map(({ id, event_type, content }) => ({ id, event_type, content: content.slice(0, 2000) })),
        artifacts: store.rows('artifacts', 'WHERE task_id=? ORDER BY id DESC LIMIT 5', task.id)
          .map(({ id, kind, content }) => ({ id, kind, content: truncate(content, 4000) })),
        corrections: store.rows('watchdog_runs', "WHERE task_id=? AND correction!='' ORDER BY created_at DESC LIMIT 10", task.id)
          .map(row => ({ run_id: row.id, content: truncate(row.correction, 1500) })),
      };
      db.prepare(`INSERT INTO watchdog_runs(id,task_id,state_version,status,evidence,conclusion,correction,created_at)
        VALUES (?,?,?,'running',?,'{}','',?)`).run(id, task.id, task.state_version, JSON.stringify(context), now());
      const work: Work = { id, kind: 'watchdog', scope: task.id, item: null, context, taskVersion: task.state_version };
      createRun(store, work, driver.source);
      return work;
    });
  }

  function stillAllowed(work: Work) {
    if (work.kind === 'router') {
      const project = store.row('projects', 'id', work.scope);
      return flag('router_agent_enabled') && project?.enabled && !project.archived;
    }
    if (work.kind === 'watchdog') {
      const task = store.row<Task>('tasks', 'id', work.scope);
      const project = task && store.row('projects', 'id', task.project_id);
      return flag('watchdog_enabled') && task?.state_version === work.taskVersion && project?.enabled && !project.archived;
    }
    const event = store.row<Event>('events', 'id', work.scope);
    if (!event || (work.item === null && (event.task_id !== null || !semanticWaiting.has(String(event.data.routing_status))
      || db.prepare('SELECT 1 FROM event_targets WHERE event_id=? LIMIT 1').get(event.id)))) return false;
    if (work.projectId === 0) return flag('semantic_routing_enabled') && event?.task_id === null
      && !['manually_linked', 'dismissed', 'routed'].includes(String(event.data.routing_status))
      && unassignedContext(store, event, env)?.actor === work.actor;
    const auth = event && admitSemantic(store, event, env);
    return flag('semantic_routing_enabled') && auth?.actor === work.actor && auth?.project.id === work.projectId
      && !['manually_linked', 'dismissed'].includes(String(event?.data.routing_status));
  }

  function bind(work: Work, thread: string, turn?: string) {
    write(() => {
      if (!db.prepare(`UPDATE workbench_model_runs SET thread_id=?,turn_id=?,phase=?,updated_at=?
        WHERE id=? AND status='running' AND lease_epoch=?`)
        .run(thread, turn ?? null, turn ? 'turn_bound' : 'thread', now(), work.id, options.lease.epoch).changes) {
        fail(409, '工作台轮次归属已变化');
      }
      if (work.kind === 'semantic') db.prepare('UPDATE semantic_routing_jobs SET thread_id=?,turn_id=?,updated_at=? WHERE event_id=?')
        .run(thread, turn ?? null, now(), work.scope);
      if (work.kind === 'router') db.prepare('UPDATE router_sessions SET codex_thread_id=?,codex_turn_id=?,updated_at=? WHERE project_id=?')
        .run(thread, turn ?? null, now(), work.scope);
      if (work.kind === 'watchdog') db.prepare('UPDATE watchdog_runs SET thread_id=?,turn_id=? WHERE id=?')
        .run(thread, turn ?? null, work.id);
    });
  }

  function finish(work: Work, result: InvocationResult) {
    return write(() => {
      const run = store.row('workbench_model_runs', 'id', work.id);
      if (run?.status !== 'running' || run.lease_epoch !== options.lease.epoch) return;
      const unknown = !result.answered && result.unknown;
      const failure = !result.answered ? result.reason : null;
      const status = result.answered ? 'completed' : unknown ? 'unknown' : 'failed';
      const data = { invocation_id: work.id, evidence_source: driver.source, thread_id: run.thread_id,
        turn_id: run.turn_id, status };
      let stop: number | undefined;
      if (work.kind === 'router') {
        if (result.answered && stillAllowed(work)) {
          for (const [i, text] of result.items.entries()) addMessage(store, work, 'assistant', text,
            { ...data, in_reply_to: work.item }, String(i));
        } else if (failure) addMessage(store, work, 'system', failure, data, 'failure');
        setMessage(store, 'router_messages', work.item!, status, { ...data, status: result.answered && !stillAllowed(work) ? 'stale' : status });
        db.prepare(`UPDATE router_sessions SET status=?,outcome_unknown=?,last_error=?,state_version=state_version+1,updated_at=? WHERE project_id=?`)
          .run(unknown ? 'waiting_resource' : 'idle', Number(unknown), failure, now(), work.scope);
        if (unknown) db.prepare(`UPDATE router_messages SET data=json_set(data,'$.status','held_after_unknown')
          WHERE project_id=? AND json_extract(data,'$.status')='queued'`).run(work.scope);
      } else if (work.kind === 'semantic') {
        const event = store.row<Event>('events', 'id', work.scope);
        let jobStatus = unknown ? 'unknown' : 'rejected';
        let decision: SemanticDecision | ReturnType<typeof validAssessment>;
        if (result.answered) {
          for (const [i, text] of result.items.entries()) addMessage(store, work, 'assistant', text,
            { ...data, status: 'visible_output' }, String(i));
          const raw = parseAnswer(result.items.at(-1)!);
          const permitted = stillAllowed(work);
          if (event && work.projectId === 0 && permitted) {
            decision = validAssessment(raw, work.context, unassignedContext(store, event, env));
            if (decision) {
              semanticState(store, event, 'pending_confirmation', 'project_' + decision.project_status,
                { project_assessment: decision });
              jobStatus = 'assessed';
            }
          } else if (event && work.projectId !== 0 && permitted) {
            decision = modelDecision(raw);
            if (decision) {
              const applied = applyDecision(store, event, admitSemantic(store, event, env), decision, work.context);
              jobStatus = applied.status === 'observed' ? 'applied' : applied.status;
            }
          }
          if (!decision && event?.data.routing_status === 'semantic_pending') {
            semanticState(store, event, 'pending_confirmation', permitted ? 'semantic_invalid_output' : 'semantic_authorization_changed');
          }
        } else if (event?.data.routing_status === 'semantic_pending') {
          semanticState(store, event, 'pending_confirmation', unknown ? 'semantic_unknown' : 'semantic_unavailable');
        }
        db.prepare(`UPDATE semantic_routing_jobs SET status=?,decision=COALESCE(?,decision),output=COALESCE(?,output),error=?,updated_at=?
          WHERE event_id=?`).run(jobStatus, decision ? JSON.stringify(decision) : null,
          result.answered ? result.items.at(-1)! : null, failure, now(), work.scope);
        addMessage(store, work, 'system', failure ?? (decision ? decision.reason : '本轮输出不符合语义分派契约'), data, 'result');
        if (work.item) setMessage(store, 'event_routing_messages', work.item, status, data);
        if (unknown) db.prepare(`UPDATE event_routing_messages SET data=json_set(data,'$.status','held_after_unknown')
          WHERE event_id=? AND json_extract(data,'$.status')='queued'`).run(work.scope);
        const pending = db.prepare(`SELECT 1 FROM event_routing_messages WHERE event_id=? AND json_extract(data,'$.status')='queued' LIMIT 1`)
          .get(work.scope);
        db.prepare(`UPDATE event_routing_sessions SET status=?,outcome_unknown=?,last_error=?,state_version=state_version+1,updated_at=?
          WHERE event_id=?`).run(unknown ? 'unknown' : pending ? 'queued' : 'idle', Number(unknown), failure, now(), work.scope);
      } else {
        stop = finishWatchdog(work, result, data);
      }
      db.prepare('UPDATE workbench_model_runs SET status=?,tree_exited=?,last_error=?,updated_at=? WHERE id=?')
        .run(status, Number(result.treeExited), failure, now(), work.id);
      return stop;
    });
  }

  function finishWatchdog(work: Work, result: InvocationResult, evidence: Fields) {
    const answer = result.answered ? fields(parseAnswer(result.items.at(-1)!)) : {};
    const action = typeof answer.action === 'string' && ['observe', 'needs_human', 'pause'].includes(answer.action)
      ? answer.action : undefined;
    const reason = truncate(answer.reason, 6000).trim();
    if (!action || !reason || !result.answered) {
      db.prepare('UPDATE watchdog_runs SET status=?,conclusion=? WHERE id=?')
        .run(!result.answered && result.unknown ? 'unknown' : 'failed',
          JSON.stringify({ ...evidence, reason: !result.answered ? result.reason : '巡检没有返回有效结构化结论',
            ...(result.answered ? { output: result.items.at(-1)! } : {}) }), work.id);
      return;
    }
    const task = store.row<Task>('tasks', 'id', work.scope);
    let applied = 'stale_evidence';
    let stop: number | undefined;
    if (task && stillAllowed(work)) {
      applied = 'observe';
      if (action !== 'observe') {
        const pause = action === 'pause' && !task.outcome_unknown;
        const queued = pause && task.status === 'queued';
        const live = pause && options.stopWorker && ['running', 'waiting_approval'].includes(task.status);
        applied = queued ? 'paused' : live ? 'pause_requested' : 'needs_human';
        if (live) stop = task.control_version + 1;
        db.prepare(`UPDATE tasks SET status=?,control_version=control_version+?,state_version=state_version+1,
          last_error=?,updated_at=? WHERE id=? AND state_version=?`)
          .run(queued ? 'paused' : live ? 'waiting_resource' : task.status, Number(queued || Boolean(live)),
            queued ? reason : live ? '正在停止执行' : 'Watchdog 需人工处理：' + reason,
            now(), work.scope, work.taskVersion!);
        if (queued || live) db.prepare("UPDATE approvals SET status='expired' WHERE task_id=? AND status='pending'").run(work.scope);
      }
    }
    db.prepare("UPDATE watchdog_runs SET status=?,conclusion=? WHERE id=?")
      .run(stop === undefined ? 'completed' : 'running', JSON.stringify({ action, reason, applied, ...evidence }), work.id);
    if (task) db.prepare(`INSERT INTO events(task_id,source,event_type,content,data,created_at)
      VALUES (?,'watchdog','watchdog_review',?,?,?)`).run(task.id, reason, JSON.stringify({ run_id: work.id, action: applied }), now());
    return stop;
  }

  async function finishPause(work: Work, controlVersion: number) {
    let stopped = false;
    try { stopped = await options.stopWorker!(work.scope); } catch { /* No confirmed exit. */ }
    write(() => {
      const task = store.row<Task>('tasks', 'id', work.scope);
      const current = task?.control_version === controlVersion && task.last_error === '正在停止执行';
      const at = now();
      const applied = current && stopped ? 'paused' : 'stop_unconfirmed';
      db.prepare(`UPDATE watchdog_runs SET status=?,conclusion=json_set(conclusion,'$.applied',?) WHERE id=? AND status='running'`)
        .run(current && stopped ? 'completed' : 'unknown', applied, work.id);
      if (!current) return;
      db.prepare(`UPDATE tasks SET status=?,outcome_unknown=?,last_error=?,state_version=state_version+1,updated_at=? WHERE id=?`)
        .run(stopped ? 'paused' : 'waiting_resource', Number(!stopped), stopped ? null : 'Watchdog 停止执行未确认，需人工核验',
          at, work.scope);
      db.prepare(`UPDATE execution_attempts SET status=?,ended_at=?,updated_at=? WHERE task_id=? AND control_version<?
        AND status IN ('running','waiting_approval','claimed')`)
        .run(stopped ? 'abandoned' : 'unknown', at, at, work.scope, controlVersion);
      store.addEvent(work.scope, stopped ? 'stop_confirmed' : 'stop_unknown', '', { control_version: controlVersion, run_id: work.id });
    });
  }

  function parseAnswer(text: string): unknown { try { return JSON.parse(text); } catch { return undefined; } }

  async function execute(work: Work) {
    let result: InvocationResult;
    try {
      const root = await realpath(options.stateRoot);
      const target = join(root, 'workbench-model', work.kind === 'watchdog' ? work.id : `${work.kind}-${work.scope}`);
      await mkdir(target, { recursive: true });
      const cwd = await realpath(target);
      const rel = relative(root, cwd);
      if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('工作台运行目录越界');
      const signal = AbortSignal.any([shutdown.signal, AbortSignal.timeout(timeoutMs)]);
      result = await invokeWorkbenchModel(db, driver, {
        id: work.id, kind: work.kind, cwd, prompt: workbenchModelPrompt(work.kind, work.context),
        threadId: work.lastThread, taskId: work.kind === 'watchdog' ? work.scope : null, signal,
        onThread: thread => bind(work, thread),
        prepareTurn(reservation) {
          write(() => {
            if (!stillAllowed(work)) fail(409, '模型派发前权限或状态已变化');
            if (!db.prepare(`UPDATE workbench_model_runs SET phase='turn_intent',reservation_id=?,updated_at=?
              WHERE id=? AND status='running' AND lease_epoch=?`).run(reservation, now(), work.id, options.lease.epoch).changes) {
              fail(409, '工作台轮次归属已变化');
            }
            store.audit('workbench', 'model.turn_intent', work.scope, { invocation_id: work.id, kind: work.kind,
              evidence_source: driver.source, reservation_id: reservation });
          });
        },
        bindTurn: (binding: TurnBinding) => bind(work, binding.threadId, binding.turnId),
      });
    } catch {
      result = { answered: false, unknown: false, reason: '未能准备工作台运行目录', treeExited: true };
    }
    const stop = finish(work, result);
    if (stop !== undefined) await finishPause(work, stop);
  }

  function begin(work: Work): Promise<void> {
    const promise = execute(work).finally(() => { if (active === promise) active = undefined; });
    active = promise;
    return promise;
  }

  async function tick() {
    if (!started || closing || active) return false;
    // Also catch admitted inputs from intake builds which have not adopted the direct enqueue callback.
    if (flag('semantic_routing_enabled')) scanIntake();
    if (!driver.available()) return false;
    const work = claimSemantic() ?? claimRouter() ?? claimWatchdog();
    if (!work) return false;
    await begin(work);
    return true;
  }

  function wake(delay = pollMs) {
    if (!started || closing || !pollMs || timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      void tick().catch(error => options.onError?.(error)).finally(() => wake());
    }, delay);
    timer.unref();
  }

  async function wasStopped(kind: WorkbenchModelKind, id: number, fallback?: () => Promise<boolean>) {
    const row = store.rows('workbench_model_runs', 'WHERE kind=? AND scope_id=? ORDER BY rowid DESC LIMIT 1', kind, id)[0];
    if (row?.status === 'running') return false;
    return row?.tree_exited === 1 || Boolean(fallback && await fallback());
  }

  async function correct(eventId: number, decision: SemanticDecision, evidence: string, actor: string) {
    return write(() => {
      const job = store.row<RoutingJob>('semantic_routing_jobs', 'event_id', eventId);
      const event = store.row<Event>('events', 'id', eventId);
      const session = store.row('event_routing_sessions', 'event_id', eventId);
      if (!job || !event || job.status === 'running' || job.status === 'unknown' || session?.outcome_unknown
        || ['dismissed', 'manually_linked'].includes(String(event.data.routing_status))) fail(409, '请先核验语义路由结果');
      const auth = admitSemantic(store, event, env);
      if (!auth || auth.project.id !== job.project_id) fail(409, '来源或项目不再授权');
      const context = semanticContext(event, auth);
      ensureSemantic(store, job, now());
      const result = applyDecision(store, event, auth, decision, context);
      if (result.status !== 'observed') db.prepare('UPDATE semantic_routing_jobs SET status=?,decision=?,updated_at=? WHERE event_id=?')
        .run(result.status, JSON.stringify(decision), now(), eventId);
      const work: Work = { kind: 'semantic', id: randomUUID(), scope: eventId, item: null, context };
      addMessage(store, work, 'system', evidence, { actor, decision, status: result.status, task_id: result.taskId }, 'correction');
      db.prepare('UPDATE event_routing_sessions SET state_version=state_version+1,updated_at=? WHERE event_id=?').run(now(), eventId);
      store.audit(actor, 'semantic.apply', eventId, { status: result.status, decision, evidence, task_id: result.taskId });
      return { newly_applied: result.status === 'applied' };
    });
  }

  function runAssessment(id: string, context: Fields, stillAuthorized: () => boolean, images: readonly AssessmentImage[] = []) {
    if (!started || closing || !driver.available()) {
      return Promise.resolve({ thread_id: null, turn_id: null, error: '模型未配置，尚未执行评估' });
    }
    const prior = store.row('workbench_model_runs', 'id', id);
    if (prior) return Promise.resolve({ thread_id: prior.thread_id as string | null, turn_id: prior.turn_id as string | null,
      error: '已有评估轮次等待回执核验，禁止重复派发' });
    if (active) fail(409, '工作台模型正在执行，请稍后重试评估');
    const scope = Number(context.event_id);
    if (!/^comparison-[0-9a-f]{32}$/.test(id) || !Number.isSafeInteger(scope) || scope < 1) fail(422, '评估轮次标识无效');
    write(() => {
      const time = now();
      db.prepare(`INSERT INTO workbench_model_runs(id,kind,scope_id,item_id,lease_epoch,phase,status,evidence_source,created_at,updated_at)
        VALUES (?,'assessment',?,NULL,?,'claimed','running',?,?,?)`).run(id, scope, options.lease.epoch, driver.source, time, time);
    });
    const executeAssessment = async () => {
      let outcome: InvocationResult;
      let staged: Awaited<ReturnType<typeof stageAssessmentImages>> | undefined;
      let imageTurn: string | undefined;
      try {
        const root = await realpath(options.stateRoot);
        const cwd = await directory(join(root, 'workbench-model', id));
        if (!stillAuthorized()) throw new Error('来源授权已变化');
        if (images.length) staged = await stageAssessmentImages(cwd, images);
        const phase = (update: () => { changes: number | bigint }) => write(() => {
          if (!update().changes) fail(409, '评估轮次归属已变化');
        });
        outcome = await invokeWorkbenchModel(db, driver, {
          id, kind: 'semantic', cwd, prompt: workbenchModelPrompt('semantic', context), taskId: null,
          imagePaths: staged?.paths,
          signal: AbortSignal.any([shutdown.signal, AbortSignal.timeout(timeoutMs)]),
          onThread: thread => phase(() => db.prepare(`UPDATE workbench_model_runs SET thread_id=?,phase='thread',updated_at=?
            WHERE id=? AND status='running' AND lease_epoch=?`).run(thread, now(), id, options.lease.epoch)),
          prepareTurn: reservation => phase(() => {
            if (!stillAuthorized()) fail(409, '来源授权或状态在派发前已变化');
            return db.prepare(`UPDATE workbench_model_runs SET reservation_id=?,phase='turn_intent',updated_at=?
              WHERE id=? AND status='running' AND lease_epoch=?`).run(reservation, now(), id, options.lease.epoch);
          }),
          bindTurn: binding => {
            phase(() => db.prepare(`UPDATE workbench_model_runs SET turn_id=?,phase='turn_bound',updated_at=?
              WHERE id=? AND thread_id=? AND status='running' AND lease_epoch=?`)
              .run(binding.turnId, now(), id, binding.threadId, options.lease.epoch));
            if (staged?.paths.length) imageTurn = binding.turnId;
          },
        });
      } catch {
        outcome = { answered: false, unknown: false, reason: '评估运行目录未能准备', treeExited: true };
      } finally {
        if (staged) {
          try { await staged.clear(); } catch (error) {
            options.onError?.(error);
            outcome = { answered: false, unknown: true, reason: '评估原图清理未确认，请人工核验', treeExited: outcome!.treeExited };
          }
        }
      }
      return write(() => {
        const status = outcome.answered ? 'completed' : outcome.unknown ? 'unknown' : 'failed';
        const error = outcome.answered ? undefined : outcome.reason;
        const row = db.prepare(`UPDATE workbench_model_runs SET status=?,last_error=?,tree_exited=?,updated_at=?
          WHERE id=? AND status='running' AND lease_epoch=? RETURNING thread_id,turn_id`)
          .get(status, error ?? null, Number(outcome.treeExited), now(), id, options.lease.epoch);
        if (!row) fail(409, '评估轮次归属已变化');
        return { thread_id: row.thread_id as string | null, turn_id: row.turn_id as string | null,
          ...(imageTurn ? { image_turn_id: imageTurn } : {}),
          ...(outcome.answered ? { text: outcome.items.at(-1) } : { error }) };
      });
    };
    const result = executeAssessment();
    const tracking = result.then(() => {}, () => {}).finally(() => { if (active === tracking) active = undefined; });
    active = tracking;
    return result;
  }

  return {
    ...options.ports,
    readThread: options.ports?.readThread ?? (!options.driver && [undefined, 'codex'].includes(env.SUPERAGENT_DRIVER)
      ? localThreadReader(db, options.stateRoot) : undefined),
    workerPrompts: options.workerPrompts,
    recoverOnly: recover,
    start() {
      if (started) return;
      recover();
      started = true;
      wake();
    },
    async close() {
      closing = true;
      clearTimeout(timer);
      shutdown.abort();
      await active;
    },
    tick,
    resolveRole: user => roleOf(env, user),
    projectRouterAvailable: () => driver.available(),
    assessmentAvailable: () => driver.available(),
    assessmentImagesAvailable: () => driver.imagesAvailable?.() === true,
    runAssessment,
    wakeProjectRouter() { wake(0); },
    async scheduleSemantic(eventId) {
      const result = schedule(eventId);
      wake(0);
      return result;
    },
    applySemanticCorrection: correct,
    async hasStoppedSession(binding: SessionBinding) {
      if (binding.kind === 'worker') return false;
      return wasStopped(binding.kind, binding.id, options.ports?.hasStoppedSession
        && (() => options.ports!.hasStoppedSession!(binding)));
    },
    async hasStoppedWatchdog(id, runId) {
      if (runId) {
        const run = store.row('workbench_model_runs', 'id', runId);
        if (run?.scope_id === id && run.kind === 'watchdog' && run.status !== 'running' && run.tree_exited === 1) return true;
        return await options.ports?.hasStoppedWatchdog?.(id, runId) ?? false;
      }
      return wasStopped('watchdog', id, options.ports?.hasStoppedWatchdog && (() => options.ports!.hasStoppedWatchdog!(id)));
    },
    async runWatchdog(taskId) {
      if (!started || closing || active || !driver.available()) fail(409, '巡检运行资源当前不可用');
      const work = claimWatchdog(taskId);
      if (!work) fail(409, '任务当前不能开始巡检');
      await begin(work);
      return work.id;
    },
  };
}
