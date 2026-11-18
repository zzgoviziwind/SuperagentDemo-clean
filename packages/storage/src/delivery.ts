import { randomUUID } from 'node:crypto';
import { actionHash, check, nonempty, taskUpdate } from './core.ts';
import type { Core, Fields, Lease, Task } from './core.ts';
import type { ApprovalRow, Decision } from './approvals.ts';

interface Draft { id: number; task_id: number; event_id: number; approval_id: number; content: string }
interface Ledger { action_id: string; action_hash: string; claim_token: string | null; result: string }
export interface DeliveryPlan { source: 'redmine' | 'dingtalk'; kind: 'comment' | 'reply'; target: Fields; payload: { content: string } }
export interface DeliveryPolicyInput { draft: Readonly<Draft>; plan: DeliveryPlan; taskId: number; projectId: number; actionId: string }
export type DeliveryPolicy = (input: DeliveryPolicyInput) => { allowed: boolean; senderActorId?: string };
export interface Claim { actionId: string; actionHash: string; token: string; draftId: number }
type StoredEvent = { id: number; source: string; task_id: number | null; data: string };

function planFor(c: Core, t: Task, eventId: number, content: string): DeliveryPlan {
  nonempty(content, '回复草稿');
  const e = c.need<StoredEvent>('SELECT * FROM events WHERE id=? AND task_id=?', eventId, t.id);
  const data = JSON.parse(e.data);
  const meta = data.metadata ?? {};
  check(!meta.self_authored && !c.one("SELECT id FROM events WHERE task_id=? AND event_type='analysis_reference_scope'", t.id),
    '来源不可回复');
  check(data.routing_status === 'routed' || (data.routing_status === 'delivered' &&
    c.one('SELECT id FROM event_targets WHERE task_id=? AND message_event_id=? AND event_id=?', t.id, eventId, data.source_event_id ?? null)), '来源未路由到任务');
  if (e.source === 'redmine') {
    nonempty(meta.redmine_endpoint, 'Redmine 目标服务');
    const issue = Number(data.issue_id);
    check(Number.isSafeInteger(issue) && issue > 0, '缺少明确的工单编号');
    return { source: e.source, kind: 'comment', target: { base_url: meta.redmine_endpoint, issue_id: issue }, payload: { content } };
  }
  check(e.source === 'dingtalk', '不支持的回复渠道');
  const target: Fields = { profile: meta.profile, conversation_id: data.thread_id, message_id: meta.message_id };
  if (meta.dws_event_type === 'user_im_message_receive_o2o_all') target.recipient_id = data.actor_id;
  for (const [name,value] of Object.entries(target)) nonempty(value, name);
  return { source: e.source, kind: 'reply', target, payload: { content } };
}

function context(c: Core, draftId: number, hash: string) {
  const draft = c.need<Draft>('SELECT * FROM reply_drafts WHERE id=?', draftId);
  const t = c.need<Task>('SELECT * FROM tasks WHERE id=?', draft.task_id);
  const approval = c.need<ApprovalRow>('SELECT * FROM approvals WHERE id=? AND task_id=?', draft.approval_id, t.id);
  check(approval.action_hash === hash && t.revision === approval.revision && t.control_version === approval.control_version
    && t.status !== 'cancelled' && !t.outcome_unknown, '发送审批版本或哈希无效');
  const plan = planFor(c, t, draft.event_id, draft.content);
  const saved = JSON.parse(approval.action);
  check(actionHash({ ...plan }) === hash && actionHash({source: saved.source, kind: saved.kind, target: saved.target, payload: saved.payload}) === hash,
    '来源、内容或目标已变化');
  return { draft, t, plan, approval, actionId: 'reply-' + approval.id };
}
function authorize(c: Core, draftId: number, hash: string, policy: DeliveryPolicy) {
  const { draft, t, plan, approval, actionId } = context(c, draftId, hash);
  check(approval.status === 'approved', '缺少有效发送审批');
  const result = policy({ draft: {...draft}, plan: structuredClone(plan), taskId: t.id, projectId: t.project_id, actionId });
  check(result?.allowed === true, '渠道权限、规则或目标配置已变化');
  if (plan.source === 'redmine') nonempty(result.senderActorId, 'Redmine 发送账号');
  return { plan, sender: result.senderActorId ?? null };
}

function expired(time: unknown, age: number, now: number) {
  return typeof time === 'string' && Date.parse(time) <= now - age;
}
function retryable(data: Fields, now: number) {
  return (data.write_status === 'failed' && data.retryable === true && data.reason === 'claim_expired_before_dispatch')
    || (data.write_status === 'claimed' && expired(data.claimed_at, 30000, now));
}
function update(c: Core, row: Ledger, result: Fields, token: string | null) {
  const changed = c.run('UPDATE delivery_records SET result=?,claim_token=? WHERE action_id=? AND action_hash=? AND claim_token IS ? AND result=?',
    JSON.stringify(result), token, row.action_id, row.action_hash, row.claim_token, row.result);
  check(changed.changes === 1, '投递领取令牌或账本已变化');
}
export function recoverDeliveries(c: Core, exclusive: boolean) {
  const counts = { claims_expired: 0, dispatches_unknown: 0 };
  const rows = c.db.prepare("SELECT * FROM delivery_records WHERE json_extract(result,'$.write_status') IN ('claimed','dispatching')").all() as unknown as Ledger[];
  for (const row of rows) {
    const data: Fields = JSON.parse(row.result);
    if (data.write_status === 'claimed' && expired(data.claimed_at, 30000, c.clock())) {
      update(c, row, { ...data, write_status: 'failed', retryable: true, reason: 'claim_expired_before_dispatch' }, null);
      counts.claims_expired++;
    } else if (data.write_status === 'dispatching' && (exclusive || expired(data.dispatching_at, 120000, c.clock()))) {
      update(c, row, { ...data, write_status: 'unknown', reason: 'dispatch_outcome_pending_reconciliation' }, null);
      counts.dispatches_unknown++;
    }
  }
  return counts;
}
function claimedRow(c: Core, claim: Claim, state: string) {
  const row = c.need<Ledger>(`SELECT r.* FROM delivery_records r JOIN reply_drafts d ON r.action_id='reply-'||d.approval_id
    WHERE d.id=? AND r.action_id=? AND r.action_hash=? AND r.claim_token=? AND json_extract(r.result,'$.write_status')=?`,
    claim.draftId, claim.actionId, claim.actionHash, claim.token, state);
  return row;
}

export function delivery(c: Core) {
  return {
    createDraft(taskId: number, eventId: number, content: string) {
      return c.write(() => {
        const t = c.need<Task>('SELECT * FROM tasks WHERE id=?', taskId);
        const plan = planFor(c, t, eventId, content);
        const hash = actionHash({ ...plan });
        const approvalId = Number(c.run(`INSERT INTO approvals(task_id,revision,control_version,action_hash,action,status,created_at)
          VALUES(?,?,?,?,?,'pending',?)`, t.id,t.revision,t.control_version,hash,
          JSON.stringify({...plan, action_hash: hash, write_status:'preview'}), c.now()).lastInsertRowid);
        const draftId = Number(c.run('INSERT INTO reply_drafts(task_id,event_id,approval_id,content,created_at) VALUES(?,?,?,?,?)',
          t.id,eventId,approvalId,content,c.now()).lastInsertRowid);
        return { draftId, approvalId, actionHash: hash, actionId: 'reply-' + approvalId };
      });
    },
    decideDraft(draftId: number, decision: Decision, hash: string) {
      check(['approve','reject'].includes(decision), '审批决定无效');
      return c.write(() => {
        const { t, approval } = context(c, draftId, hash);
        check(approval.status === 'pending', '审批已处理');
        const status = decision === 'approve' ? 'approved' : 'rejected';
        c.run('UPDATE approvals SET status=? WHERE id=?', status, approval.id);
        c.event(t.id, 'delivery.approval', { draft_id: draftId, action_hash: hash }, decision, 'web');
        return status;
      });
    },
    claimDelivery(lease: Lease, draftId: number, hash: string, policy: DeliveryPolicy): Claim | null {
      return c.owned(lease, () => {
        const draft = c.need<Draft>('SELECT * FROM reply_drafts WHERE id=?', draftId);
        const actionId = 'reply-' + draft.approval_id;
        const row = c.one<Ledger>('SELECT * FROM delivery_records WHERE action_id=?', actionId);
        if (row) {
          check(row.action_hash === hash, '动作哈希与账本冲突');
          if (!retryable(JSON.parse(row.result), c.clock())) return null;
        }
        const { sender } = authorize(c, draftId, hash, policy);
        const token = randomUUID();
        const data: Fields = { action_id: actionId, action_hash: hash, write_status: 'claimed', claimed_at: c.now() };
        if (sender) data.sender_actor_id = sender;
        if (row) update(c,row,data,token);
        else c.run('INSERT INTO delivery_records(action_id,action_hash,result,created_at,claim_token) VALUES(?,?,?,?,?)',
          actionId,hash,JSON.stringify(data),c.now(),token);
        return { actionId, actionHash: hash, token, draftId };
      });
    },
    markDispatching(lease: Lease, claim: Claim, policy: DeliveryPolicy): DeliveryPlan {
      return c.owned(lease, () => {
        const row = claimedRow(c, claim, 'claimed');
        const data = JSON.parse(row.result);
        check(!expired(data.claimed_at, 30000, c.clock()), '发送领取已过期');
        const { plan, sender } = authorize(c, claim.draftId, claim.actionHash, policy);
        check(sender === (data.sender_actor_id ?? null), '发送账号已变化');
        update(c,row,{...data,write_status:'dispatching',dispatching_at:c.now()},claim.token);
        return plan;
      });
    },
    finishDelivery(lease: Lease, claim: Claim, receipt: Fields) {
      return c.owned(lease, () => {
        const row = claimedRow(c, claim, 'dispatching');
        const data = JSON.parse(row.result);
        const valid = ['succeeded','failed','unknown'].includes(String(receipt.write_status));
        const result: Fields = { ...data, ...(valid ? receipt : {write_status:'unknown',reason:'invalid_connector_result'}),
          action_id: row.action_id, action_hash: row.action_hash };
        // Receipts cannot mint retry authorization or rewrite persisted sender, dispatch or reconciliation evidence.
        for (const key of ['retryable','reconciled_at','reconciliation_evidence','sender_actor_id','echo_evidence','claimed_at','dispatching_at']) {
          if (key in data && key !== 'retryable') result[key] = data[key]; else delete result[key];
        }
        update(c,row,result,null);
        if (result.write_status === 'succeeded') {
          const t = c.one<Task>(`SELECT t.* FROM tasks t JOIN approvals a ON a.task_id=t.id WHERE 'reply-'||a.id=?
            AND t.kind='reply' AND t.status='review_ready' AND NOT t.outcome_unknown AND t.revision=a.revision AND t.control_version=a.control_version`, row.action_id);
          if (t) {
            taskUpdate(c,t,'status=?',t.status);
            c.event(t.id,'reply_sent',{revision:t.revision,control_version:t.control_version,action_id:row.action_id});
          }
        }
        return result;
      });
    },
    deliveryResult(actionId: string): Fields | null {
      const row = c.one<Ledger>('SELECT * FROM delivery_records WHERE action_id=?', actionId);
      return row ? JSON.parse(row.result) : null;
    },
    sweepDeliveries(lease: Lease) { return c.owned(lease, () => recoverDeliveries(c, false)); },
    reconcileDelivery(draftId: number, outcome: 'succeeded' | 'failed', evidence: string) {
      nonempty(evidence, '投递对账证据');
      check(['succeeded','failed'].includes(outcome), '对账结论无效');
      return c.write(() => {
        const draft = c.need<Draft>('SELECT * FROM reply_drafts WHERE id=?', draftId);
        const row = c.need<Ledger>("SELECT * FROM delivery_records WHERE action_id=? AND json_extract(result,'$.write_status')='unknown'",
          'reply-' + draft.approval_id);
        const result = {...JSON.parse(row.result), write_status:outcome, reconciliation_evidence:evidence, reconciled_at:c.now()};
        delete result.retryable;
        update(c,row,result,null);
        c.event(draft.task_id,'delivery.reconciled',{ action_id:row.action_id,outcome },evidence,'web');
        return result as Fields;
      });
    },
  };
}
