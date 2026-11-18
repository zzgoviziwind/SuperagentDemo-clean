import type { FastifyRequest } from 'fastify';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { fail, type Principal } from '../auth.ts';

export type Fields = Record<string, unknown>;
export { fail, type Principal };

export interface Task extends Fields {
  id: number;
  project_id: number;
  owner_id?: string;
  title: string;
  goal: string;
  kind: string;
  status: string;
  created_at: string;
  updated_at: string;
  revision: number;
  control_version: number;
  state_version: number;
  outcome_unknown: boolean;
  codex_thread_id: string | null;
}

export interface Event extends Fields {
  id: number;
  task_id: number | null;
  source: string;
  external_id: string | null;
  event_type: string;
  content: string;
  data: Fields;
  created_at: string;
}

export function principalOf(request: FastifyRequest): Principal {
  const principal = request.principal;
  if (!principal) fail(401, '需要登录');
  return principal;
}

export function requireAdmin(request: FastifyRequest, message = '当前身份无权执行此操作'): Principal {
  const principal = principalOf(request);
  if (principal.role !== 'admin') fail(403, message);
  return principal;
}

export function fields(value: unknown): Fields {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Fields : {};
}

export function integer(value: unknown, label: string): number {
  if (typeof value === 'string' && /^[+-]?\d+$/.test(value.trim())) value = Number(value);
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) fail(422, `${label} 无效`);
  return value;
}

export function queryText(value: unknown, label: string, fallback = ''): string {
  if (value === undefined) return fallback;
  if (typeof value !== 'string') fail(422, `${label} 无效`);
  return value;
}

export function page(query: Fields, cursor: 'after' | 'offset', defaultLimit: number, message = '分页参数无效') {
  const start = integer(query[cursor] ?? 0, cursor);
  const limit = integer(query.limit ?? defaultLimit, 'limit');
  if (start < 0 || limit < 1 || limit > 100) fail(422, message);
  return { start, limit };
}

export function cursorPage<T>(rows: T[], start: number, limit: number, key: (row: T) => number) {
  const items = rows.slice(0, limit);
  return { items, has_more: rows.length > limit, next_after: items.length ? key(items.at(-1)!) : start };
}

export function requiredText(value: unknown, max: number, message: string): string {
  if (typeof value !== 'string' || !value.trim() || [...value].length > max) fail(422, message);
  return value;
}

export function now(): string {
  return new Date().toISOString().replace('Z', '000+00:00');
}

const jsonColumns: Record<string, string[]> = {
  projects: ['repositories', 'reference_dirs', 'allowed_paths', 'dingtalk_chat_ids', 'redmine_project_ids'],
  events: ['data'],
  approvals: ['action'],
  governance_settings: ['value'],
  governance_identity_grants: ['project_ids', 'permissions'],
  router_messages: ['data'],
  event_routing_messages: ['data'],
  semantic_routing_jobs: ['context', 'decision'],
  delivery_records: ['result'],
  conversation_bridge_operations: ['result'],
  watchdog_runs: ['evidence', 'conclusion'],
};

const booleanColumns: Record<string, string[]> = {
  projects: ['enabled', 'archived'],
  tasks: ['outcome_unknown'],
  worker_subscriptions: ['enabled'],
  router_sessions: ['outcome_unknown'],
  event_routing_sessions: ['outcome_unknown'],
  governance_identities: ['enabled'],
};

function decode<T extends Fields>(table: string, row: Fields): T {
  const result = { ...row };
  for (const key of jsonColumns[table] ?? []) {
    if (typeof result[key] === 'string') result[key] = JSON.parse(result[key]);
  }
  for (const key of booleanColumns[table] ?? []) {
    if (result[key] != null) result[key] = ![false, 0, '0', 'false', ''].includes(result[key] as string | number | boolean);
  }
  return result as T;
}

export class WorkbenchStore {
  readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  rows<T extends Fields = Fields>(table: string, suffix = '', ...parameters: SQLInputValue[]): T[] {
    return this.db.prepare(`SELECT * FROM ${table} ${suffix}`).all(...parameters).map(row => decode<T>(table, row));
  }

  row<T extends Fields = Fields>(table: string, key: string, value: SQLInputValue): T | undefined {
    const row = this.db.prepare(`SELECT * FROM ${table} WHERE ${key} = ?`).get(value);
    return row && decode<T>(table, row);
  }

  required<T extends Fields = Fields>(table: string, id: number): T {
    return this.row<T>(table, 'id', id) ?? fail(404, '记录不存在');
  }

  taskOwner(task: Task): unknown {
    if (task.owner_id !== undefined && task.owner_id !== 'local-admin') return task.owner_id;
    return this.row('governance_task_owners', 'task_id', task.id)?.user_id ?? task.owner_id;
  }

  allowedWorker(task: Task, principal: Principal): boolean {
    return principal.role === 'admin' || (principal.role === 'member' && this.taskOwner(task) === principal.user_id);
  }

  visibleTask(id: number, principal: Principal): Task {
    const task = this.row<Task>('tasks', 'id', id);
    if (!task || !this.allowedWorker(task, principal)) fail(404, '记录不存在');
    return task;
  }

  write<T>(run: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = run();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  addEvent(taskId: number, type: string, content: string, data: Fields): void {
    this.db.prepare(`INSERT INTO events (task_id, source, external_id, event_type, content, data, created_at)
      VALUES (?, 'web', NULL, ?, ?, ?, ?)`).run(taskId, type, content, JSON.stringify(data), now());
  }

  audit(actor: string, action: string, resource: number, details: Fields): void {
    this.db.prepare('INSERT INTO governance_audit(actor,action,resource,details,created_at) VALUES(?,?,?,?,?)')
      .run(actor, action, String(resource), JSON.stringify(details), now());
  }
}
