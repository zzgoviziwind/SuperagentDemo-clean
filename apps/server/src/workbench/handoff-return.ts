import { realpath } from 'node:fs/promises';
import { isAbsolute, relative } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { attachmentGate } from '../controls.ts';
import { workbenchRuntime, type WorkbenchRuntime } from './runtime.ts';
import { parseSession } from './sessions.ts';
import { fail, fields, now, requireAdmin, type Event, type Fields, type Task, type WorkbenchStore } from './store.ts';

const uuid = z.string().regex(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i);
const input = z.strictObject({
  thread_id: uuid,
  turn_id: uuid.optional(),
  expected_state_version: z.int().positive(),
});
const eventType = 'codex_handoff_return';
const interval = 15_000;
const waitLimit = 24 * 60 * 60_000;
type Reader = NonNullable<WorkbenchRuntime['readThread']>;
type Write = <T>(fn: () => T) => T;

function latest(store: WorkbenchStore, taskId: number) {
  const row = store.db.prepare('SELECT id FROM events WHERE task_id=? AND event_type=? ORDER BY id DESC LIMIT 1')
    .get(taskId, eventType);
  return row && store.row<Event>('events', 'id', Number(row.id));
}

function target(store: WorkbenchStore, taskId: number, version: number) {
  const task = store.row<Task>('tasks', 'id', taskId);
  if (!task || task.status !== 'paused' || task.state_version !== version || task.outcome_unknown
    || !['reply', 'analysis'].includes(task.kind) || task.last_error === '正在停止执行'
    || store.db.prepare(`SELECT 1 FROM execution_attempts WHERE task_id=? AND status IN
      ('claimed','running','waiting_approval') LIMIT 1`).get(taskId)) return;
  const project = store.row('projects', 'id', task.project_id);
  if (!project?.enabled || project.archived || typeof project.repo_path !== 'string'
    || store.row('project_execution_nodes', 'project_id', task.project_id)?.node_id) return;
  const handoff = store.db.prepare(`SELECT 1 FROM events WHERE task_id=? AND event_type='manual_handoff'
    AND json_extract(data,'$.state_version')=? AND json_extract(data,'$.control_version')=?`)
    .get(taskId, version, task.control_version);
  if (handoff) return { task, path: project.repo_path };
}

async function readTurns(read: Reader, taskId: number, threadId: string, projectPath: string, signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(10_000);
  const raw = fields(await read({ kind: 'worker', id: taskId, threadId, includeTurns: true },
    signal ? AbortSignal.any([signal, timeout]) : timeout));
  const thread = fields(raw.thread ?? raw);
  if (thread.id !== threadId || !Array.isArray(thread.turns) || typeof thread.cwd !== 'string'
    || !isAbsolute(thread.cwd)) return;
  const [project, cwd] = await Promise.all([realpath(projectPath), realpath(thread.cwd)]);
  if (relative(project, cwd) !== '') return;
  return thread.turns.map(fields);
}

function status(event: Event | undefined, task?: Task) {
  if (!event) return { status: 'unlinked', reason: null };
  if (event.data.status === 'waiting' && (task?.status !== 'paused' || task.state_version !== event.data.task_version)) {
    return { status: 'stale', reason: '任务已变化，请重新接管后关联。' };
  }
  return { status: event.data.status, reason: event.data.reason ?? null };
}

function awaitingCompletion(turn: Fields) {
  // A separate app-server can reconstruct an active desktop turn as interrupted until its terminal record is persisted.
  return turn.status === 'inProgress' || (turn.status === 'interrupted' && turn.completedAt == null && turn.error == null);
}

export function registerHandoffReturn(app: FastifyInstance, store: WorkbenchStore) {
  const route = '/api/v1/sessions/:id/handoff-return';
  const worker = (id: string) => {
    const binding = parseSession(id);
    if (binding.kind !== 'worker') fail(422, '请从原事件关联 Codex 会话');
    return store.required<Task>('tasks', binding.id);
  };
  app.get<{ Params: { id: string } }>(route, request => {
    requireAdmin(request);
    const task = worker(request.params.id);
    return status(latest(store, task.id), task);
  });
  app.post<{ Params: { id: string } }>(route, async request => {
    const actor = requireAdmin(request).user_id;
    const { id } = worker(request.params.id);
    const body = input.safeParse(request.body);
    if (!body.success) fail(422, 'Codex 会话、轮次或任务版本无效');
    const { thread_id, turn_id, expected_state_version } = body.data;
    const original = target(store, id, expected_state_version);
    if (!original) fail(409, '请先暂停并接管原事件，确认项目及执行状态');
    const read = workbenchRuntime(app)?.readThread;
    if (!read) fail(409, '本机 Codex 会话读取尚未配置');
    const managedWorker = store.db.prepare(`SELECT 1 FROM tasks WHERE codex_thread_id=? UNION ALL
      SELECT 1 FROM execution_attempts WHERE thread_id=? LIMIT 1`).get(thread_id, thread_id);
    const managedWorkbench = store.db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='workbench_model_runs'").get()
      && store.db.prepare('SELECT 1 FROM workbench_model_runs WHERE thread_id=? LIMIT 1').get(thread_id);
    if (managedWorker || managedWorkbench) fail(409, '请选择你在项目中打开的排查会话');
    const turns = await readTurns(read, id, thread_id, original.path).catch(() => undefined);
    if (!turns) fail(409, '无法读取会话，或其工作目录与事件项目根目录不一致');
    const turn = turn_id ? turns.find(candidate => candidate.id === turn_id) : turns.at(-1);
    if (!turn || !uuid.safeParse(turn.id).success || turn.status !== 'completed' && !awaitingCompletion(turn)) {
      fail(409, '请选择正在执行或已完成的排查轮次');
    }
    return store.write(() => {
      const current = target(store, id, expected_state_version);
      if (!current || current.path !== original.path || current.task.project_id !== original.task.project_id) {
        fail(409, '任务或项目已变化，请刷新后重新关联');
      }
      const existing = latest(store, id);
      if (existing?.data.status === 'waiting' && existing.data.task_version === expected_state_version
        && existing.data.thread_id === thread_id && existing.data.turn_id === turn.id) return status(existing, current.task);
      const data = { status: 'waiting', actor, task_version: expected_state_version, project_id: current.task.project_id,
        project_path: current.path, thread_id, turn_id: turn.id, next_check: Date.now() };
      store.addEvent(id, eventType, '已关联 Codex 排查轮次', data);
      store.audit(actor, 'task.handoff.link', id, { thread_id, turn_id: turn.id });
      return status(latest(store, id), current.task);
    });
  });
}

export async function checkHandoffReturn(store: WorkbenchStore, read: Reader, write: Write,
  role: NonNullable<WorkbenchRuntime['resolveRole']>, signal: AbortSignal) {
  const job = store.db.prepare(`SELECT e.id FROM events e WHERE e.event_type=?
    AND json_extract(e.data,'$.status')='waiting' AND json_extract(e.data,'$.next_check')<=?
    AND e.id=(SELECT MAX(n.id) FROM events n WHERE n.task_id=e.task_id AND n.event_type=e.event_type)
    ORDER BY json_extract(e.data,'$.next_check'),e.id LIMIT 1`).get(eventType, Date.now());
  if (!job) return;
  const event = store.required<Event>('events', Number(job.id));
  const id = Number(event.task_id);
  const data = event.data;
  const version = Number(data.task_version);
  const eligible = () => {
    const current = target(store, id, version);
    return current && current.task.project_id === data.project_id && current.path === data.project_path
      && role(String(data.actor)) === 'admin' ? current.task : undefined;
  };
  function finish(update: Fields, result?: string) {
    if (signal.aborted) return;
    write(() => {
      const link = latest(store, id);
      if (link?.id !== event.id || link.data.status !== 'waiting') return;
      const task = eligible();
      if (!task) update = { status: 'stale', reason: '任务、项目或授权已变化。' };
      else if (result) {
        const next = attachmentGate(store.db, id);
        const isReply = task.kind === 'reply';
        store.addEvent(id, 'message', result, { actor: data.actor, codex_thread_id: data.thread_id, codex_turn_id: data.turn_id,
          provenance: 'codex_handoff_result' });
        store.db.prepare(`UPDATE tasks SET status=?,last_error=?,kind='analysis',revision=revision+1,
          state_version=state_version+1,control_version=control_version+1,updated_at=?,
          codex_thread_id=CASE WHEN ? THEN NULL ELSE codex_thread_id END,
          codex_turn_id=CASE WHEN ? THEN NULL ELSE codex_turn_id END WHERE id=?`)
          .run(next.status, next.error, now(), Number(isReply), Number(isReply), id);
        store.db.prepare("UPDATE approvals SET status='expired' WHERE task_id=? AND status='pending'").run(id);
        store.audit(String(data.actor), 'task.handoff.return', id, { thread_id: data.thread_id, turn_id: data.turn_id });
      }
      store.db.prepare('UPDATE events SET data=? WHERE id=?').run(JSON.stringify({ ...link.data, ...update }), event.id);
    });
  }
  if (!eligible()) return finish({});
  if (Date.now() - Date.parse(event.created_at) >= waitLimit) {
    return finish({ status: 'failed', reason: '等待排查结果已超时，请重新关联。' });
  }
  let turns: Fields[] | undefined;
  try { turns = await readTurns(read, id, String(data.thread_id), String(data.project_path), signal); }
  catch { return finish({ next_check: Date.now() + interval, reason: '暂时无法读取 Codex，稍后会重试。' }); }
  if (!turns) return finish({ status: 'failed', reason: '会话工作目录已变化，请重新关联。' });
  const turn = turns.find(candidate => candidate.id === data.turn_id);
  if (!turn || awaitingCompletion(turn)) return finish({ next_check: Date.now() + interval, reason: null });
  const answer = Array.isArray(turn.items) ? turn.items.map(fields).findLast(item =>
    item.type === 'agentMessage' && item.phase === 'final_answer' && typeof item.text === 'string' && item.text.trim()) : undefined;
  if (turn.status !== 'completed' || !answer) {
    return finish({ status: 'failed', reason: '选定轮次没有已完成的排查结论，请重新关联。' });
  }
  const text = String(answer.text).trim();
  const result = 'Codex 接管排查结论（待核验）：\n' + (text.length > 2900 ? text.slice(0, 2900) + '\n[结论过长，已截断]' : text);
  finish({ status: 'imported', reason: null }, result);
}
