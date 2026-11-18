import type { FastifyInstance } from 'fastify';
import type { WorkbenchStore } from './store.ts';
import { fail, fields, integer, now, requireAdmin, requiredText } from './store.ts';
import { workbenchRuntime } from './runtime.ts';

export function registerWatchdog(app: FastifyInstance, store: WorkbenchStore): void {
  const path = '/api/v1/operations/watchdog';
  const active = new Set<number>();
  app.get(path, request => {
    requireAdmin(request, '仅管理员可执行此操作');
    const query = fields(request.query);
    const id = query.task_id === undefined ? undefined : integer(query.task_id, 'task_id');
    const items = id === undefined ? store.rows('watchdog_runs', 'ORDER BY created_at DESC LIMIT 100')
      : store.rows('watchdog_runs', 'WHERE task_id=? ORDER BY created_at DESC LIMIT 100', id);
    return { items, enabled: store.row('governance_settings', 'key', 'watchdog_enabled')?.value === true,
      interval_seconds: store.row('governance_settings', 'key', 'watchdog_interval_seconds')?.value ?? 60 };
  });
  app.post<{ Params: { task_id: string } }>(`${path}/tasks/:task_id/run`, async request => {
    requireAdmin(request, '仅管理员可执行此操作');
    const id = integer(request.params.task_id, 'task_id');
    if (!store.row('tasks', 'id', id)) fail(404, '任务不存在');
    if (store.row('governance_settings', 'key', 'watchdog_enabled')?.value !== true) fail(409, 'Watchdog 尚未启用');
    const run = workbenchRuntime(app)?.runWatchdog;
    if (!run) fail(409, 'Watchdog 运行服务尚未接入');
    const prior = store.rows('watchdog_runs', 'WHERE task_id=? ORDER BY created_at DESC', id);
    if (active.has(id) || prior.some(row => row.status === 'running')) fail(409, '巡检正在执行');
    if (prior[0]?.status === 'unknown') fail(409, '上次巡检结果未知，需先人工核验');
    let runId: string;
    active.add(id);
    try { runId = await run(id); }
    catch { fail(409, '巡检结果未确认，请查看该任务的巡检记录'); }
    finally { active.delete(id); }
    const result = store.row('watchdog_runs', 'id', runId);
    if (result?.task_id !== id || result.status !== 'completed' || prior.some(row => row.id === runId)) {
      fail(409, '巡检结果未确认，请查看该任务的巡检记录');
    }
    return { run_id: runId };
  });
  app.post<{ Params: { run_id: string } }>(`${path}/:run_id/messages`, async request => {
    const principal = requireAdmin(request, '仅管理员可执行此操作');
    const body = fields(request.body);
    if (Object.keys(body).some(key => key !== 'content' && key !== 'reconcile_unknown')
      || (body.reconcile_unknown !== undefined && typeof body.reconcile_unknown !== 'boolean')) fail(422, '巡检纠正字段无效');
    const correction = requiredText(body.content, 10000, '请填写纠正说明或核验证据').trim();
    const runId = request.params.run_id;
    const before = store.row('watchdog_runs', 'id', runId);
    if (!before || typeof before.task_id !== 'number') fail(404, '巡检记录不存在');
    let confirmed = false;
    if (body.reconcile_unknown && before.status === 'unknown') {
      const stopped = workbenchRuntime(app)?.hasStoppedWatchdog;
      confirmed = Boolean(stopped && await stopped(before.task_id).catch(() => false));
    }
    return store.write(() => {
      const run = store.row('watchdog_runs', 'id', runId);
      if (!run || typeof run.task_id !== 'number') fail(404, '巡检记录不存在');
      if (active.has(run.task_id) || run.status === 'running'
        || store.db.prepare("SELECT 1 FROM watchdog_runs WHERE task_id=? AND status='running' LIMIT 1")
        .get(run.task_id)) fail(409, '巡检仍在运行');
      if (body.reconcile_unknown && run.status === 'unknown' && !confirmed) fail(409, '尚未确认巡检进程退出');
      const status = body.reconcile_unknown && run.status === 'unknown' ? 'reconciled' : String(run.status);
      store.db.prepare('UPDATE watchdog_runs SET status=?,correction=? WHERE id=?').run(status, correction, runId);
      const data = JSON.stringify({ run_id: runId, actor: principal.user_id });
      store.db.prepare(`INSERT INTO events(task_id,source,event_type,content,data,created_at)
        VALUES (?,'watchdog','watchdog_correction',?,?,?)`).run(run.task_id, correction, data, now());
      return { ...run, status, correction };
    });
  });
}
