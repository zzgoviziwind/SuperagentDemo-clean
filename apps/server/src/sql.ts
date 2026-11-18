import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import { fail, type Principal } from './auth.js';

export type Row = Record<string,SQLOutputValue>;
export const utc = () => new Date().toISOString().replace('Z', '000+00:00');
export function tx<T>(db: DatabaseSync, work: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
const jsonFields = new Set(['data','action','details','result','target','project_ids','permissions','allowed_paths',
  'reference_dirs','repositories','dingtalk_chat_ids','redmine_project_ids']);
const boolFields = new Set(['enabled','archived','outcome_unknown']);
export function serialize(row: Row) {
  return Object.fromEntries(Object.entries(row).map(([key,value]) => {
    if (typeof value === 'string' && jsonFields.has(key)) return [key, JSON.parse(value) as unknown];
    return [key,boolFields.has(key) ? Boolean(value) : value];
  }));
}
export function admin(p: Principal) {
  if (p.role !== 'admin') fail(403, '仅管理员可执行此操作');
}
export function owned(db: DatabaseSync, id: number, p: Principal) {
  const task = db.prepare('SELECT * FROM tasks WHERE id=?').get(id) ?? fail(404, '任务不存在');
  const owner = task.owner_id === 'local-admin'
    ? db.prepare('SELECT user_id FROM governance_task_owners WHERE task_id=?').get(id)?.user_id ?? task.owner_id
    : task.owner_id;
  if (p.role !== 'admin' && (p.role !== 'member' || p.user_id !== owner)) fail(403, '无权处理此任务');
  return task;
}
export function audit(db: DatabaseSync, actor: string, action: string, resource: string | number, details: object = {}) {
  db.prepare('INSERT INTO governance_audit(actor,action,resource,details,created_at) VALUES(?,?,?,?,?)')
    .run(actor,action,String(resource),JSON.stringify(details),utc());
}
export function record(db: DatabaseSync, taskId: number, kind: string, content: string, data: object = {}) {
  return db.prepare("INSERT INTO events(task_id,source,event_type,content,data,created_at) VALUES(?,'web',?,?,?,?) RETURNING *")
    .get(taskId,kind,content,JSON.stringify(data),utc())!;
}
