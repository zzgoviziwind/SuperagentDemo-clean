import type { FastifyInstance } from 'fastify';
import type { Fields, Principal, Task, WorkbenchStore } from './store.ts';
import { fields, integer, now, principalOf, queryText } from './store.ts';
import { connectorStatuses } from '../deliveries/channels.ts';

function taskDetail(store: WorkbenchStore, task: Task) {
  return { task,
    events: store.rows('events', 'WHERE task_id = ? ORDER BY id', task.id),
    artifacts: store.rows('artifacts', 'WHERE task_id = ? ORDER BY id', task.id),
    approvals: store.rows('approvals', 'WHERE task_id = ? ORDER BY id', task.id) };
}

function visibleArtifact(store: WorkbenchStore, id: number, principal: Principal) {
  const artifact = store.required<Fields & { task_id: number }>('artifacts', id);
  store.visibleTask(artifact.task_id, principal);
  return artifact;
}

export function registerTasks(app: FastifyInstance, store: WorkbenchStore): void {
  app.get('/api/v1/projects', request => {
    principalOf(request);
    return store.rows('projects', 'WHERE archived = 0 ORDER BY id');
  });
  app.get('/api/v1/tasks', request => {
    const principal = principalOf(request);
    const query = fields(request.query);
    const project = query.project_id === undefined ? 0 : integer(query.project_id, 'project_id');
    const status = queryText(query.status, 'status');
    const filters: string[] = [];
    const bindings: (string | number)[] = [];
    if (status) {
      filters.push('status = ?');
      bindings.push(status);
    }
    if (project) {
      filters.push('project_id = ?');
      bindings.push(project);
    }
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    return store.rows<Task>('tasks', `${where} ORDER BY id DESC`, ...bindings)
      .filter(task => store.allowedWorker(task, principal));
  });
  app.get('/api/v1/approvals', request => {
    const principal = principalOf(request);
    const visible = new Set(store.rows<Task>('tasks').filter(task => store.allowedWorker(task, principal)).map(task => task.id));
    return store.rows('approvals', 'ORDER BY id').filter(row => typeof row.task_id === 'number' && visible.has(row.task_id));
  });
  app.get<{ Params: { id: string } }>('/api/v1/tasks/:id', request => {
    const principal = principalOf(request);
    return taskDetail(store, store.visibleTask(integer(request.params.id, 'id'), principal));
  });
  app.get<{ Params: { id: string } }>('/api/v1/tasks/:id/export', (request, reply) => {
    const principal = principalOf(request);
    const id = integer(request.params.id, 'id');
    const detail = taskDetail(store, store.visibleTask(id, principal));
    reply.header('Content-Disposition', `attachment; filename="task-${id}-evidence.json"`);
    reply.header('Cache-Control', 'no-store');
    return { format_version: 1, exported_at: now(), ...detail };
  });
  app.get<{ Params: { id: string } }>('/api/v1/artifacts/:id', request => {
    const principal = principalOf(request);
    return visibleArtifact(store, integer(request.params.id, 'id'), principal);
  });
  app.get<{ Params: { id: string } }>('/api/v1/artifacts/:id/download', (request, reply) => {
    const principal = principalOf(request);
    const id = integer(request.params.id, 'id');
    const artifact = visibleArtifact(store, id, principal);
    reply.header('Content-Disposition', `attachment; filename="artifact-${id}.json"`);
    reply.header('Cache-Control', 'no-store');
    return artifact;
  });
  app.get('/api/v1/overview', request => {
    const principal = principalOf(request);
    const tasks = store.rows<Task>('tasks', 'ORDER BY id').filter(task => store.allowedWorker(task, principal));
    const taskIds = new Set(tasks.map(task => task.id));
    const counts: Record<string, number> = Object.create(null);
    for (const task of tasks) counts[task.status] = (counts[task.status] ?? 0) + 1;
    const pending = store.rows('approvals', "WHERE status = 'pending' ORDER BY id")
      .filter(approval => typeof approval.task_id === 'number' && taskIds.has(approval.task_id));
    const connectors = connectorStatuses(app);
    return { counts, active_tasks: tasks.filter(task => !['completed', 'cancelled'].includes(task.status)),
      pending_approvals: pending, connectors };
  });
}
