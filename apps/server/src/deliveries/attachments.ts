import type { FastifyInstance } from 'fastify';
import type { Lease, Storage } from '../../../../packages/storage/index.ts';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { Attachment } from '../../../../packages/channels/resources.ts';
import { directory, discard } from '../../../../packages/channels/resources.ts';
import { Redmine } from '../../../../packages/channels/redmine.ts';
import { downloadDws } from '../../../../packages/channels/dingtalk.ts';
import { admin, audit, owned, serialize, tx, utc, type Row } from '../sql.js';
import { ChannelError } from '../../../../packages/channels/common.ts';
import { fail } from '../auth.js';
import { background,checkController } from './background.ts';

const attachmentFailures = {
  disabled: '当前渠道或本机下载已停用，启用后可重试',
  no_source: '缺少可定位的原工单附件或原消息，请核对来源后重试',
};
type SourceFailure = keyof typeof attachmentFailures;
const positiveId=z.union([z.number(),z.string().regex(/^\d+$/)]).transform(Number).pipe(z.int().positive());
const redmineAttachments=z.array(z.object({id:positiveId})).min(1).max(10);

export function registerAttachments(app:FastifyInstance,store:Storage,lease:Lease,root:string,env:NodeJS.ProcessEnv,
  configFor:(name:'redmine'|'dingtalk')=>any,available:(name:'redmine'|'dingtalk')=>boolean) {
  const db=store.db,base=env.SUPERAGENT_ATTACHMENTS_ROOT??join(root,'attachments');
  const jobSql=`SELECT j.*,e.source,e.data,p.redmine_project_ids,t.project_id,t.revision current_revision,t.control_version current_control,
    p.enabled,p.archived,t.outcome_unknown,t.status task_status,
    (SELECT MAX(id) FROM events WHERE task_id=j.task_id AND event_type IN ('goal_changed','project_rebound')) scope_change
    FROM event_attachment_jobs j LEFT JOIN events e ON e.id=j.event_id AND e.task_id=j.task_id
    LEFT JOIN tasks t ON t.id=j.task_id LEFT JOIN projects p ON p.id=t.project_id`;
  function sourceFailure(job:Row):SourceFailure|null {
    const name=job.source;
    if((name!=='redmine' && name!=='dingtalk') || !job.data || job.current_revision==null || job.enabled==null) return 'no_source';
    const data=JSON.parse(String(job.data));
    const text=(v:unknown)=>typeof v==='string' && !!v.trim();
    const hasSource=name==='redmine'
      ? positiveId.safeParse(data?.issue_id).success && text(data.metadata?.redmine_endpoint) && redmineAttachments.safeParse(data.attachments).success
      : text(data?.thread_id) && text(data.metadata?.message_id) && text(data.metadata?.profile);
    if(!hasSource) return 'no_source';
    return !available(name) || configFor(name)?.enabled!==true ? 'disabled' : null;
  }
  function settle(job:Row,results:Attachment[],error:string|null,code:string|null=null,from:'pending'|'processing'='processing') {
    const {task_id:task,event_id:id,revision,control_version:control}=job,now=utc();
    const status=error?'failed':'completed';
    if(!db.prepare("UPDATE event_attachment_jobs SET status=?,results=? WHERE event_id=? AND revision=? AND control_version=? AND status=?")
      .run(status,JSON.stringify(results),id,revision,control,from).changes) return;
    db.prepare(`UPDATE events SET data=json_patch(json_set(data,'$.attachments_status',?,'$.attachments_error',?),
      json_object('attachments_error_code',?)) WHERE id=? AND task_id=?`).run(status,error,code,id,task);
    if(!error){
      const add=db.prepare("INSERT INTO artifacts(task_id,revision,kind,content,created_at) VALUES(?,?,'source_attachment',?,?)");
      for(const r of results)add.run(task,revision,JSON.stringify(r),now);
      db.prepare("INSERT INTO events(task_id,event_type,source,data,content,created_at) VALUES(?,'message','runtime',?,?,?)")
        .run(task,JSON.stringify({source_event_id:id,attachments:results}),'来源附件已核验。\n'+results.map(r=>r.local_path).join('\n'),now);
    }
    const siblings=db.prepare(`SELECT status FROM event_attachment_jobs WHERE task_id=? AND event_id >
      COALESCE((SELECT MAX(id) FROM events WHERE task_id=? AND event_type='project_rebound'),0)`).all(task,task);
    if(siblings.some(s=>['pending','processing'].includes(String(s.status)))) return;
    const failed=siblings.some(s=>s.status==='failed');
    db.prepare(`UPDATE tasks SET status=?,last_error=?,state_version=state_version+1,updated_at=? WHERE id=? AND revision=? AND control_version=?
      AND status='waiting_resource' AND last_error='正在准备来源附件'`).run(failed?'waiting_input':'queued',failed?'附件获取或校验失败，请核验来源后重试':null,now,task,revision,control);
  }
  app.addHook('onReady',async()=>{
    tx(db,()=>{
      checkController(store,lease,new AbortController().signal);
      for(const job of db.prepare("SELECT * FROM event_attachment_jobs WHERE status='processing'").all()) settle(job,[],'服务重启，附件结果未知，请核验后重试');
      for(const job of db.prepare(jobSql+" WHERE j.status='pending'").all()){
        const code=sourceFailure(job);
        if(code) settle(job,[],attachmentFailures[code],code,'pending');
      }
    });
  });
  background(app,'channel-attachments',async signal=>{
    checkController(store,lease,signal);
    const job=tx<Row|undefined>(db,()=>{
      const next=db.prepare(jobSql+` WHERE j.status='pending'
        AND j.event_id>COALESCE((SELECT MAX(id) FROM events WHERE task_id=t.id AND event_type='project_rebound'),0)
        AND t.last_error IS NOT '正在停止执行' AND NOT t.outcome_unknown
        AND t.status IN ('queued','waiting_resource','waiting_input','review_ready','failed')
        ORDER BY j.event_id LIMIT 1`).get();
      if(!next) return;
      db.prepare("UPDATE event_attachment_jobs SET revision=?,control_version=? WHERE event_id=?")
        .run(next.current_revision,next.current_control,next.event_id);
      return {...next,revision:next.current_revision,control_version:next.current_control};
    });
    if(!job) return;
    const id=Number(job.event_id),task=Number(job.task_id),name=job.source;
    const code=sourceFailure(job);
    if(code){tx(db,()=>settle(job,[],attachmentFailures[code],code,'pending'));return;}
    if(!db.prepare("UPDATE event_attachment_jobs SET status='processing' WHERE event_id=? AND status='pending'").run(id).changes) return;
    let batchDir='',parent='',retained=false;
    try{
      if(name!=='redmine'&&name!=='dingtalk') throw new Error();
      const cfg=configFor(name),snapshot=JSON.stringify(cfg);
      const recheck=()=>{
        checkController(store,lease,signal);
        const fresh=db.prepare(jobSql+' WHERE j.event_id=?').get(id);
        if(!fresh || fresh.status!=='processing'||!fresh.enabled || fresh.archived || fresh.outcome_unknown ||
          ['running','waiting_approval','cancelled','completed'].includes(String(fresh.task_status)) ||
          fresh.current_revision!==job.revision || fresh.current_control!==job.control_version ||
          fresh.project_id!==job.project_id || fresh.redmine_project_ids!==job.redmine_project_ids || fresh.data!==job.data ||
          !available(name as 'redmine'|'dingtalk') || !cfg?.enabled || JSON.stringify(configFor(name as 'redmine'|'dingtalk'))!==snapshot) throw new Error();
      }
      recheck();
      const data=JSON.parse(String(job.data)),m=data.metadata??{};
      parent=await directory(join(base,String(task),String(id)));
      batchDir=await mkdtemp(join(parent,'batch-'));
      const bounded=AbortSignal.any([signal,AbortSignal.timeout(45000)]);
      let results:Attachment[];
      if(name==='redmine'){
        const client=new Redmine(cfg,env[cfg.api_key_env??'HLZJ_REDMINE_API_KEY']??'');
        if(m.redmine_endpoint!==client.base || (m.external_user_id!=null && String(m.external_user_id)!==String(cfg.user_id))) throw new Error();
        const requested=redmineAttachments.parse(data.attachments);
        results=await client.attachments(Number(data.issue_id),requested.map(i=>i.id),JSON.parse(String(job.redmine_project_ids)).map(Number),batchDir,bounded);
      } else {
        if(cfg.profile!==m.profile || !Array.isArray(cfg.self_ids) || (m.source_account_ids &&
          JSON.stringify(m.source_account_ids)!==JSON.stringify([...new Set(cfg.self_ids)].sort()))) throw new Error();
        results=await downloadDws(cfg,data.thread_id,m.message_id,batchDir,env,bounded);
      }
      tx(db,()=>{recheck();settle(job,results,null);retained=true;});
    }catch(error){
      if(!signal.aborted) tx(db,()=>{
        checkController(store,lease,signal);
        const current=db.prepare(jobSql+' WHERE j.event_id=?').get(id);
        if(current && current.scope_change===job.scope_change &&
          (current.current_revision!==job.revision || current.current_control!==job.control_version)) {
          db.prepare("UPDATE event_attachment_jobs SET status='pending' WHERE event_id=? AND status='processing'").run(id);
          return;
        }
        const code=current?sourceFailure(current):null;
        const diagnostic=error instanceof ChannelError && /^[a-z0-9_]{1,80}$/.test(error.message)?error.message:'attachment_read_failed';
        settle(job,[],code?attachmentFailures[code]:'附件获取或校验失败（'+diagnostic+'），请核对来源后重试',code??diagnostic);
      });
    }finally{if(batchDir && !retained) await discard(parent,batchDir);}
  });
  app.post('/api/v1/events/:id/retry-attachments',async req=>{
    admin(req.principal);
    const {id}=z.object({id:z.coerce.number().int().positive()}).parse(req.params);
    return tx(db,()=>{
      checkController(store,lease,new AbortController().signal);
      const j=db.prepare(jobSql+' WHERE j.event_id=?').get(id);
      if(!j?.data || j.current_revision==null || j.status!=='failed' || j.outcome_unknown || ['running','waiting_approval','completed','cancelled'].includes(String(j.task_status))) return fail(409,'附件状态不支持重试');
      const code=sourceFailure(j);
      const receipt=(duplicate:boolean)=>({...serialize(db.prepare('SELECT * FROM events WHERE id=?').get(id)!),duplicate});
      if(code && j.revision===j.current_revision && j.control_version===j.current_control &&
        JSON.parse(String(j.data)).attachments_error_code===code) return receipt(true);
      db.prepare("UPDATE event_attachment_jobs SET revision=?,control_version=?,status='pending',results='[]' WHERE event_id=?").run(j.current_revision,j.current_control,id);
      db.prepare("UPDATE events SET data=json_remove(json_set(data,'$.attachments_status','pending','$.attachments_error',null),'$.attachments_error_code') WHERE id=?").run(id);
      db.prepare("UPDATE tasks SET status='waiting_resource',last_error='正在准备来源附件',state_version=state_version+1,updated_at=? WHERE id=? AND status IN ('queued','waiting_input')").run(utc(),j.task_id);
      audit(db,req.principal.user_id,'event.retry_attachments',id,{task_id:j.task_id});
      if(code) settle({...j,revision:j.current_revision,control_version:j.current_control},[],attachmentFailures[code],code,'pending');
      return receipt(false);
    });
  });
  app.post('/api/v1/tasks/:id/retry-attachments',async req=>{
    const {id}=z.object({id:z.coerce.number().int().positive()}).parse(req.params);
    const {expected_state_version}=z.strictObject({expected_state_version:z.int().positive()}).parse(req.body);
    return tx(db,()=>{
      checkController(store,lease,new AbortController().signal);
      const task=owned(db,id,req.principal);
      if(task.state_version!==expected_state_version || task.outcome_unknown || !['waiting_input','waiting_resource'].includes(String(task.status))
        || (task.status==='waiting_resource' && task.last_error!=='正在准备来源附件')) fail(409,'任务状态已变化或附件不可重试');
      const jobs=db.prepare(jobSql+` WHERE j.task_id=? AND j.status='failed' AND j.event_id>
        COALESCE((SELECT MAX(id) FROM events WHERE task_id=? AND event_type='project_rebound'),0)`).all(id,id);
      if(!jobs.length || jobs.some(j=>sourceFailure(j))) fail(409,'附件来源或渠道未就绪');
      for(const j of jobs) {
        db.prepare("UPDATE event_attachment_jobs SET revision=?,control_version=?,status='pending',results='[]' WHERE event_id=?")
          .run(task.revision,task.control_version,j.event_id);
        db.prepare("UPDATE events SET data=json_remove(json_set(data,'$.attachments_status','pending'),'$.attachments_error','$.attachments_error_code') WHERE id=?")
          .run(j.event_id);
      }
      db.prepare("UPDATE tasks SET status='waiting_resource',last_error='正在准备来源附件',state_version=state_version+1,updated_at=? WHERE id=?").run(utc(),id);
      audit(db,req.principal.user_id,'task.retry_attachments',id,{event_ids:jobs.map(j=>j.event_id)});
      return {status:'pending',count:jobs.length};
    });
  });
}
