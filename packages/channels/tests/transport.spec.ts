import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createCipheriv,createHash,randomBytes } from 'node:crypto';
import { openStorage } from '../../storage/index.ts';
import { fixture,live,request } from '../../storage/tests/helpers.ts';
import { ChannelError,CursorStore } from '../common.ts';
import type { Incoming } from '../common.ts';
import { Redmine,RedminePoller } from '../redmine.ts';
import { listenDws,normalizeDws,replyDws,verifyDws } from '../dingtalk.ts';
import { cardReceiver,decodeCard } from '../feishu.ts';

test('loopback Redmine 账号、分页、失败重放、旧快照恢复、同时间 A→B→A 及账号隔离',{timeout:15000},async()=>{
  const s=openStorage(':memory:'),state=new CursorStore(s.db), signal=AbortSignal.timeout(12000);
  const issue={id:41,project:{id:7},subject:'离线',description:'A',assigned_to:{id:5},author:{id:9},updated_on:'2026-11-18T08:00:00.123456Z',
    journals:[{id:71,user:{id:9},created_on:'2026-11-18T08:01:00Z',notes:'初次来信',details:[]}]};
  let user=5,fail=true,writes=0,offsets:number[]=[];
  const server=createServer(async(req,res)=>{
    if(req.headers['x-redmine-api-key']!=='fake-key'){res.writeHead(403).end();return;}
    const u=new URL(req.url!,'http://127.0.0.1');
    if(u.pathname==='/users/current.json') res.end(JSON.stringify({user:{id:user}}));
    else if(u.pathname==='/issues.json'){
      assert.equal(u.searchParams.get('project_id'),'7');
      assert.equal(u.searchParams.get('subproject_id'),'!*');
      const offset=Number(u.searchParams.get('offset'));offsets.push(offset);
      res.end(JSON.stringify({offset,total_count:2,issues:[{id:offset?42:41}]}));
    } else if(req.method==='PUT') {
      let body='';for await(const chunk of req) body+=chunk;
      assert.deepEqual(JSON.parse(body),{issue:{notes:'合成答复'}});
      writes++;res.writeHead(204).end();
    } else if(u.pathname==='/issues/41.json') res.end(JSON.stringify({issue}));
    else if(u.pathname==='/issues/42.json') res.end(JSON.stringify({issue:{...issue,id:42,assigned_to:{id:8},journals:[]}}));
    else res.writeHead(404).end();
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const address=server.address() as {port:number},base='http://127.0.0.1:'+address.port;
  try {
    const client=new Redmine({base_url:base,user_id:5,project_ids:[7]},'fake-key');
    for(const account_map of [{me:'5'},{me:['5']},{me:[0]},{me:[]},{me:[true]}]) {
      assert.throws(()=>new Redmine({...client.config,account_map:account_map as unknown as Record<string,number[]>},'fake-key'));
    }
    const emit=async(e:Incoming)=>{
      if(fail && e.event_type==='issue.comment') throw new Error('未确认');
      s.db.prepare('INSERT OR IGNORE INTO events(source,external_id,event_type,content,data,created_at) VALUES(?,?,?,?,?,?)')
        .run(e.source,e.external_id,e.event_type,e.content,JSON.stringify(e),e.occurred_at);
    };
    const poller=()=>new RedminePoller(client,state,emit), key=poller().key,sem=key+':issue:41:semantics';
    await assert.rejects(poller().pollOnce(signal),/未确认/);
    assert.equal(state.get(key),null);assert.equal(state.get(sem),null);
    assert.ok(state.get(key+':pending_initial_issue'));
    fail=false;
    await poller().pollOnce(signal);
    const events=()=>s.db.prepare("SELECT external_id,data FROM events WHERE event_type='issue.updated' ORDER BY id").all();
    assert.equal(events().length,1);
    assert.deepEqual(offsets.splice(0),[0,0,1]);
    // Simulate a pre-checkpoint DB. Restore only from a matching persisted source receipt.
    s.db.prepare('DELETE FROM connector_cursors WHERE key=?').run(sem);
    issue.updated_on='2026-11-18T08:03:00.123456Z';
    await poller().pollOnce(signal);
    assert.equal(events().length,1);
    issue.description='B';await poller().pollOnce(signal);
    issue.description='A';await poller().pollOnce(signal);
    assert.equal(events().length,3);assert.match(String(events()[2].external_id),/snapshot:3:/);
    assert.equal(JSON.parse(String(events()[0].data)).occurred_at,'2026-11-18T08:00:00.123456Z');
    const before=state.get(key);
    user=9;await assert.rejects(poller().pollOnce(signal),/account_mismatch/);assert.equal(state.get(key),before);
    user=5;await client.verify(signal);assert.equal((await client.comment(41,'合成答复',signal)).write_status,'succeeded');
    assert.equal(writes,1);
    issue.description='@me @ambiguous @unmapped @other';issue.assigned_to={id:8};
    const mappedClient=new Redmine({...client.config,account_map:{me:[5],ambiguous:[5,9],other:[9]}},'fake-key');
    const seen:Incoming[]=[];
    await new RedminePoller(mappedClient,state,async e=>{seen.push(e);}).pollOnce(signal);
    const meta=seen.find(e=>e.issue_id==='41' && e.event_type==='issue.updated')!.metadata;
    assert.deepEqual(meta.mentions,['me']);assert.deepEqual(meta.uncertain_mentions,['ambiguous','unmapped']);
  }finally {s.close();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});

test('假 DWS 逐条确认、历史重放、profile/私聊对象、同账号发言和有界关闭',{timeout:15000},async()=>{
  const dir=mkdtempSync(join(tmpdir(),'DWS 离线-')),file=join(dir,'invocations.txt');
  const s=openStorage(':memory:'),state=new CursorStore(s.db);
  const c={profile:'offline-profile',self_ids:['operator'],executable:[process.execPath,fileURLToPath(new URL('./fake-dws.mjs',import.meta.url)),file]};
  try {
    const received:Incoming[]=[];
    const abort=new AbortController();
    const read=listenDws(c,{kind:'all-direct'},state,async e=>{
      received.push(e);if(received.length===2) setImmediate(()=>abort.abort());
    },process.env,abort.signal,()=>{});
    await read;
    assert.equal(received[0].metadata.self_authored,true);
    assert.equal(received[1].metadata.conversation_type,'direct');
    assert.equal(state.get('dingtalk:offline-profile:all-direct:'),received[1].occurred_at);
    const target={profile:c.profile,conversation_id:'private-chat',message_id:'peer-message',recipient_id:'peer'};
    const reply=await replyDws(c,target,'离线回复','reply-19',process.env,AbortSignal.timeout(5000));
    assert.equal(reply.message_id,'offline-answer');
    await assert.rejects(replyDws(c,{...target,profile:'changed'},'x','reply-19',process.env,AbortSignal.timeout(5000)),/target/);
    await assert.rejects(verifyDws({...c,self_ids:['different']},process.env,AbortSignal.timeout(5000)),/account_mismatch/);
    assert.throws(()=>normalizeDws({type:'user_im_message_receive_group',profile:'bad'},c,{kind:'all-direct'}),ChannelError);
    const history={chat_ids:['group'],history_timezone:'Asia/Shanghai',initial_since:new Date(Date.now()-86400000).toISOString(),sender_map:{'old-peer':'peer'}};
    const ctrl=new AbortController(),group:Incoming[]=[];
    await listenDws({...c,history},{kind:'group',chatId:'group'},state,async e=>{
      group.push(e);if(group.length===3)setImmediate(()=>ctrl.abort());
    },process.env,ctrl.signal,()=>{});
    assert.equal(group[0].actor_id,'peer');assert.match(group[0].external_id,/historical$/);
    const log=readFileSync(file,'utf8').trim().split('\n').map(l=>JSON.parse(l) as string[]);
    assert.equal(log.filter(a=>a.includes('+messages-reply')).length,1);
    assert.ok(log.find(a=>a.includes('+messages-reply'))!.includes('--open-dingtalk-id'));
  }finally{s.close();rmSync(dir,{recursive:true,force:true});}
});

test('飞书受限回调：签名密文、时间窗、角色与消息绑定、重复和旧版本',async t=>{
  const f=fixture(t),id=live(f), a=f.s.requestWorkerApproval(f.lease,id,request);
  f.s.db.prepare("INSERT INTO feishu_decision_notices VALUES(?,'sent','om_test')").run(a.id);
  const config={appId:'app-test',recipient:'ou_test',owner:'owner',encryptKey:'fixture-only-encryption-key',verificationToken:'fixture-token'};
  const payload={schema:'2.0',header:{app_id:config.appId,event_type:'card.action.trigger',token:config.verificationToken},event:{
    operator:{open_id:'ou_test'},context:{open_message_id:'om_test'},action:{value:{approval_id:a.id,decision:'approve'}}}};
  const iv=randomBytes(16),cipher=createCipheriv('aes-256-cbc',createHash('sha256').update(config.encryptKey).digest(),iv);
  const raw=Buffer.from(JSON.stringify({encrypt:Buffer.concat([iv,cipher.update(JSON.stringify(payload)),cipher.final()]).toString('base64')}));
  const ts=String(Math.floor(Date.now()/1000)),nonce='test';
  const sign=createHash('sha256').update(ts+nonce+config.encryptKey).update(raw).digest('hex');
  assert.deepEqual(decodeCard(config,raw,ts,nonce,sign),payload);
  assert.throws(()=>decodeCard(config,raw,ts,nonce,sign,Date.now()+400000),ChannelError);
  assert.throws(()=>decodeCard(config,Buffer.concat([raw,Buffer.from(' ')]),ts,nonce,sign),ChannelError);
  let calls=0;
  const receive=cardReceiver(f.s.db,config,async(owner,aid,decision,hash)=>{
    calls++;assert.equal(owner,'owner');
    f.s.dispatchWorkerDecision(f.lease,id,aid,{decision,actionHash:hash,actor:owner,authorize:()=>true});
    return f.s.finishWorkerDecision(f.lease,id,aid,'confirmed');
  });
  const toast=async()=>{const result=await receive(payload);assert.ok('toast' in result);return result.toast.type;};
  payload.event.operator.open_id='ou_wrong';await assert.rejects(receive(payload),/identity/);payload.event.operator.open_id='ou_test';
  payload.event.context.open_message_id='om_wrong';assert.equal(await toast(),'error');payload.event.context.open_message_id='om_test';
  f.s.db.exec('UPDATE tasks SET control_version=2');assert.equal(await toast(),'error');
  f.s.db.exec('UPDATE tasks SET control_version=1');assert.equal(await toast(),'success');
  assert.equal(await toast(),'info');assert.equal(calls,1);
});
