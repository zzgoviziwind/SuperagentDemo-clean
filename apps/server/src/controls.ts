import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { fail, type Principal } from './auth.js';
import { audit, owned, record, serialize, tx, utc } from './sql.js';

export interface WorkerControl {
  stop(taskId:number):Promise<boolean>;
  steer?(taskId:number,content:string):Promise<boolean>;
  isActive?(taskId:number):boolean;
  canRunReply?():boolean;
}
const legacyEngineErrors = new Set([
  '本机回复引擎配置无效，请在 Agent 页面检查连接', '未配置本机回复引擎',
  '本机 Codex 的执行配置不可用。请到「管理设置 → 本机 Agent」重新连接。',
  '尚未连接本机 Codex。请到「管理设置 → 本机 Agent」连接。',
]);
const transition:Record<string,Record<string,string>>={
  start:{queued:'queued'},pause:{queued:'paused',waiting_resource:'paused',waiting_input:'paused',running:'waiting_resource',waiting_approval:'waiting_resource'},
  resume:{paused:'queued',waiting_input:'queued',cancelled:'queued'},retry:{failed:'queued'},
  cancel:{queued:'cancelled',paused:'cancelled',waiting_input:'cancelled',waiting_resource:'cancelled',running:'waiting_resource',waiting_approval:'waiting_resource',review_ready:'cancelled',failed:'cancelled',completed:'cancelled'},
};
const version=z.int().positive().nullable().optional();
const param=z.object({id:z.coerce.number().int().positive()});
function checkTask(db:DatabaseSync,id:number,p:Principal,expected:number|null|undefined) {
  const t=owned(db,id,p);
  if(expected!=null && expected!==t.state_version) fail(409,'状态已变化，请刷新');
  if(t.outcome_unknown || t.last_error==='正在停止执行' || (t.status==='waiting_resource' && /未知|对账/.test(String(t.last_error)))) fail(409,'请先核验执行状态');
  return t;
}
const active=(state:unknown)=>state==='running'||state==='waiting_approval';
export async function stopFenced(db:DatabaseSync,id:number,controlVersion:number,target:string,worker?:WorkerControl) {
  let stopped=false;
  try { stopped=await worker?.stop(id)??false; } catch { /* no confirmation */ }
  tx(db,()=>{
    const task=db.prepare('SELECT control_version,revision,last_error FROM tasks WHERE id=?').get(id);
    if(task?.control_version!==controlVersion || task.last_error!=='正在停止执行') return;
    const now=utc();
    let next=stopped?target:'waiting_resource';
    let error=stopped?null:'执行退出结果未知，请核验';
    if(next==='queued') {
      const jobs=db.prepare('SELECT status FROM event_attachment_jobs WHERE task_id=? AND revision=? AND control_version=?').all(id,task.revision,task.control_version);
      if(jobs.some(j=>j.status==='failed')) { next='waiting_input';error='附件获取或校验失败，请核验来源后重试'; }
      else if(jobs.some(j=>j.status==='pending'||j.status==='processing')) { next='waiting_resource';error='正在准备来源附件'; }
    }
    db.prepare('UPDATE tasks SET status=?,last_error=?,outcome_unknown=?,updated_at=?,state_version=state_version+1 WHERE id=?').run(
      next,error,Number(!stopped),now,id);
    db.prepare("UPDATE execution_attempts SET status=?,ended_at=?,updated_at=? WHERE task_id=? AND control_version<? AND status IN ('running','waiting_approval','claimed')")
      .run(stopped?'abandoned':'unknown',now,now,id,controlVersion);
    record(db,id,stopped?'stop_confirmed':'stop_unknown','',{target,control_version:controlVersion});
  });
}
export function registerControls(app:FastifyInstance,db:DatabaseSync,worker?:WorkerControl) {
  app.post('/api/v1/tasks/:id/controls',async req=>{
    const {id}=param.parse(req.params);
    const {action,expected_state_version}=z.strictObject({action:z.string(),expected_state_version:version}).parse(req.body);
    const result=tx(db,()=>{
      const t=checkTask(db,id,req.principal,expected_state_version);
      const analyze=action==='analyze' && t.kind==='reply' && ['paused','waiting_input','review_ready','completed','cancelled','failed'].includes(String(t.status));
      const recoverEngine = action==='resume' && t.kind==='reply' && t.status==='waiting_resource' && legacyEngineErrors.has(String(t.last_error));
      const transitions=Object.hasOwn(transition,action)?transition[action]:undefined;
      const state=analyze || recoverEngine?'queued':transitions && Object.hasOwn(transitions,String(t.status))?transitions[String(t.status)]:undefined;
      if(!state) fail(409,'当前状态不支持此操作');
      if((recoverEngine || analyze || t.status==='cancelled') && worker?.isActive?.(id)) fail(409,'执行尚未退出，请稍后继续');
      if(recoverEngine && !worker?.canRunReply?.()) fail(409,'请启用自动调度并连接本机回复引擎后重试');
      const newRevision=Number(t.status==='cancelled'||analyze);
      const stop=active(t.status) && (action==='cancel'||action==='pause');
      db.prepare('UPDATE tasks SET status=?,revision=revision+?,control_version=control_version+1,state_version=state_version+1,updated_at=?,last_error=?,kind=?,codex_thread_id=?,codex_turn_id=? WHERE id=?')
        .run(state,newRevision,utc(),stop?'正在停止执行':null,analyze?'analysis':t.kind,analyze?null:t.codex_thread_id,analyze?null:t.codex_turn_id,id);
      db.prepare("UPDATE approvals SET status='expired' WHERE task_id=? AND status='pending'").run(id);
      record(db,id,'control',action);
      audit(db,req.principal.user_id,'task.'+action,id,{status:state,control_version:Number(t.control_version)+1});
      return {stop,version:Number(t.control_version)+1};
    });
    if(result.stop) await stopFenced(db,id,result.version,action==='cancel'?'cancelled':'paused',worker);
    return serialize(owned(db,id,req.principal));
  });
  app.post('/api/v1/tasks/:id/messages',async req=>{
    const {id}=param.parse(req.params);
    const {content,change_goal,expected_state_version}=z.strictObject({content:z.string().min(1).max(100000).refine(s=>!!s.trim()),
      change_goal:z.boolean().default(false),expected_state_version:version}).parse(req.body);
    const result=tx(db,()=>{
      const t=checkTask(db,id,req.principal,expected_state_version);
      if(['completed','cancelled'].includes(String(t.status))) fail(409,'终态任务请另建任务');
      const changed=change_goal || t.status==='review_ready';
      const stop=change_goal && active(t.status);
      const state=stop?'waiting_resource':changed && t.status==='review_ready'?'waiting_input':t.status;
      const error=stop?'正在停止执行':!change_goal && changed?'收到新补充，请继续执行后重新验收':t.last_error;
      db.prepare('UPDATE tasks SET goal=?,revision=revision+?,control_version=control_version+?,state_version=state_version+1,status=?,last_error=?,updated_at=? WHERE id=?')
        .run(change_goal?content:t.goal,Number(changed),Number(changed),state,error,utc(),id);
      if(changed) db.prepare("UPDATE approvals SET status='expired' WHERE task_id=? AND status='pending'").run(id);
      const event=record(db,id,change_goal?'goal_changed':'message',content,{actor:req.principal.user_id});
      audit(db,req.principal.user_id,'task.message',id,{revision:Number(t.revision)+Number(changed),state_version:Number(t.state_version)+1});
      return {event,stop,steer:!changed && active(t.status),version:Number(t.control_version)+Number(changed)};
    });
    if(result.stop) await stopFenced(db,id,result.version,'waiting_input',worker);
    if(result.steer && !await worker?.steer?.(id,content).catch(()=>false)) {
      // Fence the possibly running process before returning the persisted message.
      const fenced=tx(db,()=>db.prepare("UPDATE tasks SET status='waiting_resource',state_version=state_version+1,control_version=control_version+1,last_error='正在停止执行',updated_at=? WHERE id=? AND control_version=? AND status IN ('running','waiting_approval')")
        .run(utc(),id,result.version).changes);
      if(fenced) await stopFenced(db,id,result.version+1,'waiting_input',worker);
    }
    return serialize(result.event);
  });
}
