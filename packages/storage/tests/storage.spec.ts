import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { openStorage, StorageConflict } from '../index.ts';
import { fixture, seed, turn, live, request, draftFor, allow } from './helpers.ts';

test('同机锁、跨目录租约、续约、到期接管、失效 epoch', t => {
  const f = fixture(t);
  const same = openStorage(f.path,{clock:f.clock});
  const other = openStorage(f.path,{clock:f.clock,stateRoot:join(f.dir,'另一控制器')});
  try {
    assert.throws(() => same.startController('two'));
    assert.throws(() => other.startController('two'), StorageConflict);
    f.tick(10000);
    f.s.renewLease(f.lease);
    f.tick(25000);
    assert.throws(() => other.startController('two'), StorageConflict);
    f.tick(5000);
    const next = other.startController('ctrl').lease;
    assert.equal(next.epoch,2);
    assert.throws(() => f.s.renewLease(f.lease),StorageConflict);
    assert.throws(() => f.s.claimTask(f.lease,f.task),StorageConflict);
    f.s.releaseLease(f.lease);
    assert.ok(other.claimTask(next,f.task));
  } finally { same.close(); other.close(); }
});

test('两个独立进程同时领取只提交一条 attempt，同一任务版本只变一次', {timeout:20000}, async t => {
  const f = fixture(t);
  const children = Array.from({length:2}, () => fork(new URL('./process.ts',import.meta.url),['race',f.path,f.dir],{silent:true}));
  try {
    const ready = await Promise.all(children.map(p => once(p,'message')));
    assert.deepEqual(ready.map(([message]) => message),['ready','ready']);
    const replies = children.map(p => once(p,'message'));
    const exits = children.map(p => once(p,'exit'));
    children.forEach(p => p.send(f.lease));
    const ids = (await Promise.all(replies)).map(([msg]) => msg.id);
    assert.equal(ids.filter(Boolean).length,1);
    assert.equal(f.s.db.prepare('SELECT state_version FROM tasks').get()!.state_version,2);
    assert.equal(f.s.db.prepare('SELECT COUNT(*) n FROM execution_attempts').get()!.n,1);
    assert.throws(() => f.s.db.exec(`INSERT INTO execution_attempts(id,task_id,attempt_no,status,phase,owner,revision,control_version,updated_at)
      VALUES('another',1,2,'running','thread','ctrl',1,1,'now')`),/unique/i);
    assert.deepEqual((await Promise.all(exits)).map(([code]) => code),[0,0]);
  } finally { for (const p of children) if (p.exitCode === null) p.kill(); }
});

test('领取失败的事务回滚；未派发启动出错可明确标记失败', t => {
  const f=fixture(t);
  f.s.db.exec("CREATE TRIGGER abort_claim BEFORE INSERT ON execution_attempts BEGIN SELECT RAISE(ABORT,'injected'); END");
  assert.throws(() => f.s.claimTask(f.lease,f.task),/injected/);
  assert.equal(f.s.db.prepare('SELECT state_version FROM tasks').get()!.state_version,1);
  f.s.db.exec('DROP TRIGGER abort_claim');
  const id=f.s.claimTask(f.lease,f.task)!.id;
  f.s.beginAttempt(f.lease,id);
  assert.throws(() => f.s.beginAttempt(f.lease,id));
  f.s.failAttempt(f.lease,id,'模拟启动失败');
  assert.equal(f.s.db.prepare('SELECT status FROM tasks').get()!.status,'failed');
});

test('同轮清单与证据、错轮拒绝、回滚、重复完成不产生额外产物', t => {
  const f=fixture(t), id=live(f);
  const artifacts=[{kind:'verification',content:'{"source":"fixture"}'}];
  assert.throws(() => f.s.completeAttempt(f.lease,id,{...turn,turnId:'old'},artifacts));
  assert.throws(() => f.s.completeAttempt(f.lease,id,turn,[...artifacts,{kind:'',content:'x'}]));
  assert.equal(f.s.db.prepare('SELECT count(*) n FROM artifacts').get()!.n,0);
  f.s.completeAttempt(f.lease,id,turn,artifacts);
  assert.throws(() => f.s.completeAttempt(f.lease,id,turn,artifacts));
  assert.equal(f.s.db.prepare('SELECT attempt_id FROM artifacts').get()!.attempt_id,id);
  assert.equal(f.s.db.prepare('SELECT status FROM tasks').get()!.status,'review_ready');
  assert.equal(f.s.db.prepare('SELECT turn_id FROM context_manifests').get()!.turn_id,turn.turnId);
});

test('工具审批的回放、哈希、容量、grant、当前版本、决定和回执围栏', t => {
  const f=fixture(t), id=live(f), a=f.s.requestWorkerApproval(f.lease,id,request);
  assert.equal(f.s.requestWorkerApproval(f.lease,id,request).id,a.id);
  assert.throws(() => f.s.requestWorkerApproval(f.lease,id,{...request,params:{changed:true}}));
  const choice={actor:'owner',actionHash:a.action_hash,decision:'approve' as const,authorize:() => true};
  assert.throws(() => f.s.dispatchWorkerDecision(f.lease,id,a.id,{...choice,actionHash:'wrong'}));
  assert.throws(() => f.s.dispatchWorkerDecision(f.lease,id,a.id,{...choice,authorize:() => false}));
  assert.equal(f.s.db.prepare('SELECT status FROM approvals').get()!.status,'pending');
  const next=f.s.requestWorkerApproval(f.lease,id,{...request,requestId:8});
  assert.deepEqual(f.s.dispatchWorkerDecision(f.lease,id,a.id,choice),{requestId:7,decision:'approve'});
  assert.throws(() => f.s.dispatchWorkerDecision(f.lease,id,a.id,choice));
  assert.equal(f.s.finishWorkerDecision(f.lease,id,a.id,'confirmed'),'approved');
  assert.equal(f.s.db.prepare('SELECT status FROM tasks').get()!.status,'waiting_approval');
  f.s.dispatchWorkerDecision(f.lease,id,next.id,{...choice,actionHash:next.action_hash,decision:'reject'});
  f.s.db.exec("UPDATE tasks SET status='waiting_input',control_version=control_version+1");
  assert.equal(f.s.finishWorkerDecision(f.lease,id,next.id,'confirmed'),'expired_after_dispatch');
  assert.equal(f.s.db.prepare('SELECT status FROM tasks').get()!.status,'waiting_input');
});

test('审批响应未知阻断执行；对账要有证据、已退出和当前版本，保留历史尝试', t => {
  const f=fixture(t,'analysis'), id=live(f), a=f.s.requestWorkerApproval(f.lease,id,request);
  const choice={actor:'owner',actionHash:a.action_hash,authorize:() => true};
  assert.throws(() => f.s.dispatchWorkerDecision(f.lease,id,a.id,{...choice,decision:'approve'}));
  f.s.dispatchWorkerDecision(f.lease,id,a.id,{...choice,decision:'reject'});
  assert.equal(f.s.finishWorkerDecision(f.lease,id,a.id,'unknown'),'unknown');
  assert.equal(f.s.claimTask(f.lease,f.task),null);
  const version=Number(f.s.db.prepare('SELECT state_version FROM tasks').get()!.state_version);
  const input={actor:'owner',evidence:'假进程已退出',outcome:'stopped' as const,expectedStateVersion:version,isStopped:() => true};
  for(const bad of [{evidence:' '},{expectedStateVersion:0},{isStopped:() => false}]) {
    assert.throws(() => f.s.reconcileTask(f.lease,f.task,{...input,...bad}));
  }
  assert.equal(f.s.reconcileTask(f.lease,f.task,input).status,'paused');
  assert.equal(f.s.claimTask(f.lease,f.task),null);
  assert.equal(f.s.db.prepare('SELECT status FROM execution_attempts').get()!.status,'unknown');
  assert.throws(() => f.s.finishWorkerDecision(f.lease,id,a.id,'confirmed'));
});

test('重启分类，Worker 与渠道审批独立，旧任务与 Router 保守恢复', t => {
  const f=fixture(t), id=live(f), tool=f.s.requestWorkerApproval(f.lease,id,request);
  const draft=draftFor(f.s,f.task);
  f.s.db.prepare("UPDATE tasks SET status='running' WHERE id=?").run(seed(f.s));
  f.s.db.exec(`INSERT INTO router_sessions(project_id,status,state_version,outcome_unknown,updated_at) VALUES(1,'running',7,0,'now');
    INSERT INTO router_messages(project_id,role,content,data,created_at) VALUES(1,'user','x','{"status":"queued"}','now')`);
  f.s.releaseLease(f.lease);
  const {lease,recovery}=f.s.startController('new');
  assert.equal(recovery.legacy_unknown,1);
  assert.equal(recovery.unknown,1);
  assert.equal(recovery.approvals_expired,1);
  const approval=f.s.db.prepare('SELECT status FROM approvals WHERE id=?');
  assert.equal(approval.get(tool.id)!.status,'expired_on_restart');
  assert.equal(approval.get(draft.approvalId)!.status,'pending');
  assert.throws(() => f.s.dispatchWorkerDecision(lease,id,tool.id,{actor:'a',decision:'approve',actionHash:tool.action_hash,authorize:() => true}));
  assert.equal(f.s.db.prepare('SELECT state_version FROM router_sessions').get()!.state_version,8);
  assert.equal(JSON.parse(String(f.s.db.prepare('SELECT data FROM router_messages').get()!.data)).status,'unknown');
});

test('兼容旧恢复过的审批，按派发证据区分同批过期行，旧版本不改变新任务', t => {
  const f=fixture(t), attempt=live(f);
  const pending=f.s.requestWorkerApproval(f.lease,attempt,request);
  const sent=f.s.requestWorkerApproval(f.lease,attempt,{...request,requestId:8});
  f.s.dispatchWorkerDecision(f.lease,attempt,sent.id,{decision:'reject',actionHash:sent.action_hash,actor:'owner',authorize:()=>true});
  f.s.db.exec("UPDATE approvals SET status='expired_on_restart'; UPDATE tasks SET status='queued',revision=2,control_version=2");
  const task=()=>f.s.db.prepare('SELECT status,outcome_unknown,state_version FROM tasks WHERE id=?').get(f.task);
  const before=task();
  f.s.releaseLease(f.lease);
  const first=f.s.startController('rollback');
  const status=(id:number)=>f.s.db.prepare('SELECT status FROM approvals WHERE id=?').get(id)!.status;
  assert.equal(first.recovery.approvals_unknown,1);
  assert.equal(status(sent.id),'unknown');
  assert.equal(status(pending.id),'expired_on_restart');
  assert.deepEqual(task(),before);
  f.s.releaseLease(first.lease);
  assert.equal(f.s.startController('again').recovery.approvals_unknown,0);
  assert.equal(f.s.db.prepare("SELECT count(*) n FROM events WHERE event_type='approval_response_unknown'").get()!.n,1);
  assert.deepEqual(task(),before);
});

test('无 attempt 的冻结旧库 dispatching 审批也能独立进入人工核验', t => {
  const f=fixture(t);
  f.s.db.prepare(`INSERT INTO approvals(task_id,revision,control_version,action_hash,action,status,created_at)
    VALUES(?,1,1,'legacy',?,'dispatching','2026-11-18')`).run(f.task,JSON.stringify({method:request.method}));
  f.s.releaseLease(f.lease);
  const {lease,recovery}=f.s.startController('handoff');
  assert.equal(recovery.approvals_unknown,1);
  assert.equal(f.s.db.prepare('SELECT status FROM approvals').get()!.status,'unknown');
  const task=f.s.db.prepare('SELECT status,outcome_unknown,state_version FROM tasks').get()!;
  assert.equal(task.status,'waiting_resource');
  assert.equal(task.outcome_unknown,1);
  assert.equal(f.s.claimTask(lease,f.task),null);
  const verified=f.s.reconcileTask(lease,f.task,{actor:'owner',outcome:'abandoned',evidence:'独立核验',
    expectedStateVersion:Number(task.state_version),isStopped:()=>true});
  assert.equal(verified.status,'cancelled');
});

test('两阶段发送逐次核验来源、策略、账号、版本和令牌，成功回放零新发送', t => {
  const f=fixture(t,'reply'), d=draftFor(f.s,f.task);
  const claim=() => f.s.claimDelivery(f.lease,d.draftId,d.actionHash,allow);
  assert.throws(claim);
  assert.throws(() => f.s.decideDraft(d.draftId,'approve','wrong'));
  f.s.decideDraft(d.draftId,'approve',d.actionHash);
  assert.throws(() => f.s.claimDelivery(f.lease,d.draftId,d.actionHash,() => ({allowed:false})));
  const token=claim()!;
  assert.equal(claim(),null);
  assert.throws(() => f.s.markDispatching(f.lease,token,() => ({allowed:true,senderActorId:'other'})));
  assert.throws(() => f.s.markDispatching(f.lease,token,() => ({allowed:false})));
  f.s.db.exec('UPDATE tasks SET control_version=2');
  assert.throws(() => f.s.markDispatching(f.lease,token,allow));
  f.s.db.exec("UPDATE tasks SET control_version=1,status='review_ready'");
  f.s.db.exec("UPDATE events SET data=json_set(data,'$.issue_id','999') WHERE source='redmine'");
  assert.throws(() => f.s.markDispatching(f.lease,token,allow));
  f.s.db.exec("UPDATE events SET data=json_set(data,'$.issue_id','123') WHERE source='redmine'");
  const plan=f.s.markDispatching(f.lease,token,allow);
  assert.equal(plan.target.issue_id,123);
  assert.throws(() => f.s.markDispatching(f.lease,token,allow));
  const result=f.s.finishDelivery(f.lease,token,{write_status:'succeeded',message_id:'receipt',sender_actor_id:'spoof'});
  assert.equal(result.sender_actor_id,'合成账户');
  assert.equal(claim(),null);
  assert.equal(f.s.db.prepare("SELECT count(*) n FROM events WHERE event_type='reply_sent'").get()!.n,1);
});

test('在线扫描仅回收过期 claimed；旧令牌、迟到回执及 v1 unknown 均不能重发', t => {
  const f=fixture(t), d=draftFor(f.s,f.task);
  f.s.decideDraft(d.draftId,'approve',d.actionHash);
  const claim=() => f.s.claimDelivery(f.lease,d.draftId,d.actionHash,allow);
  const old=claim()!;
  const advance=() => {f.tick(10000); f.s.renewLease(f.lease);};
  for(let i=0;i<3;i++) advance();
  assert.throws(() => f.s.markDispatching(f.lease,old,allow));
  assert.equal(f.s.sweepDeliveries(f.lease).claims_expired,1);
  const cur=claim()!;
  assert.notEqual(old.token,cur.token);
  assert.throws(() => f.s.markDispatching(f.lease,old,allow));
  f.s.markDispatching(f.lease,cur,allow);
  for(let i=0;i<11;i++) advance();
  assert.equal(f.s.sweepDeliveries(f.lease).dispatches_unknown,0);
  advance();
  assert.equal(f.s.sweepDeliveries(f.lease).dispatches_unknown,1);
  assert.equal(claim(),null);
  assert.throws(() => f.s.reconcileDelivery(d.draftId,'succeeded',' '));
  assert.equal(f.s.reconcileDelivery(d.draftId,'failed','独立收件核对').write_status,'failed');
  assert.throws(() => f.s.finishDelivery(f.lease,cur,{write_status:'succeeded'}));
  assert.equal(claim(),null);
  f.s.db.prepare('UPDATE delivery_records SET result=?,claim_token=NULL WHERE action_id=?')
    .run(JSON.stringify({write_status:'unknown',reason:'claimed_outcome_pending_reconciliation'}),d.actionId);
  assert.equal(claim(),null);
  assert.equal(f.s.sweepDeliveries(f.lease).claims_expired,0);
});

for (const mode of ['thread','intent','sent']) {
  test('强杀控制器并跨连接恢复 '+mode,{timeout:20000},async () => {
    const dir=mkdtempSync(join(tmpdir(),'进程 验收-')), path=join(dir,'test.db');
    const child=fork(new URL('./process.ts',import.meta.url),[mode,path,dir],{silent:true});
    const exit=once(child,'exit');
    try {
      const [msg]=await once(child,'message');
      child.kill('SIGKILL');
      await exit;
      const s=openStorage(path,{clock:() => Date.now()+60000});
      try {
        const {lease,recovery}=s.startController('takeover');
        assert.equal(lease.epoch,2);
        assert.equal(recovery.abandoned,mode === 'thread' ? 1 : 0);
        assert.equal(recovery.unknown,mode === 'thread' ? 0 : 1);
        assert.equal(recovery.claims_expired,mode === 'sent' ? 0 : 1);
        assert.equal(recovery.dispatches_unknown,mode === 'sent' ? 1 : 0);
        assert.equal(!!s.claimTask(lease,msg.task), mode === 'thread');
        const received=join(dir,'独立收件.txt');
        if(mode === 'sent') {
          assert.equal(readFileSync(received,'utf8'),msg.claim.actionId+'\n');
          assert.equal(s.claimDelivery(lease,msg.draft.draftId,msg.draft.actionHash,allow),null);
          s.reconcileDelivery(msg.draft.draftId,'succeeded','已读取独立收件');
          assert.throws(() => s.finishDelivery(lease,msg.claim,{write_status:'failed'}));
        } else assert.equal(existsSync(received),false);
      } finally {s.close();}
    } finally { if(child.exitCode === null && child.signalCode === null) { child.kill(); await exit; } rmSync(dir,{recursive:true,force:true}); }
  });
}
