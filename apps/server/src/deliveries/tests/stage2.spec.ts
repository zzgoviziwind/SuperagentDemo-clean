import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync,readdirSync,existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { actionHash,openStorage } from '../../../../../packages/storage/index.ts';
import { client,host,input,decisionPreparer } from './harness.ts';

async function until<T>(read:()=>T|Promise<T>,accept:(v:T)=>boolean) {
  const deadline=Date.now()+10000;
  let value:T;
  do {value=await read();if(accept(value)) return value;await delay(70);}while(Date.now()<deadline);
  throw new Error('等待超时 '+JSON.stringify(value));
}
const standing={direct_messages:'reply',group_messages:'off',delivery:'auto_send',default_project_id:null};
function save(db:DatabaseSync,key:string,value:unknown) {db.prepare('INSERT OR REPLACE INTO governance_settings VALUES(?,?,?)').run(key,JSON.stringify(value),new Date().toISOString());}
const red={enabled:true,base_url:'https://fixture.invalid',project_ids:[7],user_id:5};

test('本机 HTTP 按量假 Worker，预算为零不派发，单轮预留、未知用量、核验与人审',{timeout:30000},async()=>{
  const f=input('按量预算'),db=new DatabaseSync(join(f.dir,'superagent.db'));
  const exe=join(f.dir,'metered.exe'),log=join(f.dir,'observed-turns.txt');
  const compiler=join(process.env.SystemRoot!,'Microsoft.NET','Framework64','v4.0.30319','csc.exe');
  execFileSync(compiler,['/nologo','/noconfig','/reference:System.Web.Extensions.dll','/out:'+exe,
    fileURLToPath(new URL('./MeteredFixture.cs',import.meta.url))],{cwd:f.dir,timeout:10000});
  db.prepare('UPDATE projects SET repo_path=?').run(f.dir);
  db.exec("UPDATE tasks SET kind='reply'");
  const h=host(f.dir,false,false,{SUPERAGENT_CODEX_EXECUTABLE:exe,SUPERAGENT_CODEX_HOME:f.dir});
  try{
    const call=client(await h.address());
    await call('/settings','PATCH',{budget_reservation_estimate_micros:10,
      'connectors.redmine':{...red,enabled:false},dingtalk_response_policy:standing});
    await call('/budgets/global','PATCH',{hard_limit_micros:0});
    const connect=()=>call('/agents/local/connect','POST',{agent_id:'codex',use_existing_login:true});
    assert.equal((await connect()).execution_enabled,false);
    await call('/settings','PATCH',{scheduler_enabled:true});
    const detail=()=>call('/tasks/'+f.task);
    const blocked=await until(detail,d=>d.task.status==='failed');
    assert.match(blocked.task.last_error,/预算/);
    assert.equal(existsSync(log),false);
    assert.deepEqual(await call('/budget-reservations'),[]);
    await call('/budgets/global','PATCH',{hard_limit_micros:10});
    assert.equal((await connect()).execution_enabled,true);
    const task=await call('/tasks','POST',{kind:'reply',title:'合成计费回复',goal:'只输出待审正文',project_id:1});
    db.prepare("INSERT INTO events(task_id,source,event_type,content,data,created_at) SELECT ?,source,event_type,content,data,created_at FROM events WHERE id=?")
      .run(task.id,f.event);
    const review=await until(()=>call('/tasks/'+task.id),d=>d.events.some((e:any)=>e.event_type==='reply_decision'));
    assert.equal(review.task.status,'review_ready');
    assert.equal(review.events.find((e:any)=>e.event_type==='reply_decision').data.decision,'review');
    assert.equal((await call('/tasks/'+task.id+'/deliveries'))[0].delivery,null);
    const [r]=await call('/budget-reservations');
    assert.equal(r.task_id,task.id);assert.equal(r.estimate_micros,10);assert.equal(r.status,'unknown');
    assert.equal((await call('/budgets'))[0].reserved_micros,10);
    const evidence={actual_micros:3,evidence:'合成独立用量'};
    for(let i=0;i<2;i++) assert.equal((await call('/budget-reservations/'+r.id+'/reconcile','POST',evidence)).status,'settled');
    const ledger=(await call('/budgets'))[0];
    assert.equal(ledger.spent_micros,3);assert.equal(ledger.reserved_micros,0);
    assert.equal((await call('/budget-reservations')).length,1);
    assert.deepEqual(readFileSync(log,'utf8').trim().split('\n'),['turn/start']);
  }finally{await h.stop();db.close();}
});

test('DWS 原私聊消息附件经实际 HTTP 入站核验，错误回话账单没有产物',{timeout:18000},async()=>{
  const f=input('钉钉附件'),db=new DatabaseSync(join(f.dir,'superagent.db')),log=join(f.dir,'dws.log');
  db.exec(`UPDATE projects SET dingtalk_chat_ids='["private-chat"]';INSERT INTO governance_identities(source,actor_id,user_id,enabled) VALUES('dingtalk','actor-9','owner',1);
    INSERT INTO governance_identity_grants(identity_id,project_ids,permissions) SELECT id,'[1]','["request"]' FROM governance_identities`);
  const h=host(f.dir,false);
  try{
    const call=client(await h.address()),script=fileURLToPath(new URL('../../../../../packages/channels/tests/fake-dws.mjs',import.meta.url));
    await call('/settings','PATCH',{'connectors.dingtalk':{enabled:true,profile:'offline-profile',self_ids:['operator'],kind:'all-direct',executable:[process.execPath,script,log]}});
    for(const [index,message] of ['attachment-message','different-source'].entries()){
      const r=await call('/events','POST',{source:'dingtalk',external_id:'attachment-'+index,event_type:'message.received',actor_id:'actor-9',
        project_external_id:'private-chat',thread_id:'private-chat',content:'请分析附件 #'+(80+index),metadata:{profile:'offline-profile',message_id:message,
          dws_event_type:'user_im_message_receive_o2o_all'},attachments:[{kind:'image',local_path:'unused'}]});
      const job=await until(()=>db.prepare('SELECT status,results FROM event_attachment_jobs WHERE event_id=?').get(r.id),
        j=>!!j && ['completed','failed'].includes(String(j.status)));
      const files=JSON.parse(String(job!.results));
      assert.equal(job?.status,index?'failed':'completed');assert.equal(files.length,index?0:1);
      if(!index) assert.equal(readFileSync(files[0].local_path,'utf8'),'附件原文');
    }
    const commands=readFileSync(log,'utf8').trim().split('\n').map(l=>JSON.parse(l) as string[]).filter(c=>c.includes('+messages-mget'));
    assert.deepEqual(commands.map(c=>c[c.indexOf('--msg-ids')+1]),['attachment-message','different-source']);
  }finally{await h.stop();db.close();}
});

test('旧飞书通知表原地补列，实际 HTTP 卡片仅发一份，模糊回执和历史行重启不重发',{timeout:22000},async()=>{
  const f=input('旧通知'),db=new DatabaseSync(join(f.dir,'superagent.db'));
  db.exec("ALTER TABLE feishu_decision_notices DROP COLUMN message_id; INSERT INTO feishu_decision_notices VALUES(9001,'sent'),(9002,'sending'),(9003,'unknown')");
  const cards:any[]=[],server=createServer(async(req,res)=>{
    let raw='';for await(const b of req) raw+=b;const body=JSON.parse(raw);
    if(req.url==='/oauth/v3/token' && body.client_id==='test-app' && body.client_secret==='test-secret') return void res.end('{"access_token":"offline-token"}');
    if(req.url==='/open-apis/im/v1/messages?receive_id_type=open_id' && req.headers.authorization==='Bearer offline-token'){
      cards.push(body);
      if(cards.length===2)return void res.writeHead(503).end();
      return void res.end('{"code":0,"data":{"message_id":"om_created"}}');
    }
    res.writeHead(403).end();
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const env={SUPERAGENT_FEISHU_ENABLED:'1',SUPERAGENT_FEISHU_MODE:'card',SUPERAGENT_FEISHU_APP_ID:'test-app',SUPERAGENT_FEISHU_APP_SECRET:'test-secret',
    SUPERAGENT_FEISHU_OWNER_ID:'owner',SUPERAGENT_FEISHU_OPEN_ID:'ou_peer',SUPERAGENT_FEISHU_ENCRYPT_KEY:'offline-enc',SUPERAGENT_FEISHU_VERIFICATION_TOKEN:'offline-check',
    TEST_FEISHU_LOOPBACK:'http://127.0.0.1:'+(server.address() as {port:number}).port};
  try{
    const h=host(f.dir,false,false,env);
    try{
      await client(await h.address())('/settings');
      assert.equal(db.prepare("SELECT count(*) n FROM feishu_decision_notices WHERE approval_id>=9001 AND message_id IS NULL").get()?.n,3);
      assert.equal(cards.length,0);
      const owner=db.prepare('SELECT owner FROM controller_leases').get()!.owner;
      function current(task:number,suffix:string){
        const attempt='current-'+suffix,thread='thread-'+suffix,turn='turn-'+suffix;
        db.prepare("UPDATE tasks SET status='waiting_approval',codex_thread_id=?,codex_turn_id=? WHERE id=?").run(thread,turn,task);
        db.prepare(`INSERT INTO execution_attempts(id,task_id,attempt_no,status,phase,owner,revision,control_version,thread_id,turn_id,updated_at)
          VALUES(?,?,1,'waiting_approval','approval',?,1,1,?,?,?)`).run(attempt,task,owner,thread,turn,new Date().toISOString());
        const action={method:'item/commandExecution/requestApproval',attempt_id:attempt,task_id:task,revision:1,control_version:1,request_id:1,params:{threadId:thread,turnId:turn}};
        return Number(db.prepare(`INSERT INTO approvals(task_id,revision,control_version,action_hash,action,status,created_at)
          VALUES(?,1,1,?,?,'pending',?)`).run(task,actionHash(action),JSON.stringify(action),new Date().toISOString()).lastInsertRowid);
      }
      const a=current(f.task,'one');
      await until(()=>db.prepare('SELECT status,message_id FROM feishu_decision_notices WHERE approval_id=?').get(a),r=>r?.status==='sent' && r.message_id==='om_created');
      assert.equal(cards[0].receive_id,'ou_peer');assert.equal(cards[0].msg_type,'interactive');
      assert.deepEqual(JSON.parse(cards[0].content).body.elements.slice(1).map((b:any)=>b.behaviors[0].value),[{approval_id:a,decision:'approve'},{approval_id:a,decision:'reject'}]);
      const task=Number(db.prepare(`INSERT INTO tasks(project_id,title,kind,owner_id,goal,status,source,acceptance_criteria,outcome_unknown,revision,control_version,state_version,created_at,updated_at)
        SELECT project_id,title,kind,owner_id,goal,'running',source,acceptance_criteria,0,1,1,1,created_at,updated_at FROM tasks WHERE id=?`).run(f.task).lastInsertRowid);
      const b=current(task,'two');
      await until(()=>db.prepare('SELECT status FROM feishu_decision_notices WHERE approval_id=?').get(b)?.status,v=>v==='unknown');
    }finally{await h.stop();}
    const restart=host(f.dir,false,false,env);
    try{await client(await restart.address())('/settings');await delay(1800);assert.equal(cards.length,2);}
    finally{await restart.stop();}
  }finally{db.close();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});

test('HTTP 自动发送、人审、静默、过时、跨版本、重启及独立收件计数',{timeout:25000},async()=>{
  const f=input('回复判断'),s=openStorage(join(f.dir,'superagent.db')),prepare=await decisionPreparer(),lease=s.startController('合成已完成轮次').lease;
  save(s.db,'connectors.redmine',red);save(s.db,'dingtalk_response_policy',standing);
  const ids:number[]=[];
  for(const [index,decision] of ['send','review','skip','send','send','plain'].entries()){
    const task=Number(s.db.prepare(`INSERT INTO tasks(project_id,title,kind,owner_id,goal,status,source,acceptance_criteria,outcome_unknown,revision,control_version,state_version,created_at,updated_at)
      SELECT project_id,title,'reply',owner_id,goal,'queued',source,acceptance_criteria,0,1,1,1,created_at,updated_at FROM tasks WHERE id=?`).run(f.task).lastInsertRowid);
    ids.push(task);
    const when=new Date(Date.now()-(index===3?86400000:0)).toISOString();
    s.db.prepare("INSERT INTO events(task_id,source,event_type,content,data,created_at) VALUES(?,'redmine','issue.comment','请回复',?,?)")
      .run(task,JSON.stringify({routing_status:'routed',actor_id:'peer',occurred_at:when,issue_id:100+index,metadata:{redmine_endpoint:red.base_url}}),when);
    const a=s.claimTask(lease,task)!.id,b={threadId:'thread-'+task,turnId:'turn-'+task};
    s.beginAttempt(lease,a);s.recordWorkspace(lease,a,f.dir,null);s.recordThread(lease,a,b.threadId);
    assert.match(prepare(s.db,task,a,'只读输入'),/只输出 JSON/);
    s.prepareTurn(lease,a);s.bindTurn(lease,a,b);
    s.completeAttempt(lease,a,b,[{kind:'summary',content:decision==='plain'?'需要人工复核':JSON.stringify({decision,reason:'合成判断',reply:decision==='skip'?'':'正文-'+index})},
      {kind:'verification',content:JSON.stringify({tool_less:true,host_checked:true,kind:'reply',evidence_source:'offline-codex-fixture',thread_id:b.threadId,turn_id:b.turnId,turn_status:'completed'})}]);
  }
  s.close();
  const receipts=join(f.dir,'fake-channel-receipts'),count=()=>existsSync(receipts)?readdirSync(receipts).length:0;
  const h=host(f.dir);
  try {
    const call=client(await h.address()),list=(i:number)=>call('/tasks/'+ids[i]+'/deliveries');
    const first=(await until(()=>list(0),l=>l.length===1))[0],stale=(await list(4))[0];
    assert.equal(count(),0);assert.equal((await list(2)).length,0);
    await call('/tasks/'+ids[4]+'/messages','POST',{content:'修改目标',change_goal:true,expected_state_version:(await call('/tasks/'+ids[4])).task.state_version});
    const hour=new Date(Date.now()+8*3600000).getUTCHours();
    await call('/event-rules','PUT',{items:[{name:'保持静默',source:'redmine',action:'quiet',start_hour:(hour+23)%24,end_hour:(hour+2)%24}]});
    await call('/settings','PATCH',{external_delivery_enabled:true});
    await delay(900);assert.equal(count(),0);
    await call('/event-rules','PUT',{items:[]});
    await until(()=>list(0),l=>l[0].delivery?.write_status==='succeeded');assert.equal(count(),1);
    assert.equal((await call('/deliveries/'+first.id+'/publish','POST')).write_status,'succeeded');
    await call('/deliveries/'+stale.id+'/publish','POST',undefined,409);
    const human=(await list(1))[0];
    await call('/deliveries/'+human.id+'/publish','POST',undefined,409);
    const task=await call('/tasks/'+ids[1]),approval=task.approvals.find((a:any)=>a.id===human.approval_id);
    await call('/deliveries/'+human.id+'/decision','POST',{decision:'approve',action_hash:approval.action_hash});
    await call('/deliveries/'+human.id+'/publish','POST');
    assert.equal(count(),2);
    const aged=await call('/tasks/'+ids[3]);
    assert.equal(aged.events.filter((e:any)=>e.event_type==='reply_decision').at(-1).data.decision,'skip');
    assert.equal((await call('/tasks/'+ids[5])).events.find((e:any)=>e.event_type==='reply_decision').data.decision,'review');
    assert.deepEqual((await call('/budget-reservations')),[]);
  }finally{await h.stop();}
  const resumed=host(f.dir);
  try{
    const call=client(await resumed.address());await call('/settings');await delay(900);
    assert.equal(count(),2);const files=readdirSync(receipts).map(n=>JSON.parse(readFileSync(join(receipts,n),'utf8')).content).sort();
    assert.deepEqual(files,['正文-0','正文-1']);
  }finally{await resumed.stop();}
});

test('HTTP 入站重新获取 Redmine 附件、大小失败、管理员重试与版本隔离',{timeout:22000},async()=>{
  const f=input('附件验证'),db=new DatabaseSync(join(f.dir,'superagent.db')),data=Buffer.from('工单附件\n','utf8');
  db.exec(`UPDATE projects SET redmine_project_ids='[7]'; INSERT INTO governance_identities(source,actor_id,user_id,enabled) VALUES('redmine','9','owner',1);
    INSERT INTO governance_identity_grants(identity_id,project_ids,permissions) SELECT id,'[1]','["request"]' FROM governance_identities`);
  let valid=false,gets=0,other=0,hold=false,release=()=>{};
  const server=createServer(async(req,res)=>{
    if(req.headers['x-redmine-api-key']!=='offline-key'){res.writeHead(403).end();return;}
    if(req.url==='/users/current.json') return void res.end(JSON.stringify({user:{id:5}}));
    if(req.url?.startsWith('/issues.json?')) return void res.end('{"offset":0,"total_count":0,"issues":[]}');
    if(req.url?.match(/^\/issues\/\d+.json\?include=attachments$/)){
      const id=Number(req.url.split('/')[2].split('.')[0]);
      return void res.end(JSON.stringify({issue:{id,project:{id:7},attachments:[{id:12,content_url:'/attachments/download/12/notes.txt',
        filename:'notes.txt',content_type:'text/plain',filesize:valid?data.length:data.length+1}]}}));
    }
    if(req.url==='/attachments/download/12/notes.txt'){
      gets++;if(hold) await new Promise<void>(r=>{release=r;});
      return void res.writeHead(200,{'content-type':'text/plain','content-length':data.length}).end(data);
    }
    other++;res.writeHead(404).end();
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const base='http://127.0.0.1:'+(server.address() as {port:number}).port,h=host(f.dir,false,false,{OFFLINE_ATTACHMENT_KEY:'offline-key'});
  try{
    const call=client(await h.address());
    await call('/settings','PATCH',{'connectors.redmine':{...red,base_url:base,api_key_env:'OFFLINE_ATTACHMENT_KEY'}});
    async function incoming(issue:number) {return call('/events','POST',{source:'redmine',external_id:'resource-'+issue,event_type:'issue.comment',
      actor_id:'9',project_external_id:'7',issue_id:issue,thread_id:String(issue),content:'请分析附件',metadata:{redmine_endpoint:base,external_user_id:'5'},
      attachments:[{id:12,filename:'忽略',local_path:'无效路径',content_url:base+'/event-url-must-never-be-used'}]});}
    const r=await incoming(41),status=(id:number)=>db.prepare('SELECT status FROM event_attachment_jobs WHERE event_id=?').get(id)?.status;
    await until(()=>status(r.id),s=>s==='failed');assert.equal(gets,1);
    const retry='/events/'+r.id+'/retry-attachments';
    await call(retry,'POST',{},403,'member');valid=true;await call(retry,'POST',{});
    await until(()=>status(r.id),s=>s==='completed');await call(retry,'POST',{},409);assert.equal(gets,2);
    const artifact=(await call('/tasks/'+r.task_id)).artifacts.find((a:any)=>a.kind==='source_attachment'),saved=JSON.parse(artifact.content);
    assert.equal(saved.sha256,createHash('sha256').update(data).digest('hex'));assert.deepEqual(readFileSync(saved.local_path),data);
    hold=true;
    const stale=await incoming(42);
    await until(()=>gets,n=>n===3);
    await call('/tasks/'+stale.task_id+'/messages','POST',{change_goal:true,content:'新版本',expected_state_version:(await call('/tasks/'+stale.task_id)).task.state_version});
    release();await until(()=>status(stale.id),s=>s==='failed');
    assert.equal((await call('/tasks/'+stale.task_id)).artifacts.filter((a:any)=>a.kind==='source_attachment').length,0);
    assert.equal(other,0);
  }finally{release();await h.stop();db.close();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});
