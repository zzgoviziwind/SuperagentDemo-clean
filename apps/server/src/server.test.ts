import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { assembleContext } from './context.js';
import { fenceHostWrites } from './lease.js';
import type { HTTPMethods } from 'fastify';
import { afterEach, expect, it } from 'vitest';
import { buildServer } from './server.js';

const roots: string[]=[];
afterEach(()=>{for(const root of roots.splice(0)) rmSync(root,{recursive:true,force:true});});
it('registers every method and path in the frozen HTTP inventory',async()=>{
  const root=mkdtempSync(join(tmpdir(),'superagent-routes-'));
  roots.push(root);
  const app=await buildServer({SUPERAGENT_DATA_DIR:root,SUPERAGENT_SERVICE_MODE:'preview'});
  try {
    const inventory=JSON.parse(readFileSync(new URL('../../../docs/rewrite/surface.json',import.meta.url),'utf8'));
    const missing=Object.keys(inventory.routes).filter(route=>{
      const [method,pattern]=route.split(' ');
      return !app.findRoute({method:method as HTTPMethods,url:pattern.replace(/\{[^}]+\}/g,'1')})?.handler;
    });
    expect(missing).toEqual([]);
  } finally {await app.close();}
});
it('routes a bound source once, keeps ungranted receipts pending, serves the same group after restart',async()=>{
  const root=mkdtempSync(join(tmpdir(),'superagent-合同 '));
  roots.push(root);
  const env={SUPERAGENT_DATA_DIR:root,SUPERAGENT_ALLOWED_REPO_ROOTS:root};
  let app=await buildServer(env);
  try {
    const post=(url:string,payload:object)=>app.inject({method:'POST',url:'/api/v1'+url,payload});
    const project=await post('/projects',{name:'合成项目',repo_path:root,redmine_project_ids:['7']});
    expect(project.statusCode,project.body).toBe(200);
    const source={source:'redmine',external_id:'fixture-1',event_type:'issue.comment',actor_id:'9',issue_id:'42',project_external_id:'7',content:'请修复离线样本',metadata:{redmine_endpoint:'https://fixture.invalid'}};
    const held=await post('/events',{...source,external_id:'before-grant'});
    expect(held.json().data.routing_status).toBe('pending_confirmation');
    const mapped=await post('/identities',{source:'redmine',actor_id:'9',user_id:'admin',enabled:true,permissions:['request'],project_ids:[project.json().id]});
    expect(mapped.statusCode,mapped.body).toBe(200);
    const received=await post('/events',source);
    expect(received.statusCode,received.body).toBe(200);
    expect(received.json().data.routing_status).toBe('routed');
    const duplicate=await post('/events',source);
    expect(duplicate.json()).toMatchObject({duplicate:true,id:received.json().id,task_id:received.json().task_id});
    await app.close();
    app=await buildServer(env);
    const tasks=await app.inject('/api/v1/tasks');
    expect(tasks.json()).toHaveLength(1);
    const groups=await app.inject('/api/v1/event-groups/index?source=redmine');
    expect(groups.statusCode,groups.body).toBe(200);
    expect(groups.json().items.some((i:{group?:{id:number}})=>i.group?.id===received.json().task_id)).toBe(true);
  } finally { await app.close(); }
});
it('fences late callbacks on the writing connection after an ownership change',()=>{
  const db=new DatabaseSync(':memory:');
  try {
    db.exec("CREATE TABLE controller_leases(id TEXT,owner TEXT,epoch INTEGER,expires_at TEXT); CREATE TABLE scratch(n INTEGER); INSERT INTO controller_leases VALUES('controller','a',3,datetime('now','+1 day'))");
    const check=fenceHostWrites(db,{owner:'a',epoch:3});
    check();
    db.exec('INSERT INTO scratch VALUES(1)');
    db.exec("UPDATE controller_leases SET owner='b',epoch=4");
    expect(check).toThrow('租约已失效');
    expect(()=>db.exec('UPDATE scratch SET n=2')).toThrow('controller lease lost');
    expect(db.prepare('SELECT n FROM scratch').get()?.n).toBe(1);
  } finally { db.close(); }
});
it('keeps one durable subscription across concurrent requests and decodes the old audit format',async()=>{
  const root=mkdtempSync(join(tmpdir(),'superagent-subscriptions-'));
  roots.push(root);
  const app=await buildServer({SUPERAGENT_DATA_DIR:root,SUPERAGENT_ALLOWED_REPO_ROOTS:root,SUPERAGENT_SERVICE_MODE:'preview'});
  const db=new DatabaseSync(join(root,'superagent.db'));
  try {
    const post=(url:string,payload:object)=>app.inject({method:'POST',url:'/api/v1'+url,payload});
    const project=(await post('/projects',{name:'订阅样例',repo_path:root,dingtalk_chat_ids:['team']})).json();
    const task=(await post('/tasks',{project_id:project.id,title:'离线测试',goal:'核对订阅'})).json();
    const request={project_id:project.id,task_id:task.id,thread_id:'team',profile:'offline',source:'dingtalk'};
    const replies=await Promise.all(Array.from({length:4},()=>post('/subscriptions',request)));
    expect(replies.map(r=>r.statusCode)).toEqual([200,200,200,200]);
    expect(new Set(replies.map(r=>r.json().id)).size).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM worker_subscriptions').get()?.n).toBe(1);
    const cancelled=await app.inject({method:'DELETE',url:'/api/v1/subscriptions/'+replies[0].json().id});
    expect(cancelled.json().enabled).toBe(false);
    const audit=await app.inject('/api/v1/audit?limit=1');
    expect(audit.json()).toEqual([expect.objectContaining({action:'subscription.cancel',details:{}})]);
  } finally {db.close();await app.close();}
});
it('requires an available engine to resume legacy reply tasks and records message revisions',async()=>{
  const root=mkdtempSync(join(tmpdir(),'superagent-legacy-reply-'));
  roots.push(root);
  const app=await buildServer({SUPERAGENT_DATA_DIR:root,SUPERAGENT_ALLOWED_REPO_ROOTS:root,SUPERAGENT_SERVICE_MODE:'preview'});
  const db=new DatabaseSync(join(root,'superagent.db'));
  try {
    const post=(url:string,payload:object)=>app.inject({method:'POST',url:'/api/v1'+url,payload});
    const project=(await post('/projects',{name:'回复验证',repo_path:root})).json();
    const task=(await post('/tasks',{project_id:project.id,title:'回复',goal:'离线复核',kind:'reply'})).json();
    const path='/tasks/'+task.id;
    expect((await post(path+'/controls',{action:'bogus'})).statusCode).toBe(409);
    db.prepare("UPDATE tasks SET status='waiting_resource',last_error='未配置本机回复引擎' WHERE id=?").run(task.id);
    expect((await post(path+'/controls',{action:'resume'})).statusCode).toBe(409);
    db.prepare("UPDATE tasks SET status='review_ready',last_error=NULL WHERE id=?").run(task.id);
    expect((await post(path+'/messages',{content:'请补充交付依据'})).statusCode).toBe(200);
    expect(db.prepare('SELECT status,last_error FROM tasks WHERE id=?').get(task.id)).toEqual({
      status:'waiting_input',last_error:'收到新补充，请继续执行后重新验收'});
    const audit=await app.inject('/api/v1/audit?limit=1');
    expect(audit.json()[0]).toMatchObject({action:'task.message',details:{revision:2,state_version:2}});
  } finally {db.close();await app.close();}
});
it('limits recalled summaries by current audience, owner and decision provenance',async()=>{
  const root=mkdtempSync(join(tmpdir(),'superagent-context-'));
  roots.push(root);
  const app=await buildServer({SUPERAGENT_DATA_DIR:root,SUPERAGENT_ALLOWED_REPO_ROOTS:root,SUPERAGENT_SERVICE_MODE:'preview'});
  const db=new DatabaseSync(join(root,'superagent.db'));
  try {
    const post=(url:string,payload:object)=>app.inject({method:'POST',url:'/api/v1'+url,payload});
    const project=(await post('/projects',{name:'历史范围',repo_path:root})).json();
    const tasks:number[]=[];
    for(const label of ['当前','同收件人','其他人','不同群','丢失清单']) {
      const t=(await post('/tasks',{project_id:project.id,title:label,goal:'离线测试'})).json();
      tasks.push(t.id);
      db.prepare("UPDATE tasks SET source='dingtalk',owner_id=? WHERE id=?").run(label==='其他人'?'bob':'admin',t.id);
      const data={actor_id:'sender',thread_id:label==='不同群'?'other':'team',metadata:{profile:'sample'}};
      db.prepare("INSERT INTO events(task_id,external_id,source,event_type,content,data,created_at) VALUES(?,?,'dingtalk','message.received','message',?,datetime('now'))")
        .run(t.id,'sample-'+t.id,JSON.stringify(data));
      const artifact=db.prepare("INSERT INTO artifacts(task_id,revision,kind,content,created_at) VALUES(?,1,'summary',?,datetime('now'))").run(t.id,label+'摘要');
      if(label==='丢失清单') db.prepare("INSERT INTO events(task_id,source,event_type,content,data,created_at) VALUES(?,'runtime','assistant_message','',?,datetime('now'))")
        .run(t.id,JSON.stringify({artifact_id:Number(artifact.lastInsertRowid),manifest_id:99999}));
    }
    const context=assembleContext(db,tasks[0]);
    expect(context.prompt).toContain('同收件人摘要');
    for(const label of ['其他人摘要','不同群摘要','丢失清单摘要']) expect(context.prompt).not.toContain(label);
    expect(context.items).toContainEqual(expect.objectContaining({id:tasks[4],type:'recent_work',included:false}));
  } finally { db.close(); await app.close(); }
});
