import type { DatabaseSync } from 'node:sqlite';
import type { Incoming } from '../../../../packages/channels/common.ts';
import { actionHash } from '../../../../packages/storage/index.ts';
import { ingest } from '../intake.js';
import { tx,utc } from '../sql.js';

function matchEcho(db:DatabaseSync,e:Incoming) {
  const m=e.metadata;
  if(e.source!=='redmine'||e.event_type!=='issue.comment'||!m.journal_id||!e.issue_id||!e.content||
     e.attachments.length || (Array.isArray(m.details) && m.details.length) || e.actor_id!==m.external_user_id) return;
  const target={base_url:m.redmine_endpoint,issue_id:Number(e.issue_id)};
  const hash=actionHash({source:e.source,kind:'comment',target,payload:{content:e.content}});
  const key=actionHash({endpoint:m.redmine_endpoint,issue_id:target.issue_id,journal_id:String(m.journal_id)});
  const rows=db.prepare(`SELECT r.action_id,r.result,r.created_at,d.task_id FROM delivery_records r JOIN reply_drafts d
    ON r.action_id='reply-'||d.approval_id JOIN approvals a ON a.id=d.approval_id
    WHERE r.action_hash=? AND a.action_hash=r.action_hash AND json_extract(a.action,'$.kind')='comment' AND json_extract(a.action,'$.source')='redmine'
    AND d.content=? AND json_extract(a.action,'$.target.base_url')=?
    AND json_extract(a.action,'$.target.issue_id')=? AND json_extract(a.action,'$.payload.content')=?
    AND json_extract(r.result,'$.write_status') IN ('succeeded','unknown','dispatching')
    AND json_extract(r.result,'$.sender_actor_id')=?
    AND NOT EXISTS(SELECT 1 FROM delivery_echo_bindings b WHERE (b.action_id=r.action_id AND b.journal_key<>?)
    OR (b.journal_key=? AND b.action_id<>r.action_id)) ORDER BY r.created_at,r.action_id`)
    .all(hash,e.content,String(m.redmine_endpoint),target.issue_id,e.content,e.actor_id,key,key);
  for(const r of rows) {
    const data=JSON.parse(String(r.result)), elapsed=(Date.parse(e.occurred_at)-Date.parse(data.dispatching_at??String(r.created_at)))/1000;
    if(!Number.isFinite(elapsed)||elapsed < -30||elapsed>120) continue;
    const uncertain=data.write_status!=='succeeded'||elapsed<0;
    const coarse=elapsed<0 && elapsed>-1 && new Date(e.occurred_at).getUTCMilliseconds()===0 && !/\.\d*[1-9]\d*Z$/.test(e.occurred_at);
    return {key,actionId:String(r.action_id),taskId:Number(r.task_id),elapsed,claimedAt:r.created_at,status:uncertain?'self_echo_candidate':'self_echo',
      reason:data.write_status!=='succeeded'?'write_outcome_unknown':coarse?'source_second_precision_overlap':elapsed<0?'source_clock_skew_overlap':'matched_successful_write'};
  }
}
export function ingestChannelEvent(db:DatabaseSync,event:Incoming,env:NodeJS.ProcessEnv) {
  // The shared ingress accepts an optional ambiguity marker. Empty arrays are truthy in JS.
  if(Array.isArray(event.metadata.uncertain_mentions) && event.metadata.uncertain_mentions.length===0) {
    const {uncertain_mentions:_,...metadata}=event.metadata;
    event={...event,metadata};
  }
  const echo=matchEcho(db,event);
  if(!echo) return ingest(db,event,env);
  const receipt=ingest(db,{...event,metadata:{...event.metadata,self_authored:true}},env);
  tx(db,()=>{
    const id=db.prepare('SELECT id FROM events WHERE source=? AND external_id=?').get(event.source,event.external_id)!.id;
    const prior=db.prepare('SELECT event_id FROM delivery_echo_bindings WHERE journal_key=?').get(echo.key);
    if(prior && prior.event_id!==id) return;
    const saved=db.prepare('SELECT data FROM events WHERE id=?').get(id)!;
    const data=JSON.parse(String(saved.data));
    if(data.delivery_action_id===echo.actionId) return;
    db.prepare('INSERT OR IGNORE INTO delivery_echo_bindings(journal_key,action_id,event_id,created_at) VALUES(?,?,?,?)').run(echo.key,echo.actionId,id,utc());
    const binding=db.prepare('SELECT event_id FROM delivery_echo_bindings WHERE journal_key=? AND action_id=?').get(echo.key,echo.actionId);
    if(binding?.event_id!==id) return;
    db.prepare('UPDATE events SET task_id=?,data=? WHERE id=?').run(echo.taskId,JSON.stringify({...data,routing_status:echo.status,
      echo_journal_id:String(event.metadata.journal_id),delivery_action_id:echo.actionId,echo_reason:echo.reason}),id);
    const evidence=JSON.stringify({event_id:id,journal_id:String(event.metadata.journal_id),occurred_at:event.occurred_at,
      routing_status:echo.status,reason:echo.reason,actor_id:event.actor_id,endpoint:event.metadata.redmine_endpoint,
      issue_id:Number(event.issue_id),claimed_at:echo.claimedAt,elapsed_seconds:echo.elapsed});
    db.prepare("UPDATE delivery_records SET result=json_set(result,'$.echo_evidence',json(?)) WHERE action_id=?").run(evidence,echo.actionId);
    db.prepare('INSERT INTO governance_audit(actor,action,resource,details,created_at) VALUES(?,?,?,?,?)')
      .run('system','delivery.'+echo.status,echo.actionId,evidence,utc());
  });
  return receipt;
}
