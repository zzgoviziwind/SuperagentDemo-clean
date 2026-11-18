import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue } from 'node:sqlite';
import { schema } from './schema.ts';

export interface Lease { readonly owner: string; readonly epoch: number }
export interface Options { clock?: () => number; stateRoot?: string }
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
export type Fields = { [key: string]: Json };
export type WorkerMethod = 'item/commandExecution/requestApproval' | 'item/fileChange/requestApproval';

export class StorageConflict extends Error {}
export function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new StorageConflict(message);
}
export function nonempty(value: unknown, name: string): asserts value is string {
  check(typeof value === 'string' && value.trim().length > 0, name + '不能为空');
}
export const active = "('claimed','running','waiting_approval')";
export const workerMethods = "('item/commandExecution/requestApproval','item/fileChange/requestApproval')";
export const stopping = '正在停止执行';
export function timestamp(ms: number) {
  return new Date(ms).toISOString().replace('Z', '000+00:00');
}

// Canonical JSON used by the Python previews. Restrict numeric input to losslessly portable integers.
function canonical(value: Json): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    return '{' + keys.map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  }
  if (typeof value === 'number') check(Number.isSafeInteger(value), '动作数值须为安全整数');
  return JSON.stringify(value);
}
export function actionHash(action: Fields) {
  return createHash('sha256').update(canonical(action)).digest('hex');
}

const additions = {
  projects: { archived: 'BOOLEAN NOT NULL DEFAULT false', reference_access: "VARCHAR(16) NOT NULL DEFAULT 'workspace'",
    reference_dirs: "JSON NOT NULL DEFAULT '[]'", repositories: "JSON NOT NULL DEFAULT '[]'" },
  tasks: { kind: "VARCHAR(16) NOT NULL DEFAULT 'repair'", owner_id: "VARCHAR(200) NOT NULL DEFAULT 'local-admin'",
    outcome_unknown: 'BOOLEAN NOT NULL DEFAULT false' },
  artifacts: { attempt_id: 'VARCHAR(36)' },
  execution_attempts: { manifest_id: 'INTEGER' },
  delivery_records: { claim_token: 'VARCHAR(36)' },
};

export class Core {
  readonly db: DatabaseSync;
  readonly clock: () => number;
  constructor(path: string, options: Options) {
    this.db = new DatabaseSync(path);
    this.clock = options.clock ?? Date.now;
    try {
      this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL');
      this.write(() => {
        this.db.exec(schema);
        for (const [table, columns] of Object.entries(additions)) {
          const present = new Set(this.db.prepare('PRAGMA table_info(' + table + ')').all().map(c => c.name));
          for (const [name, definition] of Object.entries(columns)) {
            if (!present.has(name)) this.db.exec('ALTER TABLE ' + table + ' ADD COLUMN ' + name + ' ' + definition);
          }
        }
      });
    } catch (e) { this.db.close(); throw e; }
  }
  now() { return timestamp(this.clock()); }
  one<T>(sql: string, ...args: SQLInputValue[]) {
    return this.db.prepare(sql).get(...args) as T | undefined;
  }
  need<T>(sql: string, ...args: SQLInputValue[]): T {
    const row = this.one<T>(sql, ...args);
    check(row, '记录不存在或状态已变化');
    return row;
  }
  run(sql: string, ...args: SQLInputValue[]) { return this.db.prepare(sql).run(...args); }
  write<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.db.exec('COMMIT');
      return result;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  assertLease(lease: Lease) {
    const row = this.one<{expires_at: string}>('SELECT expires_at FROM controller_leases WHERE id=? AND owner=? AND epoch=?',
      'controller', lease.owner, lease.epoch);
    check(row && Date.parse(row.expires_at) > this.clock(), '控制器租约已失效');
  }
  owned<T>(lease: Lease, operation: () => T) {
    return this.write(() => { this.assertLease(lease); return operation(); });
  }
  event(task: number | null, type: string, data: Fields, content = '', source = 'runtime') {
    this.run('INSERT INTO events(task_id,event_type,data,content,source,created_at) VALUES(?,?,?,?,?,?)',
      task, type, JSON.stringify(data), content, source, this.now());
  }
  audit(actor: string, action: string, resource: number, details: Fields) {
    nonempty(actor, '操作者');
    this.run('INSERT INTO governance_audit(actor,action,resource,details,created_at) VALUES(?,?,?,?,?)',
      actor, action, String(resource), JSON.stringify(details), this.now());
  }
}

export interface Attempt {
  id: string; task_id: number; attempt_no: number; status: string; phase: string; owner: string;
  revision: number; control_version: number; thread_id: string | null; turn_id: string | null;
  manifest_id: number | null; workspace_path: string | null; base_sha: string | null;
}
export interface Task {
  id: number; project_id: number; status: string; revision: number; control_version: number;
  state_version: number; outcome_unknown: number; last_error: string | null; kind: string;
  codex_thread_id: string | null; codex_turn_id: string | null;
}
export function currentAttempt(c: Core, lease: Lease, id: string) {
  const a = c.need<Attempt>('SELECT * FROM execution_attempts WHERE id=? AND owner=? AND status IN ' + active, id, lease.owner);
  const t = c.need<Task>('SELECT * FROM tasks WHERE id=? AND revision=? AND control_version=? AND NOT outcome_unknown',
    a.task_id, a.revision, a.control_version);
  check(t.status === 'running' || t.status === 'waiting_approval', '任务已停止或状态已变化');
  return { a, t };
}
export function taskUpdate(c: Core, t: Task, assignments: string, ...args: SQLInputValue[]) {
  const result = c.run('UPDATE tasks SET ' + assignments + ',state_version=state_version+1,updated_at=? WHERE id=? AND state_version=?',
    ...args, c.now(), t.id, t.state_version);
  check(result.changes === 1, '任务状态已变化');
}
