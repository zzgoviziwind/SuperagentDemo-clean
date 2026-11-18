import { randomUUID } from 'node:crypto';
import { active, check, currentAttempt, nonempty, taskUpdate, workerMethods } from './core.ts';
import type { Attempt, Core, Fields, Json, Lease, Task } from './core.ts';

export interface ArtifactInput { kind: string; content: string }
export interface Turn { threadId: string; turnId: string }
export function execution(c: Core) {
  return {
    claimTask(lease: Lease, taskId: number) {
      return c.owned(lease, () => {
        const changed = c.run(`UPDATE tasks SET status='running',state_version=state_version+1,last_error=NULL,codex_turn_id=NULL,
          updated_at=? WHERE id=? AND status='queued' AND NOT outcome_unknown
          AND NOT EXISTS(SELECT 1 FROM execution_attempts WHERE task_id=tasks.id AND status IN ` + active + ')', c.now(), taskId);
        if (!changed.changes) return null;
        const id = randomUUID();
        c.run(`INSERT INTO execution_attempts(id,task_id,attempt_no,status,phase,owner,revision,control_version,updated_at)
          SELECT ?,id,(SELECT COALESCE(MAX(attempt_no),0)+1 FROM execution_attempts WHERE task_id=tasks.id),
          'claimed','claimed',?,revision,control_version,? FROM tasks WHERE id=?`, id, lease.owner, c.now(), taskId);
        return c.need<Attempt>('SELECT * FROM execution_attempts WHERE id=?', id);
      });
    },
    beginAttempt(lease: Lease, id: string) {
      return c.owned(lease, () => {
        const { a, t } = currentAttempt(c, lease, id);
        check(a.status === 'claimed' && t.status === 'running', '该尝试已启动');
        c.run("UPDATE execution_attempts SET status='running',started_at=?,updated_at=? WHERE id=?", c.now(), c.now(), id);
        c.event(t.id, 'run_started', { attempt_id: id, revision: t.revision, control_version: t.control_version });
      });
    },
    recordWorkspace(lease: Lease, id: string, path: string, baseSha: string | Fields | null) {
      nonempty(path, '工作区');
      c.owned(lease, () => {
        const { a, t } = currentAttempt(c, lease, id);
        check(a.status === 'running' && a.phase === 'claimed', '工作区登记阶段已变化');
        c.run("UPDATE execution_attempts SET phase='workspace',workspace_path=?,base_sha=?,updated_at=? WHERE id=?",
          path, baseSha === null ? null : JSON.stringify(baseSha), c.now(), id);
        taskUpdate(c, t, 'workspace_path=?', path);
        c.event(t.id, 'workspace_prepared', { attempt_id: id, path, base_sha: baseSha });
      });
    },
    recordThread(lease: Lease, id: string, threadId: string) {
      nonempty(threadId, 'thread ID');
      c.owned(lease, () => {
        const { a, t } = currentAttempt(c, lease, id);
        check(a.status === 'running' && ['claimed','workspace'].includes(a.phase), 'thread 登记阶段已变化');
        c.run("UPDATE execution_attempts SET phase='thread',thread_id=?,updated_at=? WHERE id=?", threadId, c.now(), id);
        taskUpdate(c, t, 'codex_thread_id=?', threadId);
      });
    },
    prepareTurn(lease: Lease, id: string, items?: Json[]) {
      return c.owned(lease, () => {
        const { a, t } = currentAttempt(c, lease, id);
        check(a.status === 'running' && a.phase === 'thread' && a.thread_id && a.thread_id === t.codex_thread_id, '轮次已派发或 thread 已变化');
        let manifestId: number | null = null;
        if (items !== undefined) {
          check(Array.isArray(items), '上下文清单格式错误');
          manifestId = Number(c.run(`INSERT INTO context_manifests(attempt_id,task_id,project_id,revision,control_version,
            thread_id,budget_chars,items,created_at) VALUES(?,?,?,?,?,?,80000,?,?)`, id, t.id, t.project_id, t.revision,
            t.control_version, a.thread_id, JSON.stringify(items), c.now()).lastInsertRowid);
          const included = items.filter((item): item is Fields => !!item && typeof item === 'object' && !Array.isArray(item)
            && item.type === 'decision' && item.included === true);
          c.event(t.id, 'context_manifest_saved', { attempt_id: id, manifest_id: manifestId, decision_ids: included.map(item => item.id) });
        }
        c.run("UPDATE execution_attempts SET phase='turn',manifest_id=?,updated_at=? WHERE id=?", manifestId, c.now(), id);
        return manifestId;
      });
    },
    bindTurn(lease: Lease, id: string, turn: Turn) {
      nonempty(turn.turnId, 'turn ID');
      c.owned(lease, () => {
        const { a, t } = currentAttempt(c, lease, id);
        check(a.phase === 'turn' && !a.turn_id && a.thread_id === turn.threadId && t.codex_thread_id === turn.threadId, '轮次归属已变化');
        if (a.manifest_id !== null) {
          const row = c.run(`UPDATE context_manifests SET turn_id=? WHERE id=? AND turn_id IS NULL AND attempt_id=?
            AND task_id=? AND project_id=? AND thread_id=? AND revision=? AND control_version=?`,
            turn.turnId, a.manifest_id, id, t.id, t.project_id, turn.threadId, t.revision, t.control_version);
          check(row.changes === 1, '上下文清单缺失或已绑定');
          c.event(t.id, 'context_manifest_linked', { attempt_id: id, manifest_id: a.manifest_id, turn_id: turn.turnId });
        }
        c.run('UPDATE execution_attempts SET turn_id=?,updated_at=? WHERE id=?', turn.turnId, c.now(), id);
        taskUpdate(c, t, 'codex_turn_id=?', turn.turnId);
      });
    },
    completeAttempt(lease: Lease, id: string, turn: Turn, artifacts: ArtifactInput[]) {
      return c.owned(lease, () => {
        const { a, t } = currentAttempt(c, lease, id);
        check(a.status === 'running' && a.phase === 'turn' && t.status === 'running' && a.turn_id &&
          a.turn_id === turn.turnId && a.thread_id === turn.threadId && t.codex_turn_id === turn.turnId
          && t.codex_thread_id === turn.threadId, '非当前轮次结果');
        if (a.manifest_id !== null) c.need(`SELECT id FROM context_manifests WHERE id=? AND attempt_id=? AND task_id=?
          AND project_id=? AND revision=? AND control_version=? AND thread_id=? AND turn_id=?`,
          a.manifest_id, id, t.id, t.project_id, t.revision, t.control_version, turn.threadId, turn.turnId);
        check(artifacts.length > 0, '缺少经调用方核验的本轮证据');
        for (const art of artifacts) {
          nonempty(art.kind, '产物种类');
          nonempty(art.content, '产物内容');
          c.run('INSERT INTO artifacts(task_id,revision,kind,content,created_at,attempt_id) VALUES(?,?,?,?,?,?)',
            t.id, t.revision, art.kind, art.content, c.now(), id);
        }
        c.run("UPDATE execution_attempts SET status='completed',phase='done',ended_at=?,updated_at=? WHERE id=?", c.now(), c.now(), id);
        taskUpdate(c, t, "status='review_ready',last_error=NULL");
        c.event(t.id, 'review_ready', { attempt_id: id, revision: t.revision, thread_id: turn.threadId, turn_id: turn.turnId });
      });
    },
    failAttempt(lease: Lease, id: string, reason: string) {
      nonempty(reason, '失败原因');
      return c.owned(lease, () => {
        const { a, t } = currentAttempt(c, lease, id);
        const uncertain = !!a.turn_id || !['claimed','workspace','thread'].includes(a.phase);
        c.run('UPDATE execution_attempts SET status=?,ended_at=?,updated_at=?,last_error=? WHERE id=?',
          uncertain ? 'unknown' : 'failed', c.now(), c.now(), reason, id);
        taskUpdate(c, t, 'status=?,outcome_unknown=?,last_error=?', uncertain ? 'waiting_resource' : 'failed', Number(uncertain), reason);
        c.run("UPDATE approvals SET status='expired' WHERE task_id=? AND status='pending' AND json_extract(action,'$.method') IN " + workerMethods, t.id);
        c.event(t.id, 'run_error', { attempt_id: id }, reason);
      });
    },
    reconcileTask(lease: Lease, taskId: number, input: { outcome: 'stopped' | 'abandoned'; evidence: string;
      expectedStateVersion: number; actor: string; isStopped: () => boolean }) {
      nonempty(input.evidence, '对账证据');
      check(['stopped','abandoned'].includes(input.outcome), '对账结论无效');
      return c.owned(lease, () => {
        const t = c.need<Task>('SELECT * FROM tasks WHERE id=?', taskId);
        check(t.outcome_unknown && t.state_version === input.expectedStateVersion && input.isStopped() === true, '任务仍活跃、版本过期或没有未知结果');
        check(!c.one('SELECT id FROM execution_attempts WHERE task_id=? AND status IN ' + active, t.id), '尚有未结束的执行尝试');
        const status = input.outcome === 'stopped' ? 'paused' : 'cancelled';
        taskUpdate(c, t, 'status=?,outcome_unknown=0,last_error=NULL,revision=revision+1,control_version=control_version+1', status);
        c.run("UPDATE approvals SET status='expired' WHERE task_id=? AND status IN ('pending','dispatching')", t.id);
        c.event(t.id, 'execution_reconciled', { outcome: input.outcome }, input.evidence, 'web');
        c.audit(input.actor, 'task.reconcile', t.id, { status, revision: t.revision + 1 });
        return c.need<Task>('SELECT * FROM tasks WHERE id=?', t.id);
      });
    },
  };
}
