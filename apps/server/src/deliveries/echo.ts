import type { DatabaseSync } from 'node:sqlite';
import { actionHash, type Fields } from '../../../../packages/storage/index.ts';
import { audit, utc } from '../sql.js';

export { ingest as ingestChannelEvent } from '../intake.js';

interface EchoReceipt {
  source:string;
  event_type:string;
  issue_id?:string|number;
  actor_id?:string;
  content:string;
  occurred_at?:string;
  metadata:Record<string,unknown>;
  attachments:unknown[];
}

function configuredSender(db:DatabaseSync,env:NodeJS.ProcessEnv,endpoint:string,actorId:string) {
  const row=db.prepare("SELECT value FROM governance_settings WHERE key='connectors.redmine'").get();
  try {
    const config=(row?JSON.parse(String(row.value)):null) ?? JSON.parse(env.SUPERAGENT_REDMINE_CONFIG??'null');
    return !!config?.user_id && String(config.user_id)===actorId &&
      typeof config.base_url==='string' && config.base_url.replace(/\/+$/,'')===endpoint;
  } catch {
    return false;
  }
}

function instant(value:unknown) {
  if(typeof value!=='string') return;
  const match=/\d\d:\d\d:\d\d(?:\.(\d+))?(?:Z|[+-]\d\d:\d\d)$/.exec(value);
  if(!match) return;
  const millis=Date.parse(value);
  if(!Number.isFinite(millis)) return;
  const fraction=(match[1]??'').padEnd(6,'0');
  return {millis,micros:Number(fraction.slice(3,6)),wholeSecond:Number(fraction.slice(0,6))===0};
}

// Called after source authorization, within the receipt's existing write transaction.
export function recordRedmineEcho(db:DatabaseSync,e:EchoReceipt,id:number,project:number,env:NodeJS.ProcessEnv) {
  const {journal_id:journalId,redmine_endpoint:endpoint,details}=e.metadata;
  const actorId=e.actor_id;
  const hasDetails=details && (typeof details!=='object'||Object.keys(details).length>0);
  if(e.source!=='redmine'||e.event_type!=='issue.comment'||!e.content||!actorId||
    !((typeof journalId==='string'&&journalId.trim())||(typeof journalId==='number'&&Number.isSafeInteger(journalId)&&journalId>0))||
    hasDetails||e.attachments.length||
    typeof endpoint!=='string'||!endpoint||!configuredSender(db,env,endpoint,actorId)) return;
  const issue=String(e.issue_id??'').trim();
  const issueId=Number(issue), occurred=instant(e.occurred_at);
  if(!/^\+?\d+$/.test(issue)||!Number.isSafeInteger(issueId)||issueId<=0||!occurred) return;

  const journal=String(journalId);
  const key=actionHash({endpoint,issue_id:issueId,journal_id:journal});
  const rows=db.prepare(`SELECT r.action_id,r.action_hash,r.result,r.created_at,d.task_id,b.event_id AS bound_event_id,
    json_extract(a.action,'$.target') AS approved_target,
    json_extract(original.data,'$.routing_status') AS original_status,json_extract(original.data,'$.echo_reason') AS original_reason
    FROM delivery_records r JOIN reply_drafts d ON r.action_id='reply-'||d.approval_id
    JOIN approvals a ON a.id=d.approval_id AND a.task_id=d.task_id JOIN tasks t ON t.id=d.task_id
    LEFT JOIN delivery_echo_bindings b ON b.action_id=r.action_id LEFT JOIN events original ON original.id=b.event_id
    WHERE t.project_id=? AND a.action_hash=r.action_hash
    AND json_extract(a.action,'$.kind')='comment' AND json_extract(a.action,'$.source')='redmine'
    AND d.content=? AND json_extract(a.action,'$.target.base_url')=?
    AND json_extract(a.action,'$.target.issue_id')=? AND json_extract(a.action,'$.payload.content')=?
    AND json_extract(r.result,'$.write_status') IN ('succeeded','unknown','dispatching')
    AND json_extract(r.result,'$.sender_actor_id')=? AND (b.journal_key IS NULL OR b.journal_key=?)
    AND NOT EXISTS(SELECT 1 FROM delivery_echo_bindings other WHERE other.journal_key=? AND other.action_id<>r.action_id)
    ORDER BY r.created_at,r.action_id`).all(project,e.content,endpoint,issueId,e.content,actorId,key,key);
  for(const row of rows) {
    try {
      const target=JSON.parse(String(row.approved_target)) as Fields;
      if(row.action_hash!==actionHash({source:'redmine',kind:'comment',target,payload:{content:e.content}})) continue;
    } catch {
      continue;
    }
    const saved=JSON.parse(String(row.result));
    const sent=instant(saved.dispatching_at || row.created_at);
    if(!sent) continue;
    const elapsed=((occurred.millis-sent.millis)*1000+occurred.micros-sent.micros)/1_000_000;
    if(elapsed < -30 || elapsed > 120) continue;
    const unknown=saved.write_status!=='succeeded', overlap=elapsed<0;
    const status=unknown||overlap?'self_echo_candidate':'self_echo';
    const reason=unknown?'write_outcome_unknown':overlap
      ? occurred.wholeSecond&&elapsed>-1?'source_second_precision_overlap':'source_clock_skew_overlap'
      : 'matched_successful_write';
    const actionId=String(row.action_id);
    db.prepare('UPDATE events SET task_id=? WHERE id=?').run(row.task_id,id);
    if(row.bound_event_id!==null) {
      // Different external IDs can refer to the same journal. Keep the original receipt and audit.
      return {status:row.original_status==='self_echo'||row.original_status==='self_echo_candidate'?row.original_status:status,
        reason:typeof row.original_reason==='string'?row.original_reason:reason,actionId,journal};
    }

    db.prepare('INSERT INTO delivery_echo_bindings(journal_key,action_id,event_id,created_at) VALUES(?,?,?,?)').run(key,actionId,id,utc());
    const evidence={event_id:id,journal_id:journal,occurred_at:e.occurred_at,routing_status:status,reason,
      actor_id:actorId,endpoint,issue_id:issueId,claimed_at:row.created_at,elapsed_seconds:elapsed};
    db.prepare("UPDATE delivery_records SET result=json_set(result,'$.echo_evidence',json(?)) WHERE action_id=?")
      .run(JSON.stringify(evidence),actionId);
    audit(db,'system','delivery.'+status,actionId,evidence);
    return {status,reason,actionId,journal};
  }
}
