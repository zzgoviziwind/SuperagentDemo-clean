import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type { DeliveryPolicyInput } from '../../../../packages/storage/index.ts';
import { fail, roleOf } from '../auth.js';
import { accessSchema, admission } from '../admission.js';
import { evaluateRules } from '../rules.js';
import { settings } from '../settings.js';

function deny(): never { return fail(409,'当前来源、授权或渠道配置已变化，请核对草稿'); }
const positive = z.number().int().positive();
type SourceData = { actor_id?: string; thread_id?: string; routing_status?: string; occurred_at?: string;project_external_id?:string;
  source_event_id?: number; metadata?: {profile?:string;source_account_ids?:string[];redmine_endpoint?:string;external_user_id?:string;self_authored?:boolean;
    dws_event_type?:string;at_me?:boolean;reply_to_message_id?:string;message_id?:string} };
function sourceEvent(db: DatabaseSync, event: number, task: number) {
  const row=db.prepare('SELECT id,source,data,created_at FROM events WHERE id=? AND task_id=?').get(event,task);
  if(!row || (row.source!=='redmine' && row.source!=='dingtalk')) deny();
  return { id:Number(row.id),source:row.source, data:JSON.parse(String(row.data)) as SourceData, createdAt:String(row.created_at) };
}
function connector(db:DatabaseSync, env:NodeJS.ProcessEnv, source:string) {
  const key='connectors.'+source;
  const stored=db.prepare('SELECT value FROM governance_settings WHERE key=?').get(key);
  if(stored && stored.value !== null && JSON.parse(String(stored.value)) !== null) {
    return settings(db)[key] as {base_url?:string;user_id?:number;enabled?:boolean;profile?:string;project_ids?:number[];self_ids?:string[]};
  }
  const raw=env['SUPERAGENT_'+source.toUpperCase()+'_CONFIG'];
  if(!raw) return {};
  try {
    return z.object({enabled:z.boolean().optional(),base_url:z.string().url().optional(),profile:z.string().optional(),
      self_ids:z.array(z.string()).optional(),user_id:positive.optional(),project_ids:z.array(positive).optional()}).parse(JSON.parse(raw));
  } catch { return deny(); }
}
function canUseSource(db:DatabaseSync,env:NodeJS.ProcessEnv,projectId:number,e:ReturnType<typeof sourceEvent>,config:Record<string,unknown>) {
  if(e.data.metadata?.self_authored) return false;
  if(e.source !== 'dingtalk' || config.dingtalk_request_access === null) return true;
  const parsed=accessSchema.safeParse(config.dingtalk_request_access);
  if(!parsed.success) return false;
  const {actor}=admission(db,{source:e.source,actor_id:e.data.actor_id,thread_id:e.data.thread_id,content:'',metadata:e.data.metadata??{}},parsed.data);
  return !!actor && ['admin','member'].includes(roleOf(env,String(actor.user_id))??'')
    && JSON.parse(String(actor.permissions??'[]')).includes('request') && JSON.parse(String(actor.project_ids??'[]')).includes(projectId);
}
export function draftSourcePolicy(db:DatabaseSync,env:NodeJS.ProcessEnv,taskId:number,projectId:number,eventId:number) {
  const e=sourceEvent(db,eventId,taskId), cfg=connector(db,env,e.source);
  if(!canUseSource(db,env,projectId,e,settings(db))) deny();
  if(e.source==='redmine' ? !cfg.base_url || cfg.base_url.replace(/\/+$/,'')!==e.data.metadata?.redmine_endpoint
      : !cfg.profile || cfg.profile!==e.data.metadata?.profile) deny();
  return {e,cfg};
}
type ReplyPolicy = {delivery:string;reply_guidance?:string;reply_max_age_minutes?:number;direct_messages:string;
  group_messages:string;group_scope?:string;group_chat_ids?:string[]};
function eventTime(e:ReturnType<typeof sourceEvent>) {
  const instant=Date.parse(e.data.occurred_at ?? '');
  return Number.isFinite(instant) ? instant : Date.parse(e.createdAt);
}
function checkAutomatic(db:DatabaseSync,env:NodeJS.ProcessEnv,input:DeliveryPolicyInput,e:ReturnType<typeof sourceEvent>,
    policy:ReplyPolicy,config:Record<string,unknown>) {
  const {taskId,projectId,draft,actionId}=input;
  const decision=db.prepare(`SELECT e.data FROM events e JOIN tasks t ON t.id=e.task_id JOIN projects p ON p.id=t.project_id
    WHERE t.id=? AND t.status='review_ready' AND p.enabled AND NOT p.archived AND e.source='runtime' AND e.event_type='reply_decision'
    AND json_extract(e.data,'$.revision')=t.revision AND json_extract(e.data,'$.control_version')=t.control_version ORDER BY e.id DESC LIMIT 1`).get(taskId);
  if(!decision || policy.delivery!=='auto_send') deny();
  const d=JSON.parse(String(decision.data)), meta=e.data.metadata ?? {};
  const guidance=createHash('sha256').update(JSON.stringify(policy.reply_guidance ?? '')).digest('hex');
  if(d.decision!=='send' || d.source_event_id!==e.id || d.draft_id!==draft.id || d.guidance_hash!==guidance) deny();
  if(e.source==='dingtalk') {
    if(meta.dws_event_type==='user_im_message_receive_o2o_all') { if(policy.direct_messages!=='reply') deny(); }
    else if(policy.group_messages==='off' || (policy.group_messages==='mentions' && !meta.at_me)
      || (policy.group_messages==='requests' && policy.group_scope==='selected' && !policy.group_chat_ids?.includes(e.data.thread_id ?? ''))) deny();
  }
  const time=eventTime(e), age=Date.now()-time;
  if(!Number.isFinite(age) || age < -30000 || age > (policy.reply_max_age_minutes ?? 120)*60000) deny();
  const candidates=db.prepare(`SELECT id,source,data,created_at,task_id FROM events WHERE source IN ('redmine','dingtalk')
    AND (task_id=? OR id IN(SELECT event_id FROM event_targets WHERE task_id=?))`).all(taskId,taskId);
  for(const row of candidates) {
    const other={id:Number(row.id),source:String(row.source),data:JSON.parse(String(row.data)) as SourceData,createdAt:String(row.created_at)};
    const at=eventTime(other);
    if(at<time || (at===time && other.id<=e.id)) continue;
    const m=other.data.metadata ?? {};
    if(e.source==='dingtalk' && other.source===e.source && other.data.routing_status==='self_context'
      && !other.data.source_event_id && other.data.thread_id===e.data.thread_id && m.profile===meta.profile
      && (m.reply_to_message_id==null || m.reply_to_message_id===meta.message_id)) deny();
    if(row.task_id!==taskId || !canUseSource(db,env,projectId,other,config)) continue;
    if(other.data.routing_status==='routed' || (other.data.routing_status==='delivered' && db.prepare(
      'SELECT id FROM event_targets WHERE task_id=? AND message_event_id=? AND event_id=?').get(taskId,other.id,other.data.source_event_id ?? null))) deny();
  }
  const origin=e.data.source_event_id ?? e.id;
  if(db.prepare(`SELECT r.action_id FROM delivery_records r JOIN reply_drafts d ON r.action_id='reply-'||d.approval_id
    JOIN events e ON e.id=d.event_id WHERE e.source=? AND (e.id=? OR json_extract(e.data,'$.source_event_id')=?)
    AND r.action_id<>? AND json_extract(r.result,'$.write_status') IN ('claimed','dispatching','unknown','succeeded') LIMIT 1`)
    .get(e.source,origin,origin,actionId)) deny();
}
export function publishPolicy(db:DatabaseSync,env:NodeJS.ProcessEnv,input:DeliveryPolicyInput) {
  const {taskId,projectId,draft}=input;
  const {e,cfg}=draftSourcePolicy(db,env,taskId,projectId,draft.event_id);
  const config=settings(db), policy=config.dingtalk_response_policy as ReplyPolicy;
  if(config.external_delivery_enabled!==true || cfg.enabled!==true) deny();
  if(e.source==='dingtalk' && !['auto_send','approved_send'].includes(policy.delivery)) deny();
  if(e.source==='dingtalk' && e.data.metadata?.source_account_ids &&
    JSON.stringify(e.data.metadata.source_account_ids)!==JSON.stringify([...new Set(cfg.self_ids??[])].sort())) deny();
  if(e.source==='redmine' && (!cfg.user_id || (e.data.metadata?.external_user_id!=null && String(e.data.metadata.external_user_id)!==String(cfg.user_id))
    || (cfg.project_ids?.length && e.data.project_external_id && !cfg.project_ids.includes(Number(e.data.project_external_id))))) deny();
  const auto=!!db.prepare("SELECT id FROM events WHERE task_id=? AND event_type='delivery.auto_authorized' AND json_extract(data,'$.draft_id')=?").get(taskId,draft.id);
  const kind=db.prepare('SELECT kind FROM tasks WHERE id=?').get(taskId)?.kind;
  const rules=evaluateRules(db,e.source,projectId,String(kind),e.data);
  if (rules.has('pause') || rules.has('quiet') || (auto && rules.size)) deny();
  if(auto) checkAutomatic(db,env,input,e,policy,config);
  return {allowed:true,senderActorId:e.source==='redmine' ? String(cfg.user_id) : undefined};
}
