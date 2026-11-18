import { actionHash, check, currentAttempt, nonempty, taskUpdate, workerMethods } from './core.ts';
import type { Core, Fields, Lease, WorkerMethod } from './core.ts';
import type { Turn } from './execution.ts';

export interface WorkerRequest extends Turn { method: WorkerMethod; requestId: string | number; params: Fields }
export type Decision = 'approve' | 'reject';
export interface ApprovalRow {
  id: number; task_id: number; revision: number; control_version: number; action_hash: string; action: string; status: string;
}
export interface WorkerDecision {
  decision: Decision; actionHash: string; actor: string;
  /** Recheck the authorized principal, capacity, deadline, active client and allowed workspace scope. */
  authorize: (action: Fields) => boolean;
}

const methods = ['item/fileChange/requestApproval','item/commandExecution/requestApproval'];
export function approvals(c: Core) {
  return {
    requestWorkerApproval(lease: Lease, id: string, request: WorkerRequest) {
      return c.owned(lease, () => {
        const { a, t } = currentAttempt(c, lease, id);
        check((a.phase === 'turn' || a.phase === 'approval') && a.turn_id && a.thread_id === request.threadId
          && a.turn_id === request.turnId && methods.includes(request.method), '审批不属于当前方法或轮次');
        check((typeof request.requestId === 'string' && request.requestId.trim()) || Number.isSafeInteger(request.requestId), '审批请求 ID 无效');
        const params = request.params;
        check((params.threadId === undefined || params.threadId === a.thread_id)
          && (params.turnId === undefined || params.turnId === a.turn_id), '审批参数与轮次不匹配');
        const action = { method: request.method, request_id: request.requestId, params, task_id: t.id,
          revision: t.revision, control_version: t.control_version, attempt_id: id };
        const hash = actionHash(action);
        const existing = c.one<ApprovalRow>(`SELECT * FROM approvals WHERE task_id=? AND json_extract(action,'$.attempt_id')=?
          AND json_extract(action,'$.request_id')=?`, t.id, id, request.requestId);
        if (existing) { check(existing.action_hash === hash, '同一审批请求的动作已变化'); return existing; }
        const added = c.run(`INSERT INTO approvals(task_id,revision,control_version,action_hash,action,status,created_at)
          VALUES(?,?,?,?,?,'pending',?)`, t.id, t.revision, t.control_version, hash, JSON.stringify(action), c.now());
        taskUpdate(c, t, "status='waiting_approval'");
        c.run("UPDATE execution_attempts SET phase='approval',status='waiting_approval',updated_at=? WHERE id=?", c.now(), id);
        c.event(t.id, 'approval_requested', { attempt_id: id, method: request.method });
        return c.need<ApprovalRow>('SELECT * FROM approvals WHERE id=?', added.lastInsertRowid);
      });
    },
    dispatchWorkerDecision(lease: Lease, id: string, approvalId: number, input: WorkerDecision) {
      nonempty(input.actor, '操作者');
      check(['approve','reject'].includes(input.decision), '审批决定无效');
      return c.owned(lease, () => {
        const { a, t } = currentAttempt(c, lease, id);
        const row = c.need<ApprovalRow>('SELECT * FROM approvals WHERE id=? AND task_id=?', approvalId, t.id);
        const action = JSON.parse(row.action) as Fields;
        check(row.status === 'pending' && t.status === 'waiting_approval' && a.status === 'waiting_approval'
          && row.revision === t.revision && row.control_version === t.control_version && action.attempt_id === id
          && methods.includes(String(action.method)) && row.action_hash === input.actionHash && actionHash(action) === input.actionHash,
          '审批动作、版本或执行尝试已过期');
        check(!c.one("SELECT id FROM approvals WHERE task_id=? AND status='dispatching' AND json_extract(action,'$.attempt_id')=?", t.id, id), '已有审批正在发送');
        check(input.decision !== 'approve' || t.kind === 'repair', '只读任务不能批准提权');
        check(input.authorize(action) === true, '审批授权或运行条件不满足');
        c.run("UPDATE approvals SET status='dispatching' WHERE id=?", approvalId);
        c.event(t.id, 'approval_decision', { approval_id: approvalId, attempt_id: id }, input.decision);
        c.audit(input.actor, 'approval.decide', approvalId, { approval_id: approvalId, decision: input.decision, revision: t.revision });
        return { requestId: action.request_id as string | number, decision: input.decision };
      });
    },
    finishWorkerDecision(lease: Lease, id: string, approvalId: number, receipt: 'confirmed' | 'unknown') {
      check(receipt === 'confirmed' || receipt === 'unknown', '审批发送结果无效');
      return c.owned(lease, () => {
        const row = c.need<ApprovalRow>("SELECT * FROM approvals WHERE id=? AND status='dispatching' AND json_extract(action,'$.attempt_id')=?", approvalId, id);
        const a = c.need<{status: string}>('SELECT status FROM execution_attempts WHERE id=? AND task_id=? AND owner=?', id, row.task_id, lease.owner);
        const t = c.need<import('./core.ts').Task>('SELECT * FROM tasks WHERE id=?', row.task_id);
        const trace = { approval_id: approvalId, attempt_id: id, revision: row.revision };
        const { content } = c.need<{content: Decision}>(`SELECT content FROM events WHERE task_id=? AND event_type='approval_decision'
          AND json_extract(data,'$.approval_id')=? AND json_extract(data,'$.attempt_id')=? ORDER BY id DESC LIMIT 1`, t.id, approvalId, id);
        if (t.status !== 'waiting_approval' || t.outcome_unknown || a.status !== 'waiting_approval'
            || t.revision !== row.revision || t.control_version !== row.control_version) {
          c.run("UPDATE approvals SET status='expired_after_dispatch' WHERE id=?", approvalId);
          c.event(t.id, 'stale_approval_dispatched', trace, content);
          return 'expired_after_dispatch';
        }
        if (receipt === 'unknown') {
          const reason = '审批响应结果未知，请人工对账';
          c.run("UPDATE approvals SET status='unknown' WHERE id=?", approvalId);
          c.run("UPDATE execution_attempts SET status='unknown',ended_at=?,updated_at=?,last_error=? WHERE id=?", c.now(), c.now(), reason, id);
          taskUpdate(c, t, "status='waiting_resource',outcome_unknown=1,last_error=?", reason);
          c.event(t.id, 'approval_response_unknown', trace);
          return 'unknown';
        }
        const status = content === 'approve' ? 'approved' : 'rejected';
        c.run('UPDATE approvals SET status=? WHERE id=?', status, approvalId);
        const pending = c.one("SELECT id FROM approvals WHERE task_id=? AND status='pending' AND revision=? AND control_version=? AND json_extract(action,'$.method') IN " + workerMethods,
          t.id, t.revision, t.control_version);
        taskUpdate(c, t, 'status=?', pending ? 'waiting_approval' : 'running');
        if (!pending) c.run("UPDATE execution_attempts SET status='running',phase='turn',updated_at=? WHERE id=?", c.now(), id);
        return status;
      });
    },
  };
}
