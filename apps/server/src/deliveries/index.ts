import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { FakeChannel } from '../../../../packages/runtime/fake-channel.ts';
import type { DeliveryPolicyInput, Fields, Lease, Storage } from '../../../../packages/storage/index.ts';
import { fail } from '../auth.js';
import { owned, serialize } from '../sql.js';
import { WorkbenchStore } from '../workbench/store.ts';
import { draftSourcePolicy, publishPolicy } from './policy.ts';
import { registerChannels } from './channels.ts';
export { registerChannels, connectorStatuses, reconcileChannels } from './channels.ts';
import { ChannelError } from '../../../../packages/channels/common.ts';
import { background } from './background.ts';
import { tickReplies } from './replies.ts';
export { prepareReplyDecision } from './replies.ts';

const key=z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const taskParams=z.object({task_id:key}), draftParams=z.object({draft_id:key});
const draftIn=z.object({event_id:key,content:z.string().min(1)});
const decisionIn=z.object({decision:z.enum(['approve','reject']),action_hash:z.string()});
const reconcileIn=z.object({outcome:z.enum(['succeeded','failed']),evidence:z.string().min(1)});
const taskRoute='/api/v1/tasks/:task_id/deliveries', draftRoute='/api/v1/deliveries/:draft_id';

function draftRow(store:Storage,id:number) {
  return store.db.prepare('SELECT * FROM reply_drafts WHERE id=?').get(id) ?? fail(404,'草稿不存在');
}
function approvalRow(store:Storage,draft:ReturnType<typeof draftRow>) {
  const row=store.db.prepare('SELECT * FROM approvals WHERE id=? AND task_id=?').get(draft.approval_id,draft.task_id);
  return row ?? fail(409,'草稿关联审批缺失');
}

// Awaiting fixture I/O must also bound graceful Fastify shutdown. A late I/O completion cannot settle the ledger.
function bounded<T>(promise:Promise<T>,ms:number):Promise<T> {
  let timer:ReturnType<typeof setTimeout>;
  const timeout=new Promise<never>((_,reject)=>{ timer=setTimeout(()=>reject(new Error('投递等待超时')),ms); });
  return Promise.race([promise,timeout]).finally(()=>clearTimeout(timer));
}

export function registerDeliveries(app:FastifyInstance,store:Storage,lease:Lease,root:string,env:NodeJS.ProcessEnv) {
  const builtins=registerChannels(app,store,lease,root,env);
  const workbench=new WorkbenchStore(store.db);
  app.get(taskRoute, async req=>{
    const {task_id}=taskParams.parse(req.params);
    workbench.visibleTask(task_id,req.principal);
    return store.db.prepare(`SELECT d.*,r.result AS delivery FROM reply_drafts d LEFT JOIN delivery_records r
      ON r.action_id='reply-'||d.approval_id WHERE d.task_id=? ORDER BY d.id`).all(task_id)
      .map(row=>({...row,delivery:row.delivery===null ? null : JSON.parse(String(row.delivery))}));
  });
  app.post(taskRoute, async req=>{
    const {task_id}=taskParams.parse(req.params), {event_id,content}=draftIn.parse(req.body);
    const task=owned(store.db,task_id,req.principal);
    draftSourcePolicy(store.db,env,task_id,Number(task.project_id),event_id);
    const created=store.createDraft(task_id,event_id,content);
    const draft=draftRow(store,created.draftId);
    return {...draft,approval:serialize(approvalRow(store,draft))};
  });
  app.post(draftRoute+'/decision',async req=>{
    const {draft_id}=draftParams.parse(req.params), input=decisionIn.parse(req.body);
    const draft=draftRow(store,draft_id);
    owned(store.db,Number(draft.task_id),req.principal);
    store.decideDraft(draft_id,input.decision,input.action_hash);
    return serialize(approvalRow(store,draft));
  });
  app.post(draftRoute+'/reconcile',async req=>{
    const {draft_id}=draftParams.parse(req.params), input=reconcileIn.parse(req.body);
    const draft=draftRow(store,draft_id);
    owned(store.db,Number(draft.task_id),req.principal);
    return store.reconcileDelivery(draft_id,input.outcome,input.evidence);
  });
  async function publish(draft_id:number,checkOwner:()=>void) {
    const draft=draftRow(store,draft_id), taskId=Number(draft.task_id);
    checkOwner();
    const approval=approvalRow(store,draft), actionId='reply-'+approval.id;
    store.sweepDeliveries(lease);
    const prior=store.deliveryResult(actionId);
    if(prior && !(prior.write_status==='failed' && prior.retryable===true && prior.reason==='claim_expired_before_dispatch')) return prior;
    const {source,target:approvedTarget}=JSON.parse(String(approval.action));
    if(source!=='redmine' && source!=='dingtalk') fail(409,'不支持该草稿渠道');
    const native=env.SUPERAGENT_DRIVER==='fixture'?undefined:builtins.prepare(source);
    const authorize=(input:DeliveryPolicyInput)=>{
      checkOwner();
      native?.check();
      return publishPolicy(store.db,env,input);
    };
    const claim=store.claimDelivery(lease,draft_id,String(approval.action_hash),authorize);
    if(!claim) return store.deliveryResult(actionId);
    // Open the sink before marking dispatch. Setup errors are still safely recoverable claims.
    let channel:FakeChannel|undefined;
    if(native) {
      try {await native.verify(approvedTarget);} catch {return fail(409,'渠道账号或目标未通过核验，请核对本机配置');}
    } else channel=await bounded(FakeChannel.open(root),5000);
    const plan=store.markDispatching(lease,claim,authorize);
    const target=plan.source==='redmine' ? {source:plan.source,threadId:String(plan.target.issue_id)}
      : {source:plan.source,threadId:String(plan.target.conversation_id),messageId:String(plan.target.message_id)};
    let receipt:Fields;
    let pending=true;
    try {
      if(native) receipt=await native.send(plan,actionId);
      else {
        const ack=await bounded(channel!.send({actionId,actionHash:claim.actionHash,target,content:plan.payload.content},point=>{
          if(pending && point==='after_receipt' && env.SUPERAGENT_DRIVER==='fixture'
            && env.SUPERAGENT_FIXTURE_EXIT_AFTER_RECEIPT==='1' && process.env.SUPERAGENT_DRIVER==='fixture'
            && process.env.SUPERAGENT_FIXTURE_EXIT_AFTER_RECEIPT==='1') process.kill(process.pid,'SIGKILL');
        }),5000);
        receipt=plan.source==='redmine' ? {write_status:'succeeded',verification:'not_performed'}
          : {write_status:'succeeded',verification:'succeeded',message_id:ack.id};
      }
    } catch(error) {
      receipt=error instanceof ChannelError && !error.uncertain ? {write_status:'failed',reason:error.message}
        : {write_status:'unknown',reason:'external_write_outcome_unknown'};
    } finally { pending=false; }
    return store.finishDelivery(lease,claim,receipt);
  }
  app.post(draftRoute+'/publish',async req=>{
    const {draft_id}=draftParams.parse(req.params);
    const taskId=Number(draftRow(store,draft_id).task_id);
    return publish(draft_id,()=>{owned(store.db,taskId,req.principal);});
  });
  background(app,'channel-replies',signal=>tickReplies(store,lease,env,signal,publish));
}
