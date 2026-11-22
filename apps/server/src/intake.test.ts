import Fastify from 'fastify';
import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStorage } from '../../../packages/storage/index.ts';
import { draftFor, seed } from '../../../packages/storage/tests/helpers.ts';
import { registerAuth } from './auth.js';
import { ingestChannelEvent } from './deliveries/echo.ts';
import { registerIntake } from './intake.js';
import { assembleContext } from './context.ts';
import { admitSemantic, applyDecision, semanticContext } from './workbench/semantic-engine.ts';
import { WorkbenchStore, type Event } from './workbench/store.ts';

const endpoint='https://fixture.invalid';
const clock=Date.UTC(2026,10,18,0,0,0,500);
const env={SUPERAGENT_USERS_JSON:JSON.stringify([
  {user_id:'admin',role:'admin',token:'fixture-admin'},
  {user_id:'owner',role:'member',token:'fixture-member'}
])};
const cleanups:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const cleanup of cleanups.splice(0)) await cleanup();});

function fixture(writeStatus:'succeeded'|'unknown'|'dispatching'='succeeded') {
  const dir=mkdtempSync(join(tmpdir(),'intake-echo-'));
  const store=openStorage(join(dir,'fixture.db'),{clock:()=>clock});
  const app=Fastify(), db=store.db;
  cleanups.push(async()=>{await app.close();store.close();rmSync(dir,{recursive:true,force:true});});
  registerAuth(app,env);
  registerIntake(app,db,env);
  const task=seed(store);
  db.exec(`UPDATE projects SET redmine_project_ids='[7]';
    INSERT INTO governance_identities(source,actor_id,user_id,enabled) VALUES('redmine','5','owner',1),('redmine','6','owner',1);
    INSERT INTO governance_identity_grants(identity_id,project_ids,permissions)
    SELECT id,'[1]','["request"]' FROM governance_identities`);
  db.prepare("INSERT INTO governance_settings(key,value,updated_at) VALUES('connectors.redmine',?,?)")
    .run(JSON.stringify({enabled:false,base_url:endpoint+'/',user_id:5}),new Date(clock).toISOString());
  const draft=draftFor(store,task), {lease}=store.startController('fixture');
  store.decideDraft(draft.draftId,'approve',draft.actionHash);
  const allow=()=>({allowed:true,senderActorId:'5'});
  const claim=store.claimDelivery(lease,draft.draftId,draft.actionHash,allow)!;
  store.markDispatching(lease,claim,allow);
  if(writeStatus!=='dispatching') store.finishDelivery(lease,claim,{write_status:writeStatus,fixture_receipt:'original'});
  const event={
    source:'redmine' as const,external_id:'fixture-echo',event_type:'issue.comment',actor_id:'5',thread_id:'issue:123',
    project_external_id:'7',issue_id:'123',content:'中文回复',occurred_at:'2026-11-18T00:00:01.000000+00:00',
    metadata:{redmine_endpoint:endpoint,journal_id:42,details:[]},attachments:[]
  };
  const post=(payload:unknown,token='fixture-admin',suffix='')=>app.inject({method:'POST',url:'/api/v1/events'+suffix,
    headers:{host:'127.0.0.1',authorization:'Bearer '+token,'content-type':'application/json'},payload:JSON.stringify(payload)});
  const ledger=()=>db.prepare('SELECT * FROM delivery_records WHERE action_id=?').get(claim.actionId)!;
  const bindings=()=>db.prepare('SELECT * FROM delivery_echo_bindings').all();
  const audits=()=>db.prepare("SELECT action,details FROM governance_audit WHERE action LIKE 'delivery.self_echo%'").all();
  const tasks=()=>db.prepare('SELECT * FROM tasks ORDER BY id').all();
  return {db,event,post,task,claim,ledger,bindings,audits,tasks};
}

test('同一私聊跨默认项目研判补充，保留自己的发言和无效片段且不打断 Worker',async()=>{
  const {db,post}=fixture();
  db.exec(`UPDATE projects SET name='医院甲';
    INSERT INTO projects(name,repo_path,repositories,base_branch,test_command,allowed_paths,dingtalk_chat_ids,redmine_project_ids,enabled,created_at)
      SELECT '共享测试',repo_path,repositories,base_branch,test_command,allowed_paths,'[]','[]',1,created_at FROM projects WHERE id=1;
    INSERT INTO governance_settings(key,value,updated_at) VALUES
     ('dingtalk_request_access','{"mode":"all","owner_user_id":"owner","project_ids":[1,2],"project_hints":[{"project_id":1,"keywords":["甲医院"]}],"on_unmatched":"default","default_project_id":2}',datetime('now')),
     ('semantic_routing_enabled','true',datetime('now'))`);
  const occurred=new Date(Date.now()-60000).toISOString();
  const send=async(message:string,content:string,offset:number,self=false)=>{
    const response=await post({source:'dingtalk',event_type:'message.received',external_id:'profile:chat:'+message,
      thread_id:'chat',project_external_id:'chat',actor_id:self?'own':'peer',content,
      occurred_at:new Date(Date.parse(occurred)+offset*1000).toISOString(),
      metadata:{message_id:message,profile:'profile',conversation_type:'direct',dws_event_type:'user_im_message_receive_o2o_all',self_authored:self}});
    expect(response.statusCode,response.body).toBe(200);
    return response.json();
  };
  const first=await send('hello','你好，甲医院好像有个问题',0);
  const taskId=Number(first.task_id);
  db.prepare("UPDATE tasks SET status='running' WHERE id=?").run(taskId);
  await send('own','具体是什么问题？',1,true);
  const passive=await send('piece','你用',2);
  expect(passive.data.routing_status).toBe('semantic_pending');
  const store=new WorkbenchStore(db);
  const route=(id:number,action:'context'|'dispatch')=>{
    const event=store.required<Event>('events',id);
    const auth=admitSemantic(store,event,env)!;
    const context=semanticContext(event,auth);
    expect(context.project_id).toBe(2);
    expect(context.tasks.find(row=>row.id===taskId)).toMatchObject({project_id:1,status:'running'});
    expect(context.history?.some(row=>row.direction==='own_account'&&row.content==='具体是什么问题？')).toBe(true);
    return applyDecision(store,event,auth,{action,kind:'reply',task_id:taskId,state_version:1,reason:'同一对话的后续'},context);
  };
  expect(route(passive.id,'context')).toMatchObject({status:'applied',taskId});
  expect(db.prepare('SELECT status,revision,state_version FROM tasks WHERE id=?').get(taskId))
    .toEqual({status:'running',revision:1,state_version:1});
  const useful=await send('detail','这个报告的结果没有同步',3);
  expect(route(useful.id,'dispatch')).toMatchObject({status:'applied',taskId});
  expect(db.prepare('SELECT status,revision FROM tasks WHERE id=?').get(taskId)).toEqual({status:'waiting_resource',revision:2});
  expect(assembleContext(db,taskId).prompt).toContain('你用');
  expect(assembleContext(db,taskId).prompt).toContain('这个报告的结果没有同步');
});

const fast=(event:{data:{_lifecycle:{steps:{stage:string}[]}[]}})=>
  event.data._lifecycle.at(-1)!.steps.find(s=>s.stage==='fast_filter')!;

test('已匹配项目的群消息明确记录未研判原因，可识别的请求仍进入语义队列', async()=>{
  const { db, post }=fixture();
  db.exec(`UPDATE projects SET dingtalk_chat_ids='["fixture-chat"]' WHERE id=1;
    INSERT INTO governance_settings(key,value,updated_at) VALUES
      ('dingtalk_request_access','{"mode":"all","owner_user_id":"owner","project_ids":[1]}',datetime('now')),
      ('semantic_routing_enabled','true',datetime('now'))`);
  const payload={ source:'dingtalk',event_type:'message.received',thread_id:'fixture-chat',project_external_id:'fixture-chat',
    actor_id:'peer',metadata:{profile:'fixture',conversation_type:'group',dws_event_type:'user_im_message_receive_group',at_me:false} };
  const blocked=await post({...payload,external_id:'group-blocked',content:'之前的问题还是会出现'});
  expect(blocked.statusCode).toBe(200);
  expect(blocked.json()).toMatchObject({task_id:null,data:{routing_status:'pending_confirmation',routing_reason:'semantic_request_not_recognized'}});
  expect(db.prepare('SELECT event_id FROM semantic_routing_jobs WHERE event_id=?').get(blocked.json().id)).toBeUndefined();
  const queued=await post({...payload,external_id:'group-queued',content:'请排查之前的问题'});
  expect(queued.statusCode).toBe(200);
  expect(queued.json().data.routing_status).toBe('semantic_pending');
});

test('私聊引用优先沿用原消息已绑定的项目，混合历史不会回落到默认项目', async()=>{
  const {db,post}=fixture();
  db.exec(`UPDATE projects SET name='甲医院';
    INSERT INTO projects(name,repo_path,repositories,base_branch,test_command,allowed_paths,dingtalk_chat_ids,redmine_project_ids,enabled,created_at)
      SELECT '乙医院',repo_path,repositories,base_branch,test_command,allowed_paths,'[]','[]',1,created_at FROM projects WHERE id=1;
    INSERT INTO governance_settings(key,value,updated_at) VALUES
      ('dingtalk_request_access','{"mode":"all","owner_user_id":"owner","project_ids":[1,2],"on_unmatched":"default","default_project_id":2}',datetime('now'))`);
  const send=async(message:string,content:string,replyTo?:string)=>{
    const response=await post({source:'dingtalk',event_type:'message.received',external_id:message,
      thread_id:'mixed-chat',project_external_id:'mixed-chat',actor_id:'peer',content,
      metadata:{message_id:message,profile:'profile',conversation_type:'direct',
        dws_event_type:'user_im_message_receive_o2o_all',reply_to_message_id:replyTo}});
    expect(response.statusCode,response.body).toBe(200);
    return response.json();
  };
  const first=await send('first','甲医院这个报告有问题');
  const other=await send('other','乙医院说的是另一份报告');
  expect(first.task_id).toBeTruthy();
  expect(other.task_id).toBeTruthy();
  expect(other.task_id).not.toBe(first.task_id);
  const supplement=await send('follow-up','我补到了相关日志','first');
  expect(supplement).toMatchObject({task_id:first.task_id,data:{routing_status:'routed'}});
  expect(fast(supplement)).toMatchObject({detail:{selected_project_id:1}});
  const conflict=await send('conflict','乙医院的日志','first');
  expect(conflict).toMatchObject({task_id:null,data:{routing_status:'pending_confirmation'}});

  db.exec("INSERT INTO governance_settings(key,value,updated_at) VALUES ('semantic_routing_enabled','true',datetime('now'))");
  const passive=await send('passive','还有一点');
  expect(passive.data.routing_status).toBe('semantic_pending');
  const store=new WorkbenchStore(db);
  const event=store.required<Event>('events',passive.id);
  const auth=admitSemantic(store,event,env)!;
  const target=auth.candidates.find(row=>row.id===first.task_id)!;
  expect(applyDecision(store,event,auth,{action:'context',kind:'reply',task_id:target.id,
    state_version:target.state_version,reason:'原事件的补充片段'},semanticContext(event,auth)))
    .toMatchObject({status:'applied',taskId:first.task_id});

  const quotedContext=await send('quoted-context','新日志里还有这一条','passive');
  expect(quotedContext).toMatchObject({task_id:first.task_id,data:{routing_status:'routed'}});
  expect(fast(quotedContext)).toMatchObject({detail:{selected_project_id:1}});
  const conflictingContext=await send('conflicting-context','乙医院的日志','passive');
  expect(conflictingContext.task_id).toBeNull();
  expect(admitSemantic(store,store.required<Event>('events',conflictingContext.id),env)).toBeUndefined();
});

test.each(['succeeded','unknown','dispatching'] as const)('公开与渠道入库共用 Redmine 回声事务 %s',async writeStatus=>{
  const f=fixture(writeStatus), before=f.ledger(), tasks=f.tasks();
  const status=writeStatus==='succeeded'?'self_echo':'self_echo_candidate';
  const reason=writeStatus==='succeeded'?'matched_successful_write':'write_outcome_unknown';
  const responses=await Promise.all([f.post(f.event),f.post(f.event)]);
  expect(responses.map(response=>response.statusCode)).toEqual([200,200]);
  const receipts=responses.map(response=>response.json());
  expect(receipts.map(receipt=>receipt.duplicate).sort()).toEqual([false,true]);
  const saved=receipts.find(receipt=>!receipt.duplicate);
  expect(saved).toMatchObject({duplicate:false,task_id:f.task,data:{routing_status:status,echo_reason:reason,
    delivery_action_id:f.claim.actionId,echo_journal_id:'42'}});
  expect(fast(saved)).toMatchObject({status:'blocked',reason:status,detail:{blocked_reason:status,checks:{
    authorization:{allowed:true},delivery_echo:{rule:'confirmed_delivery_echo_filter',allowed:false}
  }}});
  expect(fast(saved)).not.toHaveProperty('detail.checks.event_type');
  const original=JSON.parse(String(before.result));
  const persisted=f.ledger();
  expect(persisted).toEqual({...before,result:expect.any(String)});
  expect(JSON.parse(String(persisted.result))).toEqual({...original,echo_evidence:expect.objectContaining({
    event_id:saved.id,reason,journal_id:'42',actor_id:'5',issue_id:123,endpoint
  })});
  expect(ingestChannelEvent(f.db,f.event,env)).toEqual({...saved,duplicate:true});
  const alias=ingestChannelEvent(f.db,{...f.event,external_id:'poller-alias'},env);
  expect(alias).toMatchObject({task_id:f.task,data:{routing_status:status,delivery_action_id:f.claim.actionId}});
  expect(f.ledger()).toEqual(persisted);
  expect(f.bindings()).toEqual([expect.objectContaining({event_id:saved.id,action_id:f.claim.actionId})]);
  expect(f.audits()).toEqual([expect.objectContaining({action:'delivery.'+status})]);
  expect(f.tasks()).toEqual(tasks);
  expect(f.db.prepare('SELECT count(*) n FROM event_targets').get()?.n).toBe(0);
  const manual=await f.post({...f.event,external_id:'distinct-journal',metadata:{...f.event.metadata,journal_id:43}});
  expect(manual.json().data.routing_status).toBe('routed');
  expect(f.ledger()).toEqual(persisted);
});

test('渠道先入库时，公开入口读取同一回执，持久设置优先于环境',async()=>{
  const f=fixture();
  const channelEnv={...env,SUPERAGENT_REDMINE_CONFIG:JSON.stringify({user_id:6,base_url:endpoint})};
  const stored=ingestChannelEvent(f.db,f.event,channelEnv);
  expect(stored).toMatchObject({task_id:f.task,data:{routing_status:'self_echo'}});
  expect((await f.post(f.event)).json()).toEqual({...stored,duplicate:true});
  expect(f.bindings()).toHaveLength(1);
  expect(f.audits()).toHaveLength(1);
});

test('回声必须重算已审批目标哈希',async()=>{
  const f=fixture(), before=f.ledger();
  f.db.prepare("UPDATE approvals SET action=json_set(action,'$.target.fixture_extra','changed') WHERE 'reply-'||id=?")
    .run(f.claim.actionId);
  const stored=(await f.post(f.event)).json();
  expect(stored.data.routing_status).toBe('routed');
  expect(f.ledger()).toEqual(before);
  expect(f.bindings()).toEqual([]);
});

test('回声必须通过 HTTP 管理员权限与冻结版来源授权检查',async()=>{
  const f=fixture(), before=f.ledger();
  expect((await f.post(f.event,'fixture-member')).statusCode).toBe(403);
  f.db.exec("UPDATE governance_identity_grants SET permissions='[]'");
  const spoof={...f.event,metadata:{...f.event.metadata,self_authored:true,external_user_id:'5'}};
  const blocked=(await f.post(spoof)).json();
  expect(blocked.data.routing_reason).toBe('actor_not_authorized_for_project');
  expect(fast(blocked)).not.toHaveProperty('detail.checks.delivery_echo');
  expect(f.ledger()).toEqual(before);
  expect(f.bindings()).toEqual([]);
  // Legacy grants may store project IDs as strings.
  f.db.exec(`UPDATE governance_identity_grants SET permissions='["request"]',project_ids='["1"]'`);
  const retried=(await f.post({},'fixture-admin','/'+blocked.id+'/retry-routing')).json();
  expect(retried).toMatchObject({id:blocked.id,task_id:f.task,data:{routing_status:'self_echo'}});
  expect(retried.data._lifecycle).toHaveLength(2);
  expect(f.bindings()).toHaveLength(1);
});

test('伪造回声标记、账号或窗口以外的事件仍走普通路由',async()=>{
  const f=fixture(), before=f.ledger();
  for(const [index,override] of [
    {actor_id:'6',metadata:{...f.event.metadata,external_user_id:'6',self_authored:true}},
    {metadata:{...f.event.metadata,redmine_endpoint:'https://different.invalid',self_authored:true}},
    {metadata:{...f.event.metadata,details:[{name:'status_id'}]}},
    {occurred_at:'2026-11-18T00:00:01'},
    {occurred_at:'2026-11-18T00:02:01Z'}
  ].entries()) {
    const stored=(await f.post({...f.event,...override,external_id:'unmatched-'+index})).json();
    expect(stored.data.routing_status).toBe('routed');
    expect(fast(stored)).toMatchObject({detail:{checks:{delivery_echo:{allowed:true}}}});
  }
  expect(f.ledger()).toEqual(before);
  expect(f.bindings()).toEqual([]);
  const coarse=(await f.post({...f.event,occurred_at:'2026-11-18T08:00:00+08:00'})).json();
  expect(coarse.data).toMatchObject({routing_status:'self_echo_candidate',echo_reason:'source_second_precision_overlap'});
});

test('回声账本写入失败时整个入库回滚，重试只记录一次',async()=>{
  const f=fixture(), before=f.ledger(), tasks=f.tasks();
  f.db.exec("CREATE TRIGGER fail_echo BEFORE UPDATE ON delivery_records BEGIN SELECT RAISE(ABORT,'fixture failure'); END");
  expect((await f.post(f.event)).statusCode).toBe(500);
  expect(f.db.prepare('SELECT id FROM events WHERE external_id=?').get(f.event.external_id)).toBeUndefined();
  expect(f.ledger()).toEqual(before);
  expect(f.bindings()).toEqual([]);
  expect(f.audits()).toEqual([]);
  expect(f.tasks()).toEqual(tasks);
  f.db.exec('DROP TRIGGER fail_echo');
  expect((await f.post(f.event)).json()).toMatchObject({duplicate:false,data:{routing_status:'self_echo'}});
  expect(f.bindings()).toHaveLength(1);
  expect(f.audits()).toHaveLength(1);
});

test.each([
  ['unsupported', '正文', {}, 'unsupported_event_type', {event_type:{allowed:false,rule:'supported_source_event_type'}}],
  ['issue.comment', ' ', {}, 'ambiguous_or_empty_request', {message_content:{allowed:false,rule:'unambiguous_nonempty_message'}}],
  ['issue.comment', '请分析', {uncertain_mentions:['actor']}, 'ambiguous_or_empty_request', {message_content:{allowed:false}}],
  ['issue.comment', '只读且请修改代码', {}, 'conflicting_analysis_and_write_request', {request_kind:{allowed:false,requested_kind:'conflict'}}],
  ['issue.comment', '不要修改代码', {}, '', {request_kind:{allowed:true,requested_kind:'analysis'}}],
  ['issue.comment', '什么时候完成', {}, '', {request_kind:{allowed:true,requested_kind:'analysis'}}],
  ['issue.comment', '请修复', {}, '', {request_kind:{allowed:true,requested_kind:'repair'}}],
  ['issue.comment', '普通说明', {uncertain_mentions:[]}, '', {request_kind:{allowed:true,requested_kind:null}}]
] as const)('快速过滤保留逐项证据 %s %s',async(event_type,content,metadata,reason,checks)=>{
  const f=fixture();
  const response=await f.post({...f.event,event_type,content,actor_id:'6',metadata});
  const saved=response.json();
  expect(response.statusCode).toBe(200);
  expect(fast(saved)).toMatchObject({status:reason?'blocked':'passed',detail:{checks:{
    delivery_echo:{rule:'confirmed_delivery_echo_filter',allowed:true},...checks
  }}});
  if(reason) expect(saved.data.routing_reason).toBe(reason);
  if('request_kind' in checks) expect(fast(saved)).toMatchObject({detail:{checks:{
    event_type:{rule:'supported_source_event_type',allowed:true},
    message_content:{rule:'unambiguous_nonempty_message',allowed:true},
    request_kind:{rule:'no_conflicting_analysis_and_write'}
  }}});
});
