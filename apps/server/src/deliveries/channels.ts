import type { FastifyInstance, FastifyReply } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { ChannelError, CursorStore } from '../../../../packages/channels/common.ts';
import type { Incoming } from '../../../../packages/channels/common.ts';
import { Redmine, RedminePoller, redmineAccountMap } from '../../../../packages/channels/redmine.ts';
import { listenDws, readDwsGroup, readDwsSourceImages, readOwnDingTalk, replyDws, searchDwsGroups, verifyDws } from '../../../../packages/channels/dingtalk.ts';
import { sourceImageReceipt } from '../../../../packages/channels/source-image.ts';
import type { Scope, DwsConfig } from '../../../../packages/channels/dingtalk.ts';
import { cardConfig, cardReceiver, decodeCard } from '../../../../packages/channels/feishu.ts';
import { notifyCard,notifyTriage,notifyWorkflow,updateWorkflowCard,upgradeNoticeTable,upgradeTriageNotices } from '../../../../packages/channels/feishu-notices.ts';
import { connectFeishu } from '../../../../packages/channels/feishu-connection.ts';
import { upgradeWorkflowNotices,workflowReceiver } from '../../../../packages/channels/feishu-workflow.ts';
import { background } from './background.ts';
import { registerAttachments } from './attachments.ts';
import type { DeliveryPlan, Lease, Storage } from '../../../../packages/storage/index.ts';
import { ingestChannelEvent } from './echo.ts';
import { fail, roleOf } from '../auth.js';
import { admin } from '../sql.js';
import { configureWorkbenchRuntime, workbenchRuntime } from '../workbench/runtime.ts';
import type { DingTalkHistoryBinding, DingTalkImageBinding } from '../workbench/runtime.ts';
import { unassignedContext } from '../workbench/semantic-engine.ts';
import { nextTriageNotice } from '../workbench/event-groups.ts';
import { WorkbenchStore, type Event } from '../workbench/store.ts';
import { recentDingTalkAnchors, syncDingTalkHistory } from '../workbench/dingtalk-history.ts';

type Name='redmine'|'dingtalk';
const names=['dingtalk','redmine'] as const;
const positive=z.int().positive(), nonempty=z.string().trim().min(1);
const red=z.object({enabled:z.boolean(),base_url:z.url(),user_id:positive,project_ids:z.array(positive).default([]),all_assigned_projects:z.boolean().optional(),
  account_map:redmineAccountMap.optional(),poll_seconds:z.number().min(1).max(86400).default(60),
  api_key_env:z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/).default('HLZJ_REDMINE_API_KEY'),initial_since:z.string().optional()});
const ding=z.object({enabled:z.boolean(),profile:nonempty,self_ids:z.array(nonempty).nonempty(),executable:z.union([nonempty,z.array(nonempty).nonempty()]),
  kind:z.enum(['group','at-me','all-direct']).optional(),chat_id:nonempty.optional(),history:z.object({chat_ids:z.array(nonempty).nonempty(),
  initial_since:nonempty,history_timezone:nonempty,page_limit:positive.max(40).optional(),timeout:positive.max(300).optional(),sender_map:z.record(z.string(),z.string()).optional()}).optional()});
function saved(db:DatabaseSync,key:string) {
  const r=db.prepare('SELECT value FROM governance_settings WHERE key=?').get(key);
  return r?JSON.parse(String(r.value)):null;
}
export function channelConfig(db:DatabaseSync,env:NodeJS.ProcessEnv,name:Name) {
  const stored=saved(db,'connectors.'+name);
  if(stored!==null) return stored;
  try{return JSON.parse(env['SUPERAGENT_'+name.toUpperCase()+'_CONFIG']??'{"enabled":false}');}catch{return {};}
}
function headers(env:NodeJS.ProcessEnv,owner?:string) {
  const users:{role:string;user_id:string;token:string}[]=JSON.parse(env.SUPERAGENT_USERS_JSON??'[]');
  const user=users.find(u=>owner?u.user_id===owner:u.role==='admin');
  const token=user?.token??((!owner||owner==='admin')?env.SUPERAGENT_API_TOKEN:undefined);
  if(!token && (users.length || env.SUPERAGENT_API_TOKEN || (owner && owner!=='admin'))) throw new ChannelError('channel_principal_unavailable');
  return token?{host:'127.0.0.1',authorization:'Bearer '+token}:{host:'127.0.0.1'};
}
function scopes(c:DwsConfig,policy:Record<string,any>|null):Scope[] {
  if(!policy) return [{kind:c.kind??'at-me',chatId:c.kind==='group'?c.chat_id:undefined}];
  const enabled:Scope[]=[];
  if(policy.direct_messages==='reply') enabled.push({kind:'all-direct'});
  if(policy.group_messages==='mentions') enabled.push({kind:'at-me'});
  if(policy.group_messages==='requests') {
    if(policy.group_scope==='selected') for(const chat of policy.group_chat_ids??[]) enabled.push({kind:'group',chatId:chat});
    else enabled.push(c.kind==='group' && !policy.group_scope?{kind:'group',chatId:c.chat_id}:{kind:'all-group'});
  }
  return enabled;
}
interface ScopeStatus {kind:Scope['kind'];chat_id:string|null;status:string;last_error:string|null;last_seen:string|null;history_recovery:boolean}
interface Run {abort:AbortController;done:Promise<void>;fingerprint:string;status:string;lastError:string|null;lastSeen:string|null;scopes:ScopeStatus[]}
const registered=new WeakMap<FastifyInstance,ReturnType<typeof initialize>>();
export function connectorStatuses(app:FastifyInstance) { return registered.get(app)?.statuses()??[]; }
export async function reconcileChannels(app:FastifyInstance,changes:Record<string,unknown>={}) { await registered.get(app)?.reconcile(changes); }
export function registerChannels(app:FastifyInstance,store:Storage,lease:Lease,root:string,env:NodeJS.ProcessEnv) {
  const existing=registered.get(app);
  if(existing) return existing;
  const service=initialize(app,store,lease,root,env);
  registered.set(app,service);
  return service;
}
function initialize(app:FastifyInstance,store:Storage,lease:Lease,root:string,env:NodeJS.ProcessEnv) {
  const db=store.db;
  const native=env.SUPERAGENT_DRIVER!=='fixture' && env.SUPERAGENT_SERVICE_MODE!=='preview';
  const card=native?cardConfig(env):null;
  const cursor=new CursorStore(db), lifetime=new AbortController();
  const runs=new Map<Name,Run>(), stopped=new Set<Name>();
  db.exec('BEGIN IMMEDIATE');
  try {upgradeNoticeTable(db);if(card) {upgradeWorkflowNotices(db);upgradeTriageNotices(db);}db.exec('COMMIT');} catch(err){db.exec('ROLLBACK');throw err;}
  registerAttachments(app,store,lease,root,env,name=>channelConfig(db,env,name),name=>native && !stopped.has(name));
  function guard(signal:AbortSignal) {
    signal.throwIfAborted();lifetime.signal.throwIfAborted();
    const row=db.prepare("SELECT expires_at FROM controller_leases WHERE id='controller' AND owner=? AND epoch=?").get(lease.owner,lease.epoch);
    if(!row||Date.parse(String(row.expires_at))<=Date.now()) throw new ChannelError('channel_lease_lost');
  }
  function sender(name:Name) {
    if(!native) return fail(409,'当前运行模式未启用本机渠道');
    const config=channelConfig(db,env,name);
    if(config?.enabled!==true || stopped.has(name)) return fail(409,'渠道尚未启用');
    if(name==='redmine') {
      const r=red.safeParse(config);
      if(!r.success || !env[r.data.api_key_env]) return fail(409,'Redmine 服务、账号或凭据未就绪');
      const transport=new Redmine(r.data,env[r.data.api_key_env]!);
      return {verify:async(target:DeliveryPlan['target'])=>{
        await transport.verify(lifetime.signal);
        await transport.verifyIssue(Number(target.issue_id),lifetime.signal);
      },send:(p:DeliveryPlan,_id:string)=>{
        if(p.source!==name||p.target.base_url!==transport.base) return fail(409,'Redmine 目标已变化');
        return transport.comment(Number(p.target.issue_id),p.payload.content,lifetime.signal);
      }};
    }
    const d=ding.safeParse(config);
    if(!d.success) return fail(409,'钉钉账号、程序或 Profile 未就绪');
    const local={...d.data,cwd:root};
    return {verify:()=>verifyDws(local,env,lifetime.signal),send:(p:DeliveryPlan,id:string)=>replyDws(local,p.target,p.payload.content,id,env,lifetime.signal)};
  }
  function prepare(name:Name) {
    const transport=sender(name), config=JSON.stringify(channelConfig(db,env,name));
    return {...transport,check(){
      guard(lifetime.signal);
      if(stopped.has(name)||JSON.stringify(channelConfig(db,env,name))!==config) fail(409,'发送账号或配置已变化');
    }};
  }
  async function run(name:Name,r:Run) {
    const signal=r.abort.signal, config=channelConfig(db,env,name);
    const emit=async(e:Incoming)=>{
      guard(signal);
      if(e.source==='dingtalk' && e.metadata.conversation_type==='direct' && !e.metadata.self_authored
        && typeof e.metadata.profile==='string' && !db.prepare("SELECT 1 FROM events WHERE source='dingtalk' AND external_id=?").get(e.external_id)) {
        const [anchor]=recentDingTalkAnchors(workbench,e.metadata.profile,0,0.5,e.thread_id,e.actor_id);
        if(anchor) await syncOwn(anchor,AbortSignal.any([signal,AbortSignal.timeout(8000)])).catch(()=>{});
      }
      guard(signal);
      ingestChannelEvent(db,e,env);
      guard(signal);r.lastSeen=new Date().toISOString();
    };
    if(name==='redmine') {
      const c=red.parse(config), client=new Redmine(c,env[c.api_key_env]??'');
      const poller=new RedminePoller(client,cursor,emit);
      while(!signal.aborted) {
        try {guard(signal);await poller.pollOnce(signal);r.status='running';r.lastError=null;r.lastSeen=new Date().toISOString();}
        catch(err){if(signal.aborted) return;r.status='degraded';r.lastError=err instanceof ChannelError?err.message:'redmine_poll_failed';}
        await sleep(c.poll_seconds*1000,undefined,{signal});
      }
      return;
    }
    const c=ding.parse(config), slots=scopes(c,saved(db,'dingtalk_response_policy'));
    if(!slots.length){r.status='disabled';return;}
    r.scopes=slots.map(slot=>({kind:slot.kind,chat_id:slot.chatId??null,status:'connecting',last_error:null,last_seen:null,history_recovery:false}));
    function update() {
      if(signal.aborted) return;
      const problem=r.scopes.find(s=>s.last_error);
      r.lastError=problem?.last_error??null;
      r.status=problem?'degraded':r.scopes.every(s=>s.status==='running')?'running':'connecting';
    }
    const jobs=slots.map(async (slot,i)=>{
      const state=r.scopes[i];
      if(slot.kind==='group' && !slot.chatId) throw new ChannelError('dws_chat_missing');
      let history=c.history;
      if(history && slot.kind!=='all-direct'){
        const chats=history.chat_ids.filter(chat=>{
          if(slot.chatId && slot.chatId!==chat) return false;
          const bindings=db.prepare('SELECT id FROM projects WHERE enabled AND NOT archived AND EXISTS (SELECT 1 FROM json_each(dingtalk_chat_ids) WHERE value=?)').all(chat);
          if(bindings.length>1) throw new ChannelError('dws_history_ambiguous_project');
          return bindings.length===1;
        });
        history=chats.length?{...history,chat_ids:chats}:undefined;
      }
      state.history_recovery=!!history && slot.kind!=='all-direct';
      await listenDws({...c,cwd:root,history},slot,cursor,async e=>{
        await emit(e);state.last_seen=r.lastSeen;
      },env,signal,()=>{state.status='running';update();});
    });
    await Promise.all(jobs.map((job,i)=>job.catch(err=>{
      if(signal.aborted) return;
      r.scopes[i].status='waiting_recovery';
      r.scopes[i].last_error=err instanceof ChannelError?err.message:'dws_listener_failed';
      update();
    })));
  }
  function launch(name:Name,fingerprint:string) {
    const r:Run={abort:new AbortController(),done:Promise.resolve(),fingerprint,status:'connecting',lastError:null,lastSeen:null,scopes:[]};
    runs.set(name,r);
    r.done=run(name,r).catch(err=>{if(r.status!=='stopped'){r.status='degraded';r.lastError=err instanceof ChannelError?err.message:'channel_not_ready';}});
  }
  let pending=Promise.resolve();
  function refresh() {
    pending=pending.catch(()=>{}).then(async()=>{
      for(const name of names) {
        const config=channelConfig(db,env,name), fingerprint=JSON.stringify([config,name==='dingtalk'?saved(db,'dingtalk_response_policy'):null]);
        const old=runs.get(name),enabled=native&&!lifetime.signal.aborted && config?.enabled===true && !stopped.has(name);
        if(old && (!enabled||old.fingerprint!==fingerprint)) {
          old.status='stopped';old.abort.abort();await old.done;runs.delete(name);
        }
        if(enabled&&!runs.has(name)&&!lifetime.signal.aborted) launch(name,fingerprint);
      }
    });
    return pending;
  }
  function statuses() {
    return names.map(name=>{
      const c=channelConfig(db,env,name)??{}, r=runs.get(name);
      const configured=name==='redmine'?red.safeParse(c).success && !!env[c.api_key_env??'HLZJ_REDMINE_API_KEY'] && (c.all_assigned_projects===true || !!c.project_ids?.length):ding.safeParse(c).success;
      const fields=name==='redmine' ? [['base_url','Redmine 服务地址'],[c.all_assigned_projects===true?'all_assigned_projects':'project_ids','Redmine 接收项目范围'],['user_id','Redmine 当前账号']]
        : [['profile','DWS 组织 Profile'],['self_ids','自身账号 ID'],['executable','DWS 程序']];
      const missing=fields.filter(([key])=>Array.isArray(c[key])?!c[key].length:!c[key]).map(([,label])=>label);
      if(name==='redmine'&&!env[c.api_key_env??'HLZJ_REDMINE_API_KEY']) missing.push('API Key 环境变量');
      return {id:name,name,configured,enabled:c.enabled===true,status:r?.status??(c.enabled?(native?'stopped':'unavailable'):'disabled'),
        missing_configuration:missing,warnings:[],...(name==='dingtalk'?{scopes:r?.scopes??[]}:{}),
        last_error:r?.lastError??null,last_seen:r?.lastSeen??null};
    });
  }
  app.addHook('onReady',async()=>{setImmediate(()=>{if(!lifetime.signal.aborted) void refresh().catch(()=>{});});});
  function reconcile(changes:Record<string,unknown>={}) {
    for(const name of names) if('connectors.'+name in changes || name+'_enabled' in changes) stopped.delete(name);
    return refresh();
  }
  app.get('/api/v1/connectors',async()=>statuses());
  async function groupDirectory<T>(reply:FastifyReply,lookup:(config:DwsConfig,signal:AbortSignal)=>Promise<T>,unavailable:string) {
    const current=()=>channelConfig(db,env,'dingtalk');
    const config=ding.safeParse(current());
    if(!config.success) fail(409,'请先配置钉钉组织和本地程序');
    if(!native || !config.data.enabled || stopped.has('dingtalk')) fail(409,'当前钉钉渠道未启用');
    const stoppedOnChange=runs.get('dingtalk')?.abort.signal;
    const signal=stoppedOnChange?AbortSignal.any([lifetime.signal,stoppedOnChange]):lifetime.signal;
    const before=JSON.stringify(current());
    let page;
    try {page=await lookup({...config.data,cwd:root},signal);}
    catch(err){
      if(signal.aborted) fail(409,'钉钉配置或运行状态已变化');
      if(err instanceof ChannelError && err.message==='dws_group_page_invalid') return reply.code(502).send({detail:'钉钉群搜索结果格式无法识别'});
      if(err instanceof ChannelError && err.message==='dws_group_info_invalid') return reply.code(502).send({detail:'钉钉群资料未返回有效的群原名'});
      return reply.code(503).send({detail:unavailable});
    }
    if(stopped.has('dingtalk') || signal.aborted || JSON.stringify(current())!==before) fail(409,'钉钉配置或运行状态已变化');
    return page;
  }
  app.get('/api/v1/connectors/dingtalk/groups',async (req,reply)=>{
    admin(req.principal);
    const {q,cursor}=z.strictObject({
      q:z.string().refine(v=>!!v.trim() && [...v].length<=100 && !v.includes('\0')),
      cursor:z.string().refine(v=>[...v].length<=2000 && !v.includes('\0')).default(''),
    }).parse(req.query);
    return groupDirectory(reply,(c,s)=>searchDwsGroups(c,q,cursor,env,s),'钉钉群名称查询暂不可用，请检查网络后重试。已配置群可填写名称备注。');
  });
  app.get('/api/v1/connectors/dingtalk/group',async(req,reply)=>{
    admin(req.principal);
    const {chat_id}=z.strictObject({chat_id:z.string().min(1).refine(v=>[...v].length<=2000&&!v.includes('\0'))}).parse(req.query);
    return groupDirectory(reply,(c,s)=>readDwsGroup(c,chat_id,env,s),'钉钉群原名暂不可用，请稍后重试');
  });
  app.post('/api/v1/connectors/:name/:action',async req=>{
    admin(req.principal);
    const {name,action}=z.object({name:z.enum(names),action:z.enum(['start','stop'])}).parse(req.params);
    if(action==='stop') stopped.add(name);
    else {
      if(channelConfig(db,env,name)?.enabled!==true) fail(409,'请先明确启用连接器配置');
      stopped.delete(name);
      const r=runs.get(name);
      if(r?.status==='degraded') r.fingerprint='';
    }
    await refresh();return statuses();
  });
  app.addHook('preClose',async()=>{
    lifetime.abort();for(const r of runs.values()){r.status='stopped';r.abort.abort();}
    let timer:ReturnType<typeof setTimeout>|undefined;
    try {await Promise.race([Promise.allSettled([pending,...[...runs.values()].map(r=>r.done)]),
      new Promise<void>(resolve=>{timer=setTimeout(resolve,2500);})]);}finally {clearTimeout(timer);}
  });
  if(card) {
    const secret=env.SUPERAGENT_FEISHU_APP_SECRET;
    function checkFeishuOwner(owner:string) {
      guard(lifetime.signal);
      if(!['member','admin'].includes(roleOf(env,owner)??'')) throw new ChannelError('feishu_owner_unavailable');
    }
    async function applyFromCard(owner:string,url:string,payload:object={}) {
      checkFeishuOwner(owner);
      const result=await app.inject({method:'POST',url,headers:headers(env,owner),payload});
      if(result.statusCode>=400) throw new ChannelError('feishu_action_rejected');
      return result.json();
    }
    const workflow=workflowReceiver(db,card,async(task,action,note)=>{
      const path='/api/v1/tasks/'+task.taskId;
      const draft='/api/v1/deliveries/'+task.draft?.id;
      const expected_state_version=task.version;
      if(action==='publish'||action==='reject') {
        if(task.draft?.status==='pending') await applyFromCard(card.owner,draft+'/decision',
          {decision:action==='publish'?'approve':'reject',action_hash:task.draft.hash});
        if(action==='reject') return '已拒绝回复草稿';
        const result=await applyFromCard(card.owner,draft+'/publish');
        return result?.write_status==='succeeded'?'原渠道已确认发送':'已提交渠道发送，请查看后续状态';
      }
      if(action==='delivery_succeeded'||action==='delivery_failed') {
        await applyFromCard(card.owner,draft+'/reconcile',{outcome:action==='delivery_succeeded'?'succeeded':'failed',evidence:note});
        return '已记录渠道发送核验结果';
      }
      if(action==='execution_stopped') {
        await applyFromCard(card.owner,path+'/reconcile',{outcome:'stopped',evidence:note,expected_state_version});
        return '已记录执行停止核验结果';
      }
      if(action==='retry_attachments') {
        await applyFromCard(card.owner,path+'/retry-attachments',{expected_state_version});
        return '已开始重试来源附件';
      }
      if(action==='accept') {
        await applyFromCard(card.owner,path+'/acceptance',{accepted:true,revision:task.revision,expected_state_version});
        return '任务已验收';
      }
      if(action==='supplement') {
        await applyFromCard(card.owner,path+'/messages',{content:note,expected_state_version});
        await applyFromCard(card.owner,path+'/controls',{action:'resume',expected_state_version:expected_state_version+1});
        return '已补充信息并继续执行';
      }
      await applyFromCard(card.owner,path+'/controls',{action,expected_state_version});
      return '操作已提交';
    },secret?async(id,body)=>{
      checkFeishuOwner(card.owner);
      await updateWorkflowCard(card,secret,id,body,lifetime.signal);
    }:undefined);
    const receive=cardReceiver(db,card,async(owner,aid,decision,hash)=>String((await applyFromCard(owner,
      '/api/v1/approvals/'+aid+'/decision',{decision,action_hash:hash})).status),workflow);
    let callbackReady=()=>card.transport!=='ws';
    if(card.transport==='ws' && secret) app.addHook('onReady',async()=>{
      const warn=()=>app.log.warn('飞书卡片长连接未就绪');
      try {callbackReady=await connectFeishu(card,secret,lifetime.signal,receive.fromConnection,warn);}
      catch {warn();}
    });
    if(secret) background(app,'feishu-notices',async signal=>{
      if(!callbackReady() || !['member','admin'].includes(roleOf(env,card.owner)??'')) return;
      const check=()=>guard(signal);
      await notifyCard(db,lease.owner,card,secret,signal,check);
      await notifyWorkflow(db,card,secret,signal,check);
    },1500);
    const port=Number(env.SUPERAGENT_PORT ?? 18765);
    if(secret && roleOf(env,card.owner)==='admin' && Number.isInteger(port) && port>0 && port<=65535) {
      app.decorate('feishuTriageDelivery',true);
      background(app,'feishu-triage-notices',async signal=>{
        const check=()=>{guard(signal);if(roleOf(env,card.owner)!=='admin') throw new ChannelError('feishu_owner_unavailable');};
        await notifyTriage(db,card,secret,signal,check,id=>nextTriageNotice(workbench,id),`http://127.0.0.1:${port}`);
      },15000);
    }
    if(card.transport!=='ws') app.register(async plugin=>{
      plugin.removeContentTypeParser('application/json');
      plugin.addContentTypeParser('application/json',{parseAs:'buffer',bodyLimit:128*1024},(_r,body,done)=>done(null,body));
      plugin.post('/callbacks/feishu/card',async req=>{
        let payload:unknown;
        try {payload=decodeCard(card,req.body as Buffer,String(req.headers['x-lark-request-timestamp']??''),
          String(req.headers['x-lark-request-nonce']??''),String(req.headers['x-lark-signature']??''));}
        catch {return fail(403,'飞书回调认证失败');}
        try{return await receive(payload);}catch{return fail(403,'飞书回调身份或卡片无效');}
      });
    });
  }
  async function privateRead<T>(signal:AbortSignal,read:(config:DwsConfig,active:AbortSignal)=>Promise<T>) {
    if(!native || stopped.has('dingtalk')) throw new ChannelError('dws_disabled');
    const current=()=>channelConfig(db,env,'dingtalk'),saved=current();
    if(saved?.enabled!==true) throw new ChannelError('dws_disabled');
    const config=ding.parse(saved);
    const stoppedOnChange=runs.get('dingtalk')?.abort.signal;
    const before=JSON.stringify(current()), active=AbortSignal.any([signal,lifetime.signal,...(stoppedOnChange?[stoppedOnChange]:[])]);
    guard(active);
    const page=await read({...config,cwd:root},active);
    guard(active);
    if(stopped.has('dingtalk') || JSON.stringify(current())!==before) throw new ChannelError('dws_configuration_changed');
    return page;
  }
  const readOwn=(binding:DingTalkHistoryBinding,signal:AbortSignal)=>
    privateRead(signal,(config,active)=>readOwnDingTalk(config,binding,env,active));
  const workbench=new WorkbenchStore(db);
  function syncOwn(anchor:Event,signal:AbortSignal) {
    return syncDingTalkHistory(workbench,anchor.task_id!,()=>workbench.rows<Event>('events','WHERE id=? AND task_id=?',anchor.id,anchor.task_id),
      'dingtalk-sync',{readOwnDingTalk:readOwn},signal);
  }
  let lastDingTalkTask=0;
  if(native) background(app,'dingtalk-own-history',async signal=>{
    const config=channelConfig(db,env,'dingtalk');
    if(config?.enabled!==true || stopped.has('dingtalk') || !scopes(config,saved(db,'dingtalk_response_policy')).some(scope=>scope.kind==='all-direct')) return;
    const [anchor]=recentDingTalkAnchors(workbench,config.profile,lastDingTalkTask,24);
    lastDingTalkTask=anchor?.task_id??0;
    if(anchor) await syncOwn(anchor,AbortSignal.any([signal,AbortSignal.timeout(20000)]));
  },30000);
  const readImages=(binding:DingTalkImageBinding,signal:AbortSignal)=>privateRead(signal,async(config,active)=>{
    const authorizedReceipt=()=>{
      const receipt=sourceImageReceipt(db,binding);
      const event=workbench.required<Event>('events',binding.eventId);
      const context=unassignedContext(workbench,event,env,{allowBound:true,resolveRole:workbenchRuntime(app)?.resolveRole});
      if(!context) throw new ChannelError('dws_source_unauthorized');
      return receipt;
    };
    const receipt=authorizedReceipt(),base=env.SUPERAGENT_ATTACHMENTS_ROOT??join(root,'attachments');
    const images=await readDwsSourceImages(config,binding,join(base,'triage'),env,active,receipt.resourceIds);
    if(authorizedReceipt().snapshot!==receipt.snapshot) throw new ChannelError('dws_source_event_changed');
    return images;
  });
  if(native) configureWorkbenchRuntime(app,{...workbenchRuntime(app),readOwnDingTalk:readOwn,readOwnDingTalkImages:readImages});
  return {prepare,statuses,reconcile,readOwnDingTalk:readOwn,readOwnDingTalkImages:readImages};
}
