import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { active, check, nonempty, stopping, taskUpdate, timestamp, workerMethods } from './core.ts';
import type { Attempt, Core, Lease, Options, Task } from './core.ts';
import { recoverDeliveries } from './delivery.ts';

function recoverWorkerDecisions(c: Core) {
  // A committed decision records dispatch intent. Only a confirmed response can prove its outcome.
  // Older recovery could already have expired that intent together with unanswered requests.
  const rows = c.db.prepare(`SELECT a.id,a.task_id,a.revision,a.control_version,
      json_extract(a.action,'$.attempt_id') AS attempt_id FROM approvals a
    WHERE json_extract(a.action,'$.method') IN ${workerMethods} AND
      (a.status='dispatching' OR (a.status='expired_on_restart' AND EXISTS (
        SELECT 1 FROM events e WHERE e.task_id=a.task_id AND e.event_type='approval_decision'
          AND e.content IN ('approve','reject') AND json_extract(e.data,'$.approval_id')=a.id
          AND json_extract(e.data,'$.attempt_id') IS json_extract(a.action,'$.attempt_id'))))`).all() as unknown as
    {id:number; task_id:number; revision:number; control_version:number; attempt_id:string|null}[];
  const reason = '审批响应结果未知，请人工对账';
  for (const row of rows) {
    c.run("UPDATE approvals SET status='unknown' WHERE id=?", row.id);
    c.event(row.task_id, 'approval_response_unknown', {approval_id:row.id, attempt_id:row.attempt_id, revision:row.revision});
    const t = c.one<Task>('SELECT * FROM tasks WHERE id=? AND revision=? AND control_version=?',
      row.task_id, row.revision, row.control_version);
    if (t && !(t.status === 'waiting_resource' && t.outcome_unknown)) {
      taskUpdate(c, t, "status='waiting_resource',outcome_unknown=1,last_error=?", reason);
    }
  }
  const expired = c.run("UPDATE approvals SET status='expired_on_restart' WHERE status='pending' AND json_extract(action,'$.method') IN " + workerMethods);
  return { approvals_unknown: rows.length, approvals_expired: Number(expired.changes) };
}

function recover(c: Core) {
  const counts = { abandoned: 0, unknown: 0, legacy_unknown: 0, ...recoverWorkerDecisions(c) };
  const unknown = '服务重启，运行结果未知，请人工对账';
  const recovered = new Set<number>();
  const attempts = c.db.prepare('SELECT * FROM execution_attempts WHERE status IN ' + active).all() as unknown as Attempt[];
  for (const a of attempts) {
    const t = c.one<Task>('SELECT * FROM tasks WHERE id=?', a.task_id);
    const safe = a.turn_id === null && ['claimed','workspace','thread'].includes(a.phase)
      && a.status !== 'waiting_approval' && (!t || (t.status !== 'waiting_approval' && !t.outcome_unknown));
    const outcome = safe ? 'abandoned' : 'unknown';
    counts[outcome]++;
    c.run('UPDATE execution_attempts SET status=?,last_error=?,ended_at=?,updated_at=? WHERE id=?',
      outcome, safe ? null : unknown, c.now(), c.now(), a.id);
    if (!t || t.revision !== a.revision || t.control_version !== a.control_version) continue;
    recovered.add(a.task_id);
    if (!safe) {
      if (!(t.status === 'waiting_resource' && t.outcome_unknown)) {
        taskUpdate(c, t, "status='waiting_resource',outcome_unknown=1,last_error=?", unknown);
      }
    }
    else if (t.status === 'running' || t.last_error === stopping) {
      taskUpdate(c, t, 'status=?,outcome_unknown=0,last_error=NULL', t.last_error === stopping ? 'paused' : 'queued');
    }
  }
  const legacy = c.db.prepare("SELECT * FROM tasks WHERE status IN ('running','waiting_approval') OR (status='waiting_resource' AND last_error=?)")
    .all(stopping) as unknown as Task[];
  for (const t of legacy) {
    if (recovered.has(t.id)) continue;
    taskUpdate(c, t, "status='waiting_resource',outcome_unknown=1,last_error=?", unknown);
    counts.legacy_unknown++;
  }
  c.run("UPDATE router_sessions SET status='waiting_resource',outcome_unknown=1,last_error=?,updated_at=?,state_version=state_version+1 WHERE status='running'",
    '服务重启，Router 结果未知，请核验', c.now());
  c.run("UPDATE router_messages SET data=json_set(data,'$.status','unknown') WHERE json_extract(data,'$.status') IN ('queued','running')");
  c.event(null, 'startup_recovered', counts);
  return { ...counts, ...recoverDeliveries(c, true) };
}

export function controller(c: Core, path: string, options: Options) {
  let lock: DatabaseSync | undefined;
  let held: Lease | undefined;
  const unlock = () => { lock?.close(); lock = undefined; held = undefined; };
  function releaseLease(lease: Lease) {
    check(held && held.owner === lease.owner && held.epoch === lease.epoch, '本连接未持有该租约');
    try {
      c.write(() => c.run('UPDATE controller_leases SET expires_at=? WHERE id=? AND owner=? AND epoch=?',
        c.now(), 'controller', lease.owner, lease.epoch));
    } finally { unlock(); }
  }
  return {
    startController(owner: string) {
      nonempty(owner, '控制器标识');
      check(!lock, '本连接已持有租约');
      const root = options.stateRoot ?? dirname(path);
      const memory = path === ':memory:' && !options.stateRoot;
      if (!memory) mkdirSync(root, { recursive: true });
      // Dedicated SQLite connection holds an OS-backed lock until close or process death.
      lock = new DatabaseSync(memory ? ':memory:' : join(root, 'controller.lock.sqlite'));
      try {
        lock.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');
        return c.write(() => {
          const prior = c.one<{epoch: number; expires_at: string}>("SELECT epoch, expires_at FROM controller_leases WHERE id='controller'");
          check(!prior || Date.parse(prior.expires_at) <= c.clock(), '数据库控制器租约仍有效');
          const lease = Object.freeze({ owner, epoch: (prior?.epoch ?? 0) + 1 });
          c.run(`INSERT INTO controller_leases(id,owner,epoch,heartbeat_at,expires_at) VALUES('controller',?,?,?,?)
            ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,epoch=excluded.epoch,heartbeat_at=excluded.heartbeat_at,expires_at=excluded.expires_at`,
            owner, lease.epoch, c.now(), timestamp(c.clock() + 30000));
          held = lease;
          return { lease, recovery: recover(c) };
        });
      } catch (error) { unlock(); throw error; }
    },
    renewLease(lease: Lease) {
      c.owned(lease, () => c.run("UPDATE controller_leases SET heartbeat_at=?,expires_at=? WHERE id='controller'",
        c.now(), timestamp(c.clock() + 30000)));
    },
    releaseLease,
    close() {
      try { if (held) releaseLease(held); } finally { c.db.close(); }
    },
  };
}
