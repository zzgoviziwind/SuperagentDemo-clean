import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import Fastify from 'fastify';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { openStorage } from '../../../../../packages/storage/index.ts';
import { seed } from '../../../../../packages/storage/tests/helpers.ts';
import { registerChannels } from '../channels.ts';
import { configureWorkbenchRuntime, workbenchRuntime, type DingTalkImageBinding } from '../../workbench/runtime.ts';
import { registerAssessments } from '../../workbench/assessments.ts';
import { WorkbenchStore } from '../../workbench/store.ts';
import { registerAuth } from '../../auth.ts';

const fake=fileURLToPath(new URL('../../../../../packages/channels/tests/fake-dws.mjs',import.meta.url));
let app:ReturnType<typeof Fastify>,store:ReturnType<typeof openStorage>,root:string,log:string,b:DingTalkImageBinding;
let config:{enabled:boolean;profile:string;executable:string[];self_ids:string[]};
let env:NodeJS.ProcessEnv;
function setting(key:string,value:unknown){
  store.db.prepare('INSERT OR REPLACE INTO governance_settings(key,value,updated_at) VALUES(?,?,?)')
    .run(key,JSON.stringify(value),new Date().toISOString());
}
function media(value:Record<string,unknown>){writeFileSync(log+'.media',JSON.stringify(value));}
function calls(){return existsSync(log)?readFileSync(log,'utf8').trim().split('\n').map(v=>JSON.parse(v) as string[]):[];}
function receipt(message:string,image:boolean) {
  const content=image?'请分析 [图片消息](mediaId=photo)':'请分析这条消息';
  const data={actor_id:'peer',thread_id:'private-chat',metadata:{profile:'offline-profile',message_id:message,
    dws_event_type:'user_im_message_receive_o2o_all',source_account_ids:['operator']},occurred_at:new Date(Date.now()-60000).toISOString(),
    attachments:image?[{kind:'image',mediaId:'photo',local_path:'unused',url:'https://unused.invalid'}]:[]};
  return Number(store.db.prepare("INSERT INTO events(source,event_type,external_id,content,data,created_at) VALUES('dingtalk','message.received',?,?,?,?)")
    .run('offline-profile:private-chat:'+message,content,JSON.stringify(data),data.occurred_at).lastInsertRowid);
}
beforeEach(()=>{
  root=mkdtempSync(join(realpathSync(tmpdir()),'原图端口-'));log=join(root,'dws.log');media({});
  app=Fastify();store=openStorage(':memory:');seed(store);
  const project=store.db.prepare('SELECT id FROM projects LIMIT 1').get()!.id;
  store.db.exec("INSERT INTO governance_identities(id,source,actor_id,user_id,enabled) VALUES(99,'dingtalk','peer','admin',1)");
  store.db.prepare('INSERT INTO governance_identity_grants(identity_id,project_ids,permissions) VALUES(99,?,?)')
    .run(JSON.stringify([project]),'["request"]');
  config={enabled:true,profile:'offline-profile',self_ids:['operator'],executable:[process.execPath,fake,log]};
  setting('connectors.dingtalk',config);setting('dingtalk_response_policy',{direct_messages:'reply',group_messages:'off'});
  env={SystemRoot:process.env.SystemRoot,WINDIR:process.env.WINDIR,TEMP:root,TMP:root,SUPERAGENT_API_TOKEN:'offline-admin'};
  b={eventId:receipt('peer-message',true),anchorId:'peer-message',conversation:'private-chat',peer:'peer',profile:config.profile,
    selfIds:config.self_ids,since:new Date(Date.now()-3600000).toISOString(),until:new Date().toISOString()};
});
afterEach(async()=>{await app.close();store.close();rmSync(root,{recursive:true,force:true});});
function register(mode:NodeJS.ProcessEnv={}){
  const {lease}=store.startController('offline-controller');
  return registerChannels(app,store,lease,root,{...env,...mode});
}
const read=(binding=b)=>workbenchRuntime(app)!.readOwnDingTalkImages!(binding,AbortSignal.timeout(8000));

it('已绑定原私聊可取 PNG，来源路径和 URL 无效，重复资源只返回一次',async()=>{
  register();media({files:2});
  const images=await read();
  expect(images).toHaveLength(1);
  expect(Object.keys(images[0]).sort()).toEqual(['bytes','contentType']);
  expect(images[0].contentType).toBe('image/png');
  expect(images[0].bytes.subarray(0,8).toString('hex')).toBe('89504e470d0a1a0a');
  expect(calls().every(c=>c.includes('--readonly') || c.includes('+chat-messages') || c.includes('+messages-mget'))).toBe(true);
  expect(calls().filter(c=>c.includes('+messages-mget')).map(c=>c[c.indexOf('--msg-ids')+1])).toEqual(['peer-message']);
  expect(readdirSync(join(root,'attachments','triage'))).toEqual([]);
});

it('冻结库仅含图片消息标记和原消息标识时仍可读取',async()=>{
  store.db.prepare("UPDATE events SET data=json_remove(data,'$.attachments','$.metadata.source_account_ids') WHERE id=?").run(b.eventId);
  register();expect(await read()).toHaveLength(1);
});

it('不匹配的原事件、账号、会话、消息、对方和空媒体在启动 DWS 前被拒绝',async()=>{
  register();
  for(const change of [{eventId:999},{profile:'other'},{conversation:'other'},{peer:'other'},{anchorId:'other'},{until:b.since},
    {selfIds:['other']},{eventId:receipt('plain',false),anchorId:'plain'}]){
    await expect(read({...b,...change})).rejects.toThrow();
  }
  store.db.prepare("UPDATE events SET data=json_set(data,'$.metadata.dws_event_type','user_im_message_receive_group') WHERE id=?").run(b.eventId);
  await expect(read()).rejects.toThrow('source_event_mismatch');
  store.db.prepare("UPDATE events SET data=json_set(data,'$.metadata.dws_event_type','user_im_message_receive_o2o_all') WHERE id=?").run(b.eventId);
  store.db.exec('UPDATE governance_identities SET enabled=0');
  await expect(read()).rejects.toThrow('unauthorized');
  expect(calls()).toEqual([]);
});

it.each([{account:'other'},{anchor:'other'},{chat:'other'},{message:'other'},{sender:'other'},{ledgerMessage:'other'},
  {resource:'other'},{badSignature:true},{files:5},{size:10*1024*1024+1},{files:3,size:8*1024*1024}])(
  '假 DWS 返回 %j 时丢弃整批',async fault=>{
    register();media(fault);
    await expect(read()).rejects.toThrow();
    expect(calls().some(c=>c.includes('auth'))).toBe(true);
    expect(calls().some(c=>c.includes('+messages-mget'))).toBe(!('account' in fault || 'anchor' in fault));
    const staged=join(root,'attachments','triage');
    expect(existsSync(staged)?readdirSync(staged):[]).toEqual([]);
  });

it.each(['receipt','grant','config','account','abort'])('读取期间 %s 改变时不返回图片',async what=>{
  register();media({delay:500});
  const controller=new AbortController();
  const result=workbenchRuntime(app)!.readOwnDingTalkImages!(b,controller.signal).then(()=>false,()=>true);
  for(let i=0;i<300&&!existsSync(log+'.reading');i++) await delay(10);
  expect(existsSync(log+'.reading')).toBe(true);
  if(what==='receipt') store.db.prepare("UPDATE events SET content='changed' WHERE id=?").run(b.eventId);
  if(what==='grant') store.db.exec('UPDATE governance_identities SET enabled=0');
  if(what==='config') setting('connectors.dingtalk',{...config,enabled:false});
  if(what==='account') media({account:'other'});
  if(what==='abort') controller.abort();
  expect(await result).toBe(true);
  expect(readdirSync(join(root,'attachments','triage'))).toEqual([]);
});

it.each([{SUPERAGENT_DRIVER:'fixture'},{SUPERAGENT_SERVICE_MODE:'preview'}])('%j 下保留可选端口缺省',mode=>{
  register(mode);expect(workbenchRuntime(app)?.readOwnDingTalkImages).toBeUndefined();expect(calls()).toEqual([]);
});

it('评估 HTTP 接收原图和审计摘要，模型端使用离线替身',async()=>{
  registerAuth(app,env);register();
  const extra=receipt('plain',false),ids=[b.eventId,extra];
  // The last selected receipt anchors chat evidence independently of the image event.
  media({anchors:['plain','peer-message']});
  const ports=workbenchRuntime(app)!;
  configureWorkbenchRuntime(app,{...ports,assessmentImagesAvailable:()=>true,
    runAssessment:async(_id,_context,authorized,images)=>{
      expect(authorized()).toBe(true);expect(images?.[0]?.eventId).toBe(b.eventId);
      expect(images?.[0]?.bytes.subarray(0,8).toString('hex')).toBe('89504e470d0a1a0a');
      return {thread_id:'offline-thread',turn_id:'offline-turn',image_turn_id:'offline-turn',text:JSON.stringify({
        project_status:'no_project',proposed_project_id:null,evidence_event_ids:ids,reason:'已查原图',missing_context:'',
        relationship:'uncertain',relationship_reason:'信息不足'})};
    }});
  registerAssessments(app,new WorkbenchStore(store.db));
  const response=await app.inject({method:'POST',url:'/api/v1/routing/assessments',headers:{host:'127.0.0.1',authorization:'Bearer offline-admin'},
    payload:{event_ids:ids}});
  expect(response.statusCode,response.body).toBe(200);
  expect(response.json()).toMatchObject({status:'assessed',visual_inputs:[b.eventId],evidence:[
    {tool:'chat_evidence',status:'verified'},{tool:'source_image',event_id:b.eventId,status:'verified',images:[{content_type:'image/png'}]}]});
  expect(response.body).not.toContain('iVBOR');
  expect(calls().filter(c=>c.includes('+messages-mget'))).toHaveLength(1);
  expect(calls().some(c=>c.includes('+messages-reply'))).toBe(false);
});
