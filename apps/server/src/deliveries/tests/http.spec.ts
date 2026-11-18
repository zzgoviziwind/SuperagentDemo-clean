import assert from 'node:assert/strict';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { readFileSync, readdirSync } from 'node:fs';
import { client, host, input } from './harness.ts';
async function configure(call:ReturnType<typeof client>,f:ReturnType<typeof input>) {
  await call('/settings','PATCH',{'connectors.redmine':{enabled:false,user_id:5,base_url:'https://fixture.invalid'}});
  const path='/tasks/'+f.task+'/deliveries', post={event_id:f.event,content:'核对原文'};
  await call(path,'POST',post,403,'viewer');
  const draft=await call(path,'POST',post,200,'member');
  assert.equal(draft.event_id,f.event);
  assert.equal(draft.approval.action.target.issue_id,42);
  const url='/deliveries/'+draft.id;
  await call(url+'/publish','POST',undefined,409);
  await call(url+'/decision','POST',{decision:'approve',action_hash:'wrong'},409);
  assert.equal((await call(url+'/decision','POST',{decision:'approve',action_hash:draft.approval.action_hash})).status,'approved');
  await call(url+'/publish','POST',undefined,409);
  assert.equal((await call(path))[0].delivery,null);
  await call('/settings','PATCH',{external_delivery_enabled:true,'connectors.redmine':{enabled:true,user_id:5,project_ids:[7],base_url:'https://fixture.invalid'}});
  return {url,path,draft};
}
test('真实 HTTP 所有权、设置、规则和回执；并发发布后外部收件只有一份',{timeout:20000},async()=>{
  const f=input('正常'), h=host(f.dir);
  try {
    const call=client(await h.address()), {url,path,draft}=await configure(call,f);
    await call('/event-rules','PUT',{items:[{name:'临时暂停',source:'redmine',action:'pause'}]});
    await call(url+'/publish','POST',undefined,409);
    await call('/event-rules','PUT',{items:[]});
    await call('/settings','PATCH',{'connectors.redmine':{enabled:true,user_id:5,project_ids:[7],base_url:'https://other.invalid'}});
    await call(url+'/publish','POST',undefined,409);
    await call('/settings','PATCH',{'connectors.redmine':{enabled:true,user_id:5,project_ids:[7],base_url:'https://fixture.invalid'}});
    const both=await Promise.all([call(url+'/publish','POST'),call(url+'/publish','POST')]);
    const sent=await call(url+'/publish','POST');
    assert.ok(both.some(row=>row.write_status==='succeeded'));
    assert.equal(sent.write_status,'succeeded');
    assert.equal(sent.action_hash,draft.approval.action_hash);
    assert.deepEqual((await call(path,'GET',undefined,200,'member'))[0].delivery,sent);
    assert.deepEqual((await call(path))[0].delivery,sent);
    await call(path,'GET',undefined,404,'viewer');
    await call(path,'GET',undefined,404,'other');
    const db=new DatabaseSync(join(f.dir,'superagent.db'));
    try{
      db.prepare("UPDATE tasks SET owner_id='local-admin' WHERE id=?").run(f.task);
      db.prepare("INSERT OR REPLACE INTO governance_task_owners(task_id,user_id) VALUES(?,'other')").run(f.task);
    }finally{db.close();}
    await call(path,'GET',undefined,404,'member');
    assert.deepEqual((await call(path,'GET',undefined,200,'other'))[0].delivery,sent);
    const sink=join(f.dir,'fake-channel-receipts'), files=readdirSync(sink);
    assert.equal(files.length,1);
    const saved=JSON.parse(readFileSync(join(sink,files[0]),'utf8'));
    assert.deepEqual(saved.target,{source:'redmine',threadId:'42'});
    assert.equal(saved.actionHash,sent.action_hash);
    assert.equal(saved.content,'核对原文');
  } finally {await h.stop();}
});
test('普通 Host 即使存在退出注入变量也不会触发 fixture 发送或退出',{timeout:15000},async()=>{
  const f=input('普通'),h=host(f.dir,false,true);
  try {
    const call=client(await h.address()),{url,path}=await configure(call,f);
    await call(url+'/publish','POST',undefined,409);
    assert.equal((await call(path))[0].delivery,null);
    assert.ok(!readdirSync(f.dir).includes('fake-channel-receipts'));
  } finally {await h.stop();}
});
test('独立收件提交后强杀 Host；租约到期重启，unknown 可查、对账及重放零新增收件',{timeout:55000},async()=>{
  const f=input('崩溃'), h=host(f.dir,true,true);
  let routes;
  try {
    const call=client(await h.address());
    await call('/connectors/dingtalk/start','POST',undefined,409);
    await call('/connectors/dingtalk/start','POST',undefined,403,'member');
    const before=(await call('/connectors')).find((row:any)=>row.id==='dingtalk');
    assert.equal(before.enabled,false);assert.ok(before.missing_configuration.includes('DWS 程序'));
    routes=await configure(call,f);
    await assert.rejects(call(routes.url+'/publish','POST'));
    const [code,signal]=await h.exit;
    assert.ok(signal || code!==0);
  } finally {if(h.p.exitCode===null && h.p.signalCode===null) h.p.kill();}
  const receipts=join(f.dir,'fake-channel-receipts');
  assert.equal(readdirSync(receipts).length,1);
  const db=new DatabaseSync(join(f.dir,'superagent.db'),{readOnly:true});
  let expires:number;
  try {
    const row=db.prepare('SELECT result,claim_token FROM delivery_records').get()!;
    assert.equal(JSON.parse(String(row.result)).write_status,'dispatching');
    assert.ok(row.claim_token);
    expires=Date.parse(String(db.prepare('SELECT expires_at FROM controller_leases').get()!.expires_at));
  } finally {db.close();}
  await delay(Math.max(0,expires-Date.now()+100));
  const restarted=host(f.dir);
  try {
    const call=client(await restarted.address()), {path,url}=routes;
    const unknown=(await call(path))[0].delivery;
    assert.equal(unknown.write_status,'unknown');
    assert.deepEqual(await call(url+'/publish','POST'),unknown);
    await call(url+'/reconcile','POST',{outcome:'succeeded',evidence:' '},409);
    const result=await call(url+'/reconcile','POST',{outcome:'succeeded',evidence:'在独立收件目录查到同一动作和正文'});
    assert.equal(result.write_status,'succeeded');
    assert.deepEqual(await call(url+'/publish','POST'),result);
    assert.deepEqual((await call(path))[0].delivery,result);
    assert.equal(readdirSync(receipts).length,1);
  } finally {await restarted.stop();}
});

test('本机 Redmine HTTP 核验账号、两阶段发送、丢失回执不重发和游标落盘',{timeout:20000},async()=>{
  const f=input('本机 Redmine'), writes:string[]=[];
  const issue={id:42,project:{id:7},assigned_to:{id:5},author:{id:9},description:'请分析',subject:'详情',updated_on:new Date().toISOString(),
    journals:[] as {id:number;notes:string;user:{id:number};created_on:string;details:unknown[]}[]};
  let user=5,issueProject=7;
  const fake=createServer(async(req,res)=>{
    if(req.headers['x-redmine-api-key']!=='offline-key') {res.writeHead(403).end();return;}
    if(req.url==='/users/current.json') res.end(JSON.stringify({user:{id:user}}));
    else if(req.url?.startsWith('/issues.json?')) res.end(JSON.stringify({issues:[{id:42}],offset:0,total_count:1}));
    else if(req.url?.startsWith('/issues/42.json?include=')) res.end(JSON.stringify({issue}));
    else if(req.url==='/issues/42.json' && req.method==='GET') res.end(JSON.stringify({issue:{id:42,project:{id:issueProject}}}));
    else if(req.url==='/issues/42.json' && req.method==='PUT') {
      let raw='';for await(const b of req) raw+=b;
      const text=JSON.parse(raw).issue.notes;writes.push(text);
      issue.journals.push({id:writes.length,notes:text,user:{id:5},created_on:new Date().toISOString(),details:[]});
      res.writeHead(text==='回执不明'?503:204).end();
    } else res.writeHead(404).end();
  });
  fake.listen(0,'127.0.0.1');await once(fake,'listening');
  const base='http://127.0.0.1:'+(fake.address() as {port:number}).port;
  const db=new DatabaseSync(join(f.dir,'superagent.db'));
  db.prepare("UPDATE events SET data=json_set(data,'$.metadata.redmine_endpoint',?,'$.project_external_id','7') WHERE id=?").run(base,f.event);
  db.exec(`UPDATE projects SET redmine_project_ids='[7]';
    INSERT INTO governance_identities(source,actor_id,user_id,enabled) VALUES('redmine','9','owner',1),('redmine','5','owner',1);
    INSERT INTO governance_identity_grants(identity_id,project_ids,permissions) SELECT id,'[1]','["request"]' FROM governance_identities`);
  const h=host(f.dir,false,false,{LOCAL_TEST_REDMINE_KEY:'offline-key'});
  try {
    const call=client(await h.address()),cfg={enabled:true,user_id:5,base_url:base,project_ids:[7],poll_seconds:1,api_key_env:'LOCAL_TEST_REDMINE_KEY',account_map:{me:[5],both:[5,9]}};
    await call('/settings','PATCH',{'connectors.redmine':{...cfg,account_map:{me:['5']}}},422);
    await call('/settings','PATCH',{external_delivery_enabled:true,'connectors.redmine':cfg});
    async function approved(content:string) {
      const d=await call('/tasks/'+f.task+'/deliveries','POST',{event_id:f.event,content});
      await call('/deliveries/'+d.id+'/decision','POST',{decision:'approve',action_hash:d.approval.action_hash});
      return '/deliveries/'+d.id;
    }
    const ok=await approved('正常回执'),unknown=await approved('回执不明'),wrong=await approved('账号不匹配'),moved=await approved('项目变化');
    assert.equal((await call(ok+'/publish','POST')).write_status,'succeeded');
    await call(ok+'/publish','POST');
    assert.equal((await call(unknown+'/publish','POST')).write_status,'unknown');
    await call(unknown+'/publish','POST');
    const stopAt=Date.now()+6000;
    while(Date.now()<stopAt && Number(db.prepare('SELECT count(*) n FROM delivery_echo_bindings').get()!.n)!==2) await delay(75);
    assert.deepEqual(db.prepare('SELECT json_extract(data,\'$.routing_status\') s FROM events WHERE external_id LIKE ? ORDER BY id').all('%journal:%').map(r=>r.s),['self_echo','self_echo_candidate']);
    assert.equal(db.prepare("SELECT json_extract(data,'$.routing_status') s FROM events WHERE event_type='issue.updated'").get()?.s,'routed');
    assert.equal((await call(unknown+'/publish','POST')).echo_evidence.routing_status,'self_echo_candidate');
    await call(unknown+'/reconcile','POST',{outcome:'succeeded',evidence:'假服务收到一份'});
    await call(unknown+'/publish','POST');
    user=6;
    await call(wrong+'/publish','POST',undefined,409);
    user=5;issueProject=9;
    await call(moved+'/publish','POST',undefined,409);
    assert.deepEqual(writes,['正常回执','回执不明']);
    assert.ok(db.prepare("SELECT value FROM connector_cursors WHERE key=?").get('redmine:'+base+':7:5'));
    await call('/connectors/redmine/stop','POST');
    assert.equal((await call('/connectors')).find((row:any)=>row.id==='redmine').status,'stopped');
    assert.deepEqual((await call('/overview')).connectors,await call('/connectors'));
  } finally {await h.stop();db.close();fake.closeAllConnections();await new Promise<void>(r=>fake.close(()=>r()));}
});
test('本机 DWS HTTP 对私聊发件人及源消息精确绑定，账号变更后拒绝发出',{timeout:20000},async()=>{
  const f=input('本机 DWS'),db=new DatabaseSync(join(f.dir,'superagent.db'));
  const data={routing_status:'routed',actor_id:'peer',thread_id:'private-chat',occurred_at:new Date(Date.now()-60000).toISOString(),
    metadata:{profile:'offline-profile',conversation_type:'direct',message_id:'peer-message',dws_event_type:'user_im_message_receive_o2o_all'}};
  db.prepare("UPDATE events SET source='dingtalk',data=? WHERE id=?").run(JSON.stringify(data),f.event);
  const log=join(f.dir,'dws.log'),script=fileURLToPath(new URL('../../../../../packages/channels/tests/fake-dws.mjs',import.meta.url));
  const cfg={enabled:true,profile:'offline-profile',self_ids:['operator'],executable:[process.execPath,script,log],kind:'all-direct'};
  const h=host(f.dir,false);
  try {
    const call=client(await h.address());
    await call('/settings','PATCH',{'connectors.dingtalk':cfg,external_delivery_enabled:true,
      dingtalk_response_policy:{delivery:'approved_send',direct_messages:'reply',group_messages:'off',default_project_id:null}});
    async function approved() {
      const d=await call('/tasks/'+f.task+'/deliveries','POST',{event_id:f.event,content:'私聊答复'});
      assert.equal(d.approval.action.target.recipient_id,'peer');
      await call('/deliveries/'+d.id+'/decision','POST',{decision:'approve',action_hash:d.approval.action_hash});
      return '/deliveries/'+d.id+'/publish';
    }
    const url=await approved();
    const result=await call(url,'POST');
    assert.equal(result.message_id,'offline-answer');
    assert.deepEqual(await call(url,'POST'),result);
    const deadline=Date.now()+5000;
    let status;
    do {
      status=(await call('/connectors')).find((r:any)=>r.id==='dingtalk');
      if(status.scopes?.some((s:any)=>s.last_seen)) break;
      await delay(60);
    }while(Date.now()<deadline);
    assert.equal(status.status,'running');assert.equal(status.scopes[0].kind,'all-direct');
    assert.ok(status.scopes[0].last_seen);assert.deepEqual(status.missing_configuration,[]);
    const sync='/event-groups/'+f.task+'/sync-own-dingtalk';
    await call(sync,'POST',{},403,'member');
    assert.deepEqual(await call(sync,'POST',{}),{added:1});
    assert.deepEqual(await call(sync,'POST',{}),{added:0});
    assert.equal(db.prepare("SELECT json_extract(data,'$.routing_status') status FROM events WHERE external_id LIKE '%:history-own'").get()?.status,'self_context');
    assert.equal(db.prepare("SELECT id FROM events WHERE external_id LIKE '%:history-unrelated'").get(),undefined);
    const other=await approved();
    await call('/settings','PATCH',{'connectors.dingtalk':{...cfg,self_ids:['different']}});
    await call(other,'POST',undefined,409);
    await call(sync,'POST',{},409);
    const argv=(readFileSync(log,'utf8').trim().split('\n').map(line=>JSON.parse(line)) as string[][]).filter(a=>a.includes('+messages-reply'));
    assert.equal(argv.length,1);
    for(const [flag,value] of Object.entries({'--profile':'offline-profile','--group':'private-chat','--message-id':'peer-message','--open-dingtalk-id':'peer'}))
      assert.equal(argv[0][argv[0].indexOf(flag)+1],value);
  } finally {await h.stop();db.close();}
});

test('本机飞书 HTTP 签名密文接受验证挑战，拒绝改包、错 token 与未开启的入口',{timeout:15000},async()=>{
  const f=input('飞书'),key='offline-only-key',token='offline-verification';
  const h=host(f.dir,false,false,{SUPERAGENT_FEISHU_ENABLED:'1',SUPERAGENT_FEISHU_MODE:'card',SUPERAGENT_FEISHU_APP_ID:'app-offline',
    SUPERAGENT_FEISHU_OPEN_ID:'ou_test',SUPERAGENT_FEISHU_OWNER_ID:'owner',SUPERAGENT_FEISHU_ENCRYPT_KEY:key,SUPERAGENT_FEISHU_VERIFICATION_TOKEN:token});
  try {
    const address=await h.address(),ts=String(Math.floor(Date.now()/1000)),nonce='offline';
    async function submit(value:string,changed=false) {
      const iv=randomBytes(16),cipher=createCipheriv('aes-256-cbc',createHash('sha256').update(key).digest(),iv);
      const content=JSON.stringify({type:'url_verification',challenge:'offline-challenge',token:value});
      const raw=JSON.stringify({encrypt:Buffer.concat([iv,cipher.update(content),cipher.final()]).toString('base64')});
      const signature=createHash('sha256').update(ts+nonce+key+raw).digest('hex');
      return fetch(address+'/callbacks/feishu/card',{method:'POST',headers:{'content-type':'application/json','x-lark-request-timestamp':ts,
        'x-lark-request-nonce':nonce,'x-lark-signature':signature},body:changed?raw+' ':raw,signal:AbortSignal.timeout(5000)});
    }
    const ok=await submit(token);assert.equal(ok.status,200);assert.deepEqual(await ok.json(),{challenge:'offline-challenge'});
    assert.equal((await submit(token,true)).status,403);assert.equal((await submit('wrong')).status,403);
  }finally{await h.stop();}
  const disabled=host(f.dir,false);
  try {
    const res=await fetch(await disabled.address()+'/callbacks/feishu/card',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
    assert.equal(res.status,404);
  }finally{await disabled.stop();}
});
