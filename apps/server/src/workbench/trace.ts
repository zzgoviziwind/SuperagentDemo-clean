import type { Event, Fields, Task, WorkbenchStore } from './store.ts';
import { fail, fields } from './store.ts';
import type { RoutingJob } from './sessions.ts';
import { routingMode, targetTaskIds } from './sessions.ts';

function sourceContext(event: Event) {
  const data = event.data;
  const meta = fields(data.metadata);
  return { source: event.source,
    conversation_name: meta.conversation_title || meta.chat_name || meta.conversation_name || (data.thread_id ?? null),
    actor_name: meta.sender_name || meta.actor_name || (data.actor_id ?? null),
    thread_id: data.thread_id ?? null, issue_id: data.issue_id ?? null,
    conversation_type: meta.conversation_type ?? null, content: event.content };
}

function architectureFlow(attempts: unknown[]) {
  return attempts.map(fields).map(attempt => ({
    attempt: attempt.attempt ?? null,
    nodes: (Array.isArray(attempt.steps) ? attempt.steps : []).map(fields).map(step => ({
      ...step, architecture_node: step.stage, evidence_scope: 'routing_attempt',
      visited: ['passed', 'blocked', 'pending'].includes(String(step.status)),
    })),
  }));
}

function summary(event: Event) {
  return { id: event.id, source: event.source, event_type: event.event_type, created_at: event.created_at,
    content: [...event.content].slice(0, 500).join(''), data: event.data };
}

function watchdogRuns(store: WorkbenchStore, taskId: number) {
  return store.rows('watchdog_runs', 'WHERE task_id = ? ORDER BY created_at DESC LIMIT 50', taskId);
}

function observations(task: Task | undefined, events: ReturnType<typeof summary>[]) {
  return { state: task?.status ?? null, thread_id: task?.codex_thread_id ?? null,
    turn_id: task?.codex_turn_id ?? null, workspace: task?.workspace_path ?? null, events };
}

const recoveryTypes = new Set(['execution_reconciled', 'disconnected', 'protocol_error', 'run_error',
  'unscoped_runtime_event', 'external_interrupt_failed', 'steer_unconfirmed', 'approval_response_unknown',
  'delivery.reconciled', 'watchdog_review', 'watchdog_correction']);

interface Target extends Fields {
  task_id: number;
  subscription_id: number | null;
  message_event_id: number;
}

export function trace(store: WorkbenchStore, id: number) {
  const event = store.row<Event>('events', 'id', id);
  if (!event) fail(404, '事件不存在');
  const task = event.task_id ? store.row<Task>('tasks', 'id', event.task_id) : undefined;
  const subscriptions = event.task_id ? store.rows('task_routes', 'WHERE task_id = ? ORDER BY id', event.task_id) : [];
  const deliveries = store.rows('reply_drafts', 'WHERE event_id = ? ORDER BY id', id).map(draft => ({
    draft, record: store.row('delivery_records', 'action_id', `reply-${draft.approval_id}`) ?? null,
  }));
  const targets = store.rows<Target>('event_targets', 'WHERE event_id = ? ORDER BY id', id);
  const targetSubscriptions = targets.flatMap(target => {
    const row = target.subscription_id && store.row('worker_subscriptions', 'id', target.subscription_id);
    return row ? [row] : [];
  });
  const semantic = store.row<RoutingJob>('semantic_routing_jobs', 'event_id', id);
  const attempts = Array.isArray(event.data._lifecycle) ? event.data._lifecycle : [];
  const taskEvents = task ? store.rows<Event>('events', `WHERE task_id = ? AND id != ?
    AND (source = 'runtime' OR event_type IN ('control', 'execution_reconciled', 'approval_response_unknown',
      'steer_unconfirmed', 'delivery.reconciled', 'watchdog_review', 'watchdog_correction'))
    ORDER BY id DESC LIMIT 101`, task.id, id) : [];
  const recent = taskEvents.slice(0, 100).reverse();
  const artifacts = task ? store.rows('artifacts', 'WHERE task_id = ? ORDER BY id DESC LIMIT 100', task.id).reverse()
    .map(({ id, kind, revision, created_at }) => ({ id, kind, revision, created_at })) : [];
  const targetTasks: Task[] = [];
  const targetObservations = targets.flatMap(target => {
    const current = store.row<Task>('tasks', 'id', target.task_id);
    if (!current) return [];
    targetTasks.push(current);
    const observed = store.rows<Event>('events', "WHERE task_id = ? AND source = 'runtime' ORDER BY id DESC LIMIT 100",
      current.id).reverse().map(summary);
    return [{ task_id: current.id, message_event_id: target.message_event_id,
      execution: observations(current, observed),
      watchdog: { outcome_unknown: current.outcome_unknown, last_error: current.last_error,
        runs: watchdogRuns(store, current.id) },
      scope: '当前目标任务观察，包含其他来源事件相关记录' }];
  });
  const fanout = targetObservations.length > 0 && !task;
  const execution = { ...observations(task, recent.map(summary)), events_truncated: taskEvents.length > 100, artifacts,
    scope: fanout ? '多个目标的当前执行状态见 target_observations' : '当前关联任务的事件，不能证明均由此来源事件触发' };
  const worker = { state: fanout ? 'fanout' : task?.status ?? 'unlinked',
    evidence_event_ids: recent.filter(row => row.source === 'runtime').map(row => row.id),
    ...(fanout ? { target_task_ids: targetObservations.map(row => row.task_id) } : {}) };
  const liveStages = { worker,
    delivery: { draft_count: deliveries.length, record_count: deliveries.filter(item => item.record).length },
    watchdog: { outcome_unknown: task?.outcome_unknown ?? null, last_error: task?.last_error ?? null,
      events: recent.filter(row => recoveryTypes.has(row.event_type)).map(summary),
      runs: task ? watchdogRuns(store, task.id) : [],
      note: '当前任务的巡检与恢复观察，包含其他来源事件相关记录' } };
  const workerIds = targetTaskIds(store, id, event.task_id);
  const related = store.rows<Event>('events', `WHERE
    (external_id IS NOT NULL AND task_id IN (
      SELECT task_id FROM event_targets WHERE event_id = ? UNION SELECT ?))
    OR id IN (SELECT event_id FROM event_targets WHERE task_id IN (
      SELECT task_id FROM event_targets WHERE event_id = ? UNION SELECT ?))
    ORDER BY id`, id, event.task_id, id, event.task_id);
  return { source_context: sourceContext(event), architecture_flow: architectureFlow(attempts),
    related_events: related.map(row => ({ id: row.id, task_id: row.task_id, ...sourceContext(row) })),
    router_lifecycle: { event: '每个需模型判定的事件独立线程，人工复核续用原线程',
      project: '项目讨论持久线程；不会自动定期开新或压缩；压缩以真实 Codex 记录为准' },
    routing_session_id: semantic ? `semantic:${id}` : null, routing_mode: routingMode(semantic),
    ai_invoked: Boolean(semantic?.turn_id), worker_session_ids: workerIds.map(taskId => `worker:${taskId}`),
    target_observations: targetObservations, event, targets, target_tasks: targetTasks,
    target_subscriptions: targetSubscriptions, semantic_routing: semantic ?? null, attempts, subscriptions,
    task: task ?? null, deliveries, execution, live_stages: liveStages, legacy: attempts.length === 0 };
}
