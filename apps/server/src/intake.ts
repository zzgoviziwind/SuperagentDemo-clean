import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { fail, roleOf } from './auth.js';
import { admin, audit, owned, record, serialize, tx, utc } from './sql.js';
import { settings } from './settings.js';
import { evaluateRules } from './rules.js';
import { accessSchema,admission,selectAdmissionProject } from './admission.js';
import { actionHash } from '../../../packages/storage/src/index.ts';
import { noActionReason } from './workbench/event-groups.js';
import { enqueueSemanticReceipt } from './workbench/scheduler.js';
import { stopFenced, type WorkerControl } from './controls.js';
import { recordRedmineEcho } from './deliveries/echo.ts';

const positive=z.int().positive(), kind=z.enum(['repair','analysis','reply']);
const taskInput=z.strictObject({project_id:positive,title:z.string().trim().min(1).max(300),goal:z.string().trim().min(1).max(100000),
  kind:kind.default('repair'),source:z.literal('web').default('web'),acceptance_criteria:z.string().default('')});
const receipt=z.object({source:z.enum(['dingtalk','redmine']),external_id:z.string().min(1).max(255),event_type:z.string().max(80).default('unknown'),
  content:z.string().max(100000).default(''),actor_id:z.string().optional(),project_external_id:z.string().optional(),
  thread_id:z.string().optional(),issue_id:z.union([positive,z.string()]).optional(),occurred_at:z.string().optional(),
  attachments:z.array(z.unknown()).max(100).default([]),metadata:z.record(z.string(),z.unknown()).default({})});
type Receipt=z.infer<typeof receipt>;
const followups=new WeakMap<DatabaseSync,{worker:WorkerControl;pending:Set<Promise<void>>}>();
function stopAffected(db:DatabaseSync,eventId:number) {
  const handler=followups.get(db);
  if(!handler) return;
  const targets=db.prepare(`SELECT t.id,t.control_version,t.kind FROM event_targets et
    JOIN tasks t ON t.id=et.task_id JOIN events e ON e.id=et.message_event_id
    WHERE et.event_id=? AND json_extract(e.data,'$.requires_interrupt') AND t.last_error='正在停止执行'`).all(eventId);
  for(const task of targets) {
    const promise=stopFenced(db,Number(task.id),Number(task.control_version),task.kind==='reply'?'queued':'waiting_input',handler.worker);
    handler.pending.add(promise);
    void promise.then(()=>handler.pending.delete(promise),()=>handler.pending.delete(promise));
  }
}
function ownMessageTarget(db:DatabaseSync,e:Receipt) {
  const m=e.metadata;
  if(!e.thread_id || typeof m.profile!=='string' || !m.profile || m.needs_confirmation) return;
  const base=`SELECT DISTINCT e.task_id FROM events e JOIN tasks t ON t.id=e.task_id
    WHERE e.source='dingtalk' AND json_extract(e.data,'$.thread_id')=? AND json_extract(e.data,'$.metadata.profile')=?
    AND json_extract(e.data,'$.routing_status') IN ('routed','manually_linked','self_context')`;
  const quote=m.reply_to_message_id;
  if(typeof quote==='string' && quote) {
    const rows=db.prepare(base+" AND json_extract(e.data,'$.metadata.message_id')=? LIMIT 2").all(e.thread_id,m.profile,quote);
    return rows.length===1?Number(rows[0].task_id):undefined;
  }
  if(m.conversation_type!=='direct'||!e.occurred_at||!/(?:Z|[+-]\d\d:\d\d)$/.test(e.occurred_at)) return;
  const rows=db.prepare(base+` AND json_extract(e.data,'$.metadata.conversation_type')='direct'
    AND json_extract(e.data,'$.routing_status')!='self_context'
    AND julianday(json_extract(e.data,'$.occurred_at')) BETWEEN julianday(?,'-30 minutes') AND julianday(?) LIMIT 2`)
    .all(e.thread_id,m.profile,e.occurred_at,e.occurred_at);
  return rows.length===1?Number(rows[0].task_id):undefined;
}
function newTask(db:DatabaseSync,project:number,owner:string,type:string,title:string,goal:string,source:string,ref:string|null,criteria='') {
  const now=utc();
  const row=db.prepare("INSERT INTO tasks(project_id,owner_id,kind,title,goal,source,source_ref,acceptance_criteria,status,revision,state_version,control_version,outcome_unknown,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,'queued',1,1,1,0,?,?) RETURNING *")
    .get(project,owner,type,title,goal,source,ref,criteria,now,now)!;
  db.prepare('INSERT INTO governance_task_owners(task_id,user_id) VALUES(?,?)').run(row.id,owner);
  return row;
}
function route(db:DatabaseSync,e:Receipt,id:number,env:NodeJS.ProcessEnv) {
  const original=db.prepare('SELECT data FROM events WHERE id=?').get(id)!;
  const prior=JSON.parse(String(original.data));
  const attempts=Array.isArray(prior._lifecycle)?prior._lifecycle:[];
  const started=utc();
  const checks:Record<string,unknown>={};
  const detail:Record<string,unknown>={rule_set:'ingestion-v4',checks,authorization:{status:'not_evaluated'},settings_provider:'database',input:{source:e.source,event_type:e.event_type,
    actor_id:e.actor_id??null,thread_id:e.thread_id??null,project_external_id:e.project_external_id??null,content_length:Array.from(e.content).length,
    at_me:e.metadata.at_me??null,needs_confirmation:e.metadata.needs_confirmation??null,uncertain_mentions:e.metadata.uncertain_mentions??null}};
  const steps=new Map<string,{status:string;reason:string;detail:unknown}>();
  const step=(stage:string,status:string,reason:string,info:unknown=null)=>steps.set(stage,{status,reason,detail:info});
  step('trigger','passed','event_received');
  const set=(status:string,reason:string,extra:object={})=>{
    const at=utc();
    if(!steps.has('fast_filter')) step('fast_filter',status==='ignored'||status==='self_context'?'skipped':'blocked',reason||status,detail);
    else if(status==='pending_confirmation') {
      const stage=/issue_reference|reply_reference|target_missing|task_references|reference_too_long/.test(reason)?'subscription':'router';
      step(stage,'blocked',reason);
    }
    if(status==='semantic_pending') step('slow_filter','pending','semantic_job_queued',{routing_session_id:'semantic:'+id});
    const stages=['trigger','fast_filter','slow_filter','subscription','router','worker','delivery','watchdog'].map(stage=>{
      const later=['worker','delivery','watchdog'].includes(stage);
      return {stage,...(steps.get(stage)??{status:later?'unknown':'skipped',reason:later?'not_recorded_in_routing_attempt':
        stage==='slow_filter'?'semantic_filter_disabled_or_fastpath':'stage_not_reached',detail:null}),at};
    });
    const data={...prior,...e,routing_status:status,routing_reason:reason,...extra,
      _lifecycle:[...attempts,{attempt:attempts.length+1,started_at:started,steps:stages}]};
    db.prepare('UPDATE events SET data=? WHERE id=?').run(JSON.stringify(data),id);
  };
  const pending=(reason:string)=>{detail.blocked_reason=reason;set('pending_confirmation',reason);};
  const cfg=settings(db);
  const access=e.source==='dingtalk'&&cfg.dingtalk_request_access?accessSchema.parse(cfg.dingtalk_request_access):null;
  const {actor,candidates}=admission(db,e,access);
  if(e.source==='dingtalk' && e.metadata.self_authored===true) {
    const target=ownMessageTarget(db,e);
    if(!target) return set('ignored','self_context_unmatched');
    db.prepare('UPDATE events SET task_id=? WHERE id=?').run(target,id);
    return set('self_context','');
  }
  const ignored=noActionReason({...e,data:e});
  if(ignored) return set('ignored',ignored);
  const person=access?.people.find(p=>p.actor_id===e.actor_id);
  if(access && (access.mode==='off'||person?.reply===false||access.mode==='selected'&&!person)) return set('ignored','sender_reply_disabled');
  checks.identity={rule:'mapped_actor_enabled',allowed:!!actor};
  if(!actor) return pending('actor_unmapped_or_disabled');
  detail.validated_actor_user_id=actor.user_id;
  const role=roleOf(env,String(actor.user_id)),grants=JSON.parse(String(actor.project_ids??'[]')),permissions=JSON.parse(String(actor.permissions??'[]'));
  detail.resolved_actor={user_id:actor.user_id,role,enabled:true,project_ids:grants,permissions};
  const direct=e.source==='dingtalk' && e.metadata.dws_event_type==='user_im_message_receive_o2o_all';
  const policy=cfg.dingtalk_response_policy as {direct_messages:string;group_messages:string;default_project_id:number|null;group_scope?:string;group_chat_ids?:string[]};
  const policyAllowed=e.source!=='dingtalk'||(direct ? policy.direct_messages!=='off' : policy.group_messages!=='off' &&
    !(policy.group_messages==='mentions' && e.metadata.at_me!==true) && !(policy.group_messages==='requests' && policy.group_scope==='selected' && !policy.group_chat_ids?.includes(e.thread_id??'')));
  detail.effective_response_policy=e.source==='dingtalk'?policy:null;
  detail.policy_allowed=e.source==='dingtalk'?policyAllowed:null;
  checks.response_policy={rule:'dingtalk_response_scope',status:e.source==='dingtalk'?'evaluated':'not_applicable',allowed:detail.policy_allowed};
  if(!policyAllowed) return set('ignored','message_response_policy_off_or_scope');
  const field=e.source==='dingtalk'?'dingtalk_chat_ids':'redmine_project_ids';
  let projects=db.prepare('SELECT id,enabled FROM projects WHERE archived=0 AND EXISTS (SELECT 1 FROM json_each('+field+') WHERE CAST(value AS TEXT)=?)').all(e.project_external_id??'');
  if(!projects.length && direct && policy.default_project_id) projects=db.prepare('SELECT id,enabled FROM projects WHERE id=? AND archived=0').all(policy.default_project_id);
  let clarification=false;
  if(access) ({projects,clarification}=selectAdmissionProject(db,id,e,access,candidates??[]));
  detail.project_candidates=projects.map(p=>({id:p.id,enabled:!!p.enabled}));
  checks.project_binding={rule:'single_enabled_project',allowed:projects.length===1&&!!projects[0].enabled};
  if(projects.length!==1 || !projects[0].enabled) {
    pending('project_binding_missing_ambiguous_or_disabled');
    if(cfg.semantic_routing_enabled) enqueueSemanticReceipt(db,id,env);
    return;
  }
  const project=Number(projects[0].id);
  detail.selected_project_id=project;
  const grantChecks=[{rule:'actor_role_admin_or_member',allowed:role==='admin'||role==='member'},
    {rule:'project_in_actor_grants',allowed:grants.some((value:unknown)=>String(value)===String(project))},
    {rule:'request_permission_required',allowed:permissions.includes('request')}];
  const authorized=grantChecks.every(c=>c.allowed);
  detail.authorization={status:authorized?'passed':'blocked',allowed:authorized,project_id:project,rules:grantChecks};
  checks.authorization={rule:'project_request_authorization',allowed:authorized};
  if(!authorized) return pending('actor_not_authorized_for_project');
  const echo=recordRedmineEcho(db,e,id,project,env);
  checks.delivery_echo={rule:'confirmed_delivery_echo_filter',allowed:!echo};
  if(echo) {
    detail.blocked_reason=echo.status;
    step('fast_filter','blocked',echo.status,detail);
    return set(echo.status,'',{delivery_action_id:echo.actionId,echo_journal_id:echo.journal,echo_reason:echo.reason});
  }
  const supported=(e.source==='dingtalk'?['message.received']:['issue.comment','issue.changed','issue.updated']).includes(e.event_type);
  checks.event_type={rule:'supported_source_event_type',allowed:supported};
  if(!supported) return pending('unsupported_event_type');
  const uncertain=e.metadata.uncertain_mentions;
  const contentAllowed=!!e.content.trim() && !(Array.isArray(uncertain)?uncertain.length:Boolean(uncertain)) && !e.metadata.needs_confirmation;
  checks.message_content={rule:'unambiguous_nonempty_message',allowed:contentAllowed};
  if(!contentAllowed) return pending('ambiguous_or_empty_request');
  const readOnlyPattern=/只读|只(?:做)?分析|仅(?:做)?分析|分析即可|(?:不要|不允许|禁止|不)(?:修改|改动|改写|调整)(?:(?:任何)?(?:代码|文件)|(?=[，。,；;\s]|$))/gi;
  const readonly=e.content.search(readOnlyPattern)!==-1;
  const changes=/修复|修改|改动|改写|新增|实现|调整|优化|增加功能|\b(?:fix|implement|modify)\b/i.test(e.content.replace(readOnlyPattern,''));
  const question=/做好(?:了)?(?:没|吗)|完成(?:了)?(?:没|吗)|进度|进展|为什么|为何|怎么|如何|什么|哪些|哪个|多少|是否|能否|可否|是不是|行不行|有没有|要不要|能不能|可不可以|[吗么]\s*[？?]?\s*$/i;
  const requestedKind=changes?(readonly?'conflict':'repair'):readonly||question.test(e.content)?'analysis':null;
  checks.request_kind={rule:'no_conflicting_analysis_and_write',allowed:requestedKind!=='conflict',requested_kind:requestedKind};
  if(requestedKind==='conflict') return pending('conflicting_analysis_and_write_request');
  const progress=direct&&!/请|帮我|麻烦|需要你/.test(e.content)&&/做好(?:了)?(?:没|吗)|完成(?:了)?(?:没|吗)|进度|进展|是否(?:已|完成)|做(?:完|到哪)|(?:修复|修好|解决|上线|部署|发布|通过|换模型|好了)(?:了)?(?:没|吗|么)|(?:修好|解决|上线|部署|发布)了(?:是|对)么|为什么.*(?:模型|接口|报错)/.test(e.content);
  const type=clarification?'reply':progress?'analysis':changes?'repair':direct&&!readonly&&!/分析|排查|检查/.test(e.content)?'reply':'analysis';
  step('fast_filter','passed','identity_project_type_and_input_validated',detail);
  const rules=evaluateRules(db,e.source,project,type,e);
  if(rules.has('pause')||rules.has('quiet')) return pending('private_policy_hold');
  const issues=new Set([...e.content.matchAll(/(?<![\p{L}\p{N}_])#(\d+)\b/gu)].map(m=>m[1]));
  if(e.issue_id) issues.add(String(e.issue_id));
  if(issues.size>1 || [...issues].some(n=>!/^\d+$/.test(n))) return pending('ambiguous_issue_reference');
  const profile=String(e.metadata.profile??'');
  const subscribers=e.thread_id?db.prepare(`SELECT s.id subscription_id,t.*,CASE WHEN t.owner_id='local-admin' THEN COALESCE(o.user_id,t.owner_id) ELSE t.owner_id END effective_owner
    FROM worker_subscriptions s JOIN tasks t ON t.id=s.task_id LEFT JOIN governance_task_owners o ON o.task_id=t.id
    WHERE s.enabled AND s.project_id=? AND t.project_id=s.project_id AND s.source=? AND s.thread_id=? AND s.profile=? AND
    NOT t.outcome_unknown AND t.status NOT IN ('completed','cancelled') ORDER BY s.id`)
    .all(project,e.source,e.thread_id,profile).filter(t=>{
      const blocks=evaluateRules(db,e.source,project,String(t.kind),e);
      return !blocks.has('pause')&&!blocks.has('quiet') && (roleOf(env,String(actor.user_id))==='admin'||t.effective_owner===actor.user_id);
    }):[];
  if(subscribers.length) {
    for(const t of subscribers) {
      const interrupt=['running','waiting_approval'].includes(String(t.status));
      const msg=db.prepare("INSERT INTO events(task_id,source,event_type,content,data,created_at) VALUES(?,?,'message',?,?,?)")
        .run(t.id,e.source,e.content,JSON.stringify({...e,actor:actor.user_id,source_event_id:id,subscription_id:t.subscription_id,routing_status:'delivered',requires_interrupt:interrupt}),utc());
      db.prepare(`UPDATE tasks SET revision=revision+1,control_version=control_version+1,state_version=state_version+1,updated_at=?,
        last_error=CASE WHEN ? THEN '正在停止执行' WHEN status='review_ready' THEN '收到订阅事件，请确认后继续' ELSE last_error END,
        status=CASE WHEN ? THEN 'waiting_resource' WHEN status='review_ready' THEN 'waiting_input' ELSE status END WHERE id=?`).run(utc(),Number(interrupt),Number(interrupt),t.id);
      db.prepare("UPDATE approvals SET status='expired' WHERE task_id=? AND status='pending'").run(t.id);
      db.prepare('INSERT INTO event_targets(event_id,task_id,subscription_id,message_event_id,created_at) VALUES(?,?,?,?,?)').run(id,t.id,t.subscription_id,msg.lastInsertRowid,utc());
      if(e.attachments.length) {
        db.prepare("INSERT INTO event_attachment_jobs(event_id,task_id,revision,control_version,status,results) SELECT ?,id,revision,control_version,'pending','[]' FROM tasks WHERE id=?").run(msg.lastInsertRowid,t.id);
        db.prepare("UPDATE tasks SET status='waiting_resource',last_error='正在准备来源附件' WHERE id=? AND status='queued'").run(t.id);
      }
    }
    const taskIds=subscribers.map(t=>t.id);
    step('subscription','passed','explicit_subscriptions_fanout',{task_ids:taskIds});
    step('router','passed','fanout_applied');
    return set('routed','',{actor:actor.user_id,target_task_ids:taskIds});
  }
  const messageKey=(message:string)=>'dingtalk:message:'+actionHash({profile,conversation:e.thread_id??e.project_external_id??null,message_id:message});
  const ownKey=e.source==='dingtalk'?messageKey(String(e.metadata.message_id??e.external_id)):'redmine:message:'+createHash('sha256').update(JSON.stringify(e.external_id)).digest('hex');
  const quoted=e.source==='dingtalk'?e.metadata.reply_to_message_id:null;
  if(quoted!=null && (typeof quoted!=='string'||!quoted.trim()||quoted===e.metadata.message_id)) return pending('invalid_reply_reference');
  const replyKey=typeof quoted==='string'?messageKey(quoted):null;
  const directKey=direct && type==='reply'&&!replyKey&&!issues.size?'dingtalk:direct:'+actionHash({profile:e.metadata.profile?profile:null,conversation:e.thread_id??null,actor:e.actor_id??null}):null;
  const reference=issues.size?'issue:'+Array.from(issues)[0]:replyKey??directKey??ownKey;
  const aliases=[...new Set([reference,ownKey,...(replyKey?[replyKey]:[])])];
  if(aliases.some(key=>key.length>255)) return pending('reference_too_long');
  const routes=db.prepare('SELECT route_key,task_id FROM task_routes WHERE project_id=? AND route_key IN (SELECT value FROM json_each(?))').all(project,JSON.stringify(aliases));
  const targets=new Set(routes.map(r=>Number(r.task_id)));
  if(replyKey && !routes.some(r=>r.route_key===replyKey)) {
    const bound=db.prepare(`SELECT DISTINCT t.id FROM events e JOIN tasks t ON t.id=e.task_id WHERE
      t.project_id=? AND e.source='dingtalk' AND json_extract(data,'$.routing_status') IN ('routed','manually_linked','self_context')
      AND json_extract(data,'$.thread_id')=? AND COALESCE(json_extract(data,'$.metadata.profile'),'')=? AND json_extract(data,'$.metadata.message_id')=?`)
      .all(project,e.thread_id??'',profile,String(quoted));
    const sent=db.prepare(`SELECT DISTINCT d.task_id id FROM reply_drafts d JOIN approvals a ON a.id=d.approval_id
      JOIN delivery_records r ON r.action_id='reply-'||a.id JOIN tasks t ON t.id=d.task_id
      WHERE t.project_id=? AND json_extract(a.action,'$.source')='dingtalk'
      AND json_extract(a.action,'$.target.profile') IS ? AND json_extract(a.action,'$.target.conversation_id')=?
      AND json_extract(r.result,'$.write_status')='succeeded' AND json_extract(r.result,'$.message_id')=?
      AND (?=0 OR json_extract(a.action,'$.target.recipient_id')=?)`).all(project,e.metadata.profile?profile:null,e.thread_id??'',String(quoted),Number(direct),e.actor_id??'');
    const linked=new Set([...bound,...sent].map(row=>Number(row.id)));
    if(linked.size!==1) return pending('reply_target_missing_or_ambiguous');
    targets.add([...linked][0]);
  }
  const latest=new Set<number>();
  for(const target of targets) {
    const next=db.prepare(`SELECT r.task_id FROM tasks t JOIN task_routes r ON r.project_id=t.project_id AND r.route_key=t.source_ref
      WHERE t.project_id=? AND t.id=? AND t.status IN ('completed','cancelled')`).get(project,target);
    latest.add(next?Number(next.task_id):target);
  }
  if(latest.size>1) return pending('conflicting_task_references');
  let task=latest.size?db.prepare('SELECT * FROM tasks WHERE id=? AND project_id=?').get([...latest][0],project):undefined;
  step('subscription','passed',task?'existing_task_matched':'no_existing_task',{candidate_task_ids:[...targets],selected_task_id:task?.id??null});
  if(task) {
    const holds=evaluateRules(db,e.source,project,String(task.kind),e);
    if(holds.has('pause')||holds.has('quiet')) return pending('private_policy_hold');
    if(issues.size && db.prepare("SELECT 1 FROM task_routes WHERE project_id=? AND task_id=? AND route_key LIKE 'issue:%' AND route_key!=? LIMIT 1")
      .get(project,task.id,reference)) return pending('conflicting_issue_reference');
  }
  if(task && roleOf(env,String(actor.user_id))!=='admin') {
    const owner=task.owner_id==='local-admin'?db.prepare('SELECT user_id FROM governance_task_owners WHERE task_id=?').get(task.id)?.user_id??task.owner_id:task.owner_id;
    if(owner!==actor.user_id) return pending('task_owned_by_another_user');
  }
  const previous=task && ['completed','cancelled'].includes(String(task.status))?Number(task.id):null;
  const created=!task||previous!==null;
  const interrupt=!!task && ['running','waiting_approval'].includes(String(task.status));
  if(created && cfg.semantic_routing_enabled && type!=='reply' && !clarification) {
    pending('routing_policy_requires_review');
    enqueueSemanticReceipt(db,id,env);
    return;
  }
  if(created && type!=='reply' && e.source==='dingtalk' && !(cfg.dingtalk_route_all_mentions && e.metadata.at_me) &&
    !/[？?]|请|帮我|分析|排查|检查|修复|修改|实现|新增|调整|继续|增加|优化|完成|为何|为什么|怎么|如何|什么|哪些|哪个|多少|是否|能否|可否|进度|进展|[吗么]\s*$|\b(?:fix|implement|please|investigate|add)\b/i.test(e.content)) return pending('explicit_request_required');
  if(task && !previous) {
    if(task.outcome_unknown) return pending('target_outcome_unknown');
    if(task.last_error==='正在停止执行') return pending('followup_requires_current_worker');
    const nextKind=direct && type==='reply' && task.kind==='analysis' && replyKey?'analysis':type;
    db.prepare(`UPDATE tasks SET revision=revision+1,state_version=state_version+1,control_version=control_version+1,updated_at=?,kind=?,
      source_ref=COALESCE(?,source_ref),last_error=CASE WHEN ? THEN '正在停止执行' ELSE last_error END,
      status=CASE WHEN ? THEN 'waiting_resource' WHEN status='review_ready' THEN ? ELSE status END WHERE id=?`)
      .run(utc(),nextKind,issues.size?reference:null,Number(interrupt),Number(interrupt),nextKind==='reply'?'queued':'waiting_input',task.id);
    db.prepare("UPDATE approvals SET status='expired' WHERE task_id=? AND status='pending'").run(task.id);
    db.prepare("UPDATE events SET event_type='message' WHERE id=?").run(id);
  } else task=newTask(db,project,String(actor.user_id),type,e.content.trim().split(/\r?\n/)[0].slice(0,300),
    clarification?'先确认项目归属。原始消息如下\n'+e.content:e.content,e.source,reference);
  for(const alias of aliases) db.prepare('INSERT INTO task_routes(project_id,route_key,task_id) VALUES(?,?,?) ON CONFLICT(project_id,route_key) DO UPDATE SET task_id=excluded.task_id').run(project,alias,task.id);
  db.prepare('UPDATE events SET task_id=? WHERE id=?').run(task.id,id);
  db.prepare('INSERT INTO event_targets(event_id,task_id,message_event_id,created_at) VALUES(?,?,?,?)').run(id,task.id,id,utc());
  step('router','passed',created?'created_task':'reused_task',{task_id:task.id,method:'deterministic_rules'});
  set('routed','',{actor:actor.user_id,original_event_type:e.event_type,related_task_id:previous,requires_interrupt:interrupt,
    ...(clarification?{project_clarification:true,candidate_project_ids:candidates??[]}:{}),...(e.attachments.length?{attachments_status:'pending'}:{})});
  if(e.attachments.length) {
    db.prepare("INSERT INTO event_attachment_jobs(event_id,task_id,revision,control_version,status,results) SELECT ?,id,revision,control_version,'pending','[]' FROM tasks WHERE id=?").run(id,task.id);
    db.prepare("UPDATE tasks SET status='waiting_resource',last_error='正在准备来源附件' WHERE id=? AND status='queued'").run(task.id);
  }
}
export function ingest(db:DatabaseSync,payload:unknown,env:NodeJS.ProcessEnv) {
  const e=receipt.parse(payload);
  const receiptRow=tx(db,()=>{
    const prev=db.prepare('SELECT * FROM events WHERE source=? AND external_id=?').get(e.source,e.external_id);
    if(prev) return {...serialize(prev),id:Number(prev.id),duplicate:true};
    const id=Number(db.prepare('INSERT INTO events(source,external_id,event_type,content,data,created_at) VALUES(?,?,?,?,?,?)').run(e.source,e.external_id,e.event_type,e.content,JSON.stringify(e),utc()).lastInsertRowid);
    route(db,e,id,env);
    return {...serialize(db.prepare('SELECT * FROM events WHERE id=?').get(id)!),id,duplicate:false};
  });
  if(!receiptRow.duplicate) stopAffected(db,Number(receiptRow.id));
  return receiptRow;
}
export function registerIntake(app:FastifyInstance,db:DatabaseSync,env:NodeJS.ProcessEnv,worker?:WorkerControl) {
  if(worker) {
    const pending=new Set<Promise<void>>();
    followups.set(db,{worker,pending});
    app.addHook('preClose',async()=>{followups.delete(db);await Promise.allSettled([...pending]);});
  }
  app.post('/api/v1/subscriptions',async req=>{
    admin(req.principal);
    const v=z.object({project_id:positive,task_id:positive,source:z.enum(['redmine','dingtalk']),
      thread_id:z.string().min(1).max(255).refine(s=>!!s.trim()),profile:z.string().max(255).default('')}).parse(req.body);
    return tx(db,()=>{
      const t=db.prepare(`SELECT p.dingtalk_chat_ids FROM tasks t JOIN projects p ON p.id=t.project_id
        WHERE t.id=? AND p.id=? AND p.enabled AND NOT p.archived AND NOT t.outcome_unknown
        AND t.status NOT IN ('completed','cancelled')`).get(v.task_id,v.project_id);
      if(!t) return fail(422,'目标任务不可订阅或身份无权限');
      if(v.source==='dingtalk' && !JSON.parse(String(t.dingtalk_chat_ids)).map(String).includes(v.thread_id))
        return fail(422,'线程未绑定当前项目');
      const key=actionHash({source:v.source,thread_id:v.thread_id,profile:v.profile});
      const result=db.prepare(`INSERT INTO worker_subscriptions(project_id,task_id,source,thread_id,profile,thread_key,enabled,created_at)
        VALUES(?,?,?,?,?,?,1,?) ON CONFLICT(project_id,thread_key,task_id) DO UPDATE SET enabled=1 RETURNING *`)
        .get(v.project_id,v.task_id,v.source,v.thread_id,v.profile,key,utc())!;
      audit(db,req.principal.user_id,'subscription.create',Number(result.id),v);
      return serialize(result);
    });
  });
  app.delete('/api/v1/subscriptions/:id',async req=>{
    admin(req.principal);
    const {id}=z.object({id:z.coerce.number().int().positive()}).parse(req.params);
    return tx(db,()=>{
      const result=db.prepare('UPDATE worker_subscriptions SET enabled=0 WHERE id=? RETURNING *').get(id)??fail(404,'订阅不存在');
      audit(db,req.principal.user_id,'subscription.cancel',id);
      return serialize(result);
    });
  });
  app.post('/api/v1/tasks',async req=>{
    if(req.principal.role==='viewer') fail(403,'无权创建任务');
    const t=taskInput.parse(req.body);
    return tx(db,()=>{
      const p=db.prepare('SELECT enabled,archived FROM projects WHERE id=?').get(t.project_id)??fail(404,'项目不存在');
      if(!p.enabled || p.archived) fail(409,'项目已禁用');
      const row=newTask(db,t.project_id,req.principal.user_id,t.kind,t.title,t.goal,'web',null,t.acceptance_criteria);
      record(db,Number(row.id),'created',t.goal);
      audit(db,req.principal.user_id,'task.create',Number(row.id));
      return serialize(row);
    });
  });
  app.post('/api/v1/events',async req=>{
    admin(req.principal);
    return ingest(db,req.body,env);
  });
  app.post('/api/v1/events/:id/retry-routing',async req=>{
    admin(req.principal);
    const {id}=z.object({id:z.coerce.number().int().positive()}).parse(req.params);
    const result=tx(db,()=>{
      const row=db.prepare('SELECT * FROM events WHERE id=?').get(id)??fail(409,'事件不存在');
      const data=JSON.parse(String(row.data));
      if(data.routing_status==='routed') return {...serialize(row),duplicate:true};
      if(data.routing_status!=='pending_confirmation' || row.task_id!==null) fail(409,'事件不属于待确认收件箱');
      const e=receipt.parse({...data,source:row.source,external_id:row.external_id,event_type:row.event_type,content:row.content});
      route(db,e,id,env);
      audit(db,req.principal.user_id,'event.retry_routing',id);
      return {...serialize(db.prepare('SELECT * FROM events WHERE id=?').get(id)!),duplicate:false};
    });
    if(!result.duplicate) stopAffected(db,id);
    return result;
  });
}
