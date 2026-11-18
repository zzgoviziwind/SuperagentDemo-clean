import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { fail, type Principal } from './auth.js';
import { admin, audit, owned, serialize, tx, utc, type Row } from './sql.js';
import type { Fields } from '../../../packages/storage/src/index.ts';

const ident=z.int().positive(), routeId=z.object({id:z.coerce.number().int().positive()});
const decision=z.strictObject({project_id:ident,task_id:ident.nullish(),event_id:ident.nullish(),
  kind:z.enum(['decision','constraint','accepted','note']),content:z.string().trim().min(1).max(10000)});
const query=z.object({project_id:z.coerce.number().int().positive().optional(),task_id:z.coerce.number().int().positive().optional(),
  status:z.enum(['active','revoked','superseded']).default('active'),after:z.coerce.number().int().min(0).default(0),
  limit:z.coerce.number().int().min(1).max(200).default(100)});
function redact(value:string) {
  return value.trim().replace(/-----BEGIN [^\r\n-]*PRIVATE KEY-----[\s\S]*?-----END [^\r\n-]*PRIVATE KEY-----/g,'[已脱敏]')
    .replace(/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi,'$1 [已脱敏]')
    .replace(/\b((?:[\w-]+[_-])?(?:api[_-]?key|password|passwd|secret|token|x-redmine-api-key))(["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi,'$1$2[已脱敏]')
    .replace(/\b(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi,'$1[已脱敏]@');
}
const effectiveOwner="COALESCE(NULLIF(t.owner_id,'local-admin'),(SELECT o.user_id FROM governance_task_owners o WHERE o.task_id=t.id),t.owner_id)";
function timeline(db:DatabaseSync,t:Row) {
  // A target may subscribe to another task's event. Validate both sides of the link.
  const owner=db.prepare('SELECT '+effectiveOwner+' AS owner FROM tasks t WHERE t.id=?').get(t.id)!.owner;
  return db.prepare(`SELECT e.* FROM events e LEFT JOIN tasks t ON t.id=e.task_id WHERE
    (e.task_id=? OR EXISTS(SELECT 1 FROM event_targets et WHERE et.event_id=e.id AND et.task_id=?))
    AND (e.task_id IS NULL OR (t.project_id=? AND `+effectiveOwner+`=?))
    AND e.id >= COALESCE((SELECT MAX(id) FROM events WHERE task_id=? AND event_type='project_rebound'),0)
    AND NOT(e.source IN ('dingtalk','redmine') AND json_extract(e.data,'$.source_event_id') IS NOT NULL)
    AND ((e.external_id IS NOT NULL AND e.source IN ('dingtalk','redmine','field'))
      OR (e.source IN ('web','coordination') AND e.event_type IN ('created','message','goal_changed','collaboration_result','project_rebound')))
    ORDER BY COALESCE(julianday(json_extract(e.data,'$.occurred_at')),julianday(e.created_at)),e.id`).all(t.id,t.id,t.project_id,owner,t.id);
}
const projectDecisions=(db:DatabaseSync,t:Row,status:string,events:Set<number>)=>db.prepare(
  'SELECT * FROM decisions WHERE project_id=? AND (task_id IS NULL OR task_id=?) AND status=? ORDER BY id')
  .all(t.project_id,t.id,status).filter(d=>d.event_id===null||events.has(Number(d.event_id)));
const idsOf=(rows:Row[])=>new Set(rows.map(e=>Number(e.id)));
function audience(history:Row[]) {
  const identities=new Set<string>();
  for(const event of history) {
    if(event.source!=='dingtalk' && event.source!=='redmine') continue;
    const data=JSON.parse(String(event.data));
    if(data.thread_id && data.actor_id && !data.metadata?.self_authored)
      identities.add(JSON.stringify([event.source,data.thread_id,data.metadata?.profile??null,data.actor_id]));
  }
  return JSON.stringify([...identities].sort());
}
function summaryAllowed(db:DatabaseSync,summary:Row,decisions:Set<number>) {
  const refs=db.prepare(`SELECT DISTINCT json_extract(data,'$.manifest_id') id FROM events
    WHERE task_id=? AND event_type='assistant_message' AND source='runtime'
    AND json_extract(data,'$.artifact_id')=? AND json_extract(data,'$.manifest_id') IS NOT NULL`).all(summary.task_id,summary.id);
  const manifests=db.prepare('SELECT id,items FROM context_manifests WHERE task_id=? AND (attempt_id=? OR id IN (SELECT value FROM json_each(?)))')
    .all(summary.task_id,summary.attempt_id,JSON.stringify(refs.map(r=>r.id)));
  if(refs.some(r=>!manifests.some(m=>m.id===r.id))) return false;
  return manifests.every(m=>{
    const entries=z.array(z.object({type:z.string(),id:z.union([z.string(),z.number()]),included:z.boolean()})).safeParse(JSON.parse(String(m.items)));
    return entries.success && entries.data.every(i=>i.type!=='decision'||!i.included||decisions.has(Number(i.id)));
  });
}
export function assembleContext(db:DatabaseSync,taskId:number) {
  const task=db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId)??fail(404,'任务不存在');
  const history=timeline(db,task);
  const decisions=projectDecisions(db,task,'active',idsOf(history)).sort((a,b)=>Number(b.kind==='constraint')-Number(a.kind==='constraint')||Number(a.id)-Number(b.id));
  const items:Fields[]=[];
  const selected:Fields[]=[];
  const activeIds=idsOf(decisions);
  let remaining=79990,decisionBudget=16000;
  function take(type:string,row:Row,source:string,limit:number,eligible:boolean,metadata:Fields) {
    const text=redact(String(row.content));
    const characters=Array.from(text);
    const allowance=type==='decision'?Math.min(remaining,decisionBudget):remaining;
    let low=0,high=Math.min(limit,characters.length),best:Fields|undefined,cost=0;
    while(eligible && low<=high) {
      const count=Math.floor((low+high)/2),candidate={...metadata,content:characters.slice(0,count).join('')};
      const size=JSON.stringify(candidate).length+2;
      if(size<=allowance) {best=candidate;cost=size;low=count+1;} else high=count-1;
    }
    if(best) {selected.push(best);remaining-=cost;if(type==='decision')decisionBudget-=cost;}
    items.push({type,id:Number(row.id),source,chars:characters.length,included:!!best,truncated:!best||best.content!==text});
  }
  for(const d of decisions) take('decision',d,d.task_id===null?'project':'task',1000,true,{id:Number(d.id),kind:String(d.kind),...(d.event_id?{event_id:Number(d.event_id)}:{})});
  const timelineStart=selected.length;
  [...history].reverse().forEach((e,i)=>{
    const data=JSON.parse(String(e.data));
    take('timeline',e,String(e.source),3000,i<(task.kind==='reply'?16:24),{event_id:Number(e.id),source:String(e.source),
      time:String(data.occurred_at??e.created_at),sender:String(data.metadata?.sender_name??data.actor_id??data.actor??'operator'),
      sender_id:data.actor_id??data.actor??null,direction:data.metadata?.self_authored?'own_account':e.external_id?'received':'local'});
  });
  selected.push(...selected.splice(timelineStart).reverse());
  const recipients=audience(history);
  const external=task.source==='dingtalk'||task.source==='redmine';
  if((!external||recipients!=='[]') && !(task.kind==='reply' && String(task.goal).includes('先确认项目归属。原始消息如下'))) {
    const candidates=db.prepare('SELECT t.* FROM tasks t WHERE t.project_id=? AND t.id!=? AND NOT t.outcome_unknown AND '+effectiveOwner+
      '=(SELECT '+effectiveOwner+' FROM tasks t WHERE t.id=?) ORDER BY t.updated_at DESC,t.id DESC LIMIT 12').all(task.project_id,taskId,taskId);
    let count=0;
    for(const candidate of candidates) {
      if(audience(timeline(db,candidate))!==recipients) continue;
      if(recipients!=='[]' && db.prepare("SELECT 1 FROM events WHERE task_id=? AND source='field' LIMIT 1").get(candidate.id)) continue;
      const summary=db.prepare("SELECT * FROM artifacts WHERE task_id=? AND revision=? AND kind='summary' ORDER BY id DESC LIMIT 1").get(candidate.id,candidate.revision);
      take('recent_work',{id:candidate.id,content:summary?.content??''},'task',1500,!summary||summaryAllowed(db,summary,activeIds),
        {task_id:Number(candidate.id),title:redact(String(candidate.title)),status:String(candidate.status),updated_at:String(candidate.updated_at)});
      if(++count===4) break;
    }
  }
  const previous=db.prepare(`SELECT a.* FROM artifacts a WHERE a.task_id=? AND a.kind='summary' AND
    a.revision>=COALESCE((SELECT json_extract(data,'$.revision') FROM events WHERE task_id=? AND event_type='project_rebound' ORDER BY id DESC LIMIT 1),1)
    ORDER BY a.id DESC LIMIT 1`).get(taskId,taskId);
  if(previous) {
    take('previous_summary',previous,'artifact',task.kind==='reply'?2500:3000,summaryAllowed(db,previous,activeIds),{artifact_id:Number(previous.id)});
  }
  return {items,prompt:JSON.stringify(selected)};
}
export function registerContext(app:FastifyInstance,db:DatabaseSync) {
  function list(p:Principal,input:unknown) {
    const q=query.parse(input);
    if(q.task_id) {
      const t=owned(db,q.task_id,p);
      if(q.project_id && q.project_id!==t.project_id) fail(404,'当前项目内没有该任务');
      return {items:projectDecisions(db,t,q.status,idsOf(timeline(db,t))).filter(d=>Number(d.id)>q.after).slice(0,q.limit)};
    }
    admin(p);
    return {items:db.prepare('SELECT * FROM decisions WHERE id>? AND status=? AND (? IS NULL OR project_id=?) ORDER BY id LIMIT ?').all(q.after,q.status,q.project_id??null,q.project_id??null,q.limit)};
  }
  app.get('/api/v1/decisions',async req=>list(req.principal,req.query));
  app.get('/api/v1/tasks/:id/decisions',async req=>list(req.principal,{...query.parse(req.query),task_id:routeId.parse(req.params).id}));
  app.post('/api/v1/decisions',async(req,res)=>{
    const d=decision.parse(req.body);
    const row=tx(db,()=>{
      const t=d.task_id?owned(db,d.task_id,req.principal):undefined;
      if(!t) admin(req.principal);
      if((t && t.project_id!==d.project_id)||!db.prepare('SELECT id FROM projects WHERE enabled AND NOT archived AND id=?').get(d.project_id)) fail(404,'项目不可用');
      if(d.event_id) {
        const tasks=t?[t]:db.prepare('SELECT * FROM tasks WHERE project_id=?').all(d.project_id);
        if(!tasks.some(x=>timeline(db,x).some(e=>e.id===d.event_id))) fail(404,'当前范围内没有该来源事件');
      }
      const result=db.prepare("INSERT INTO decisions(project_id,task_id,event_id,kind,content,status,revision,actor,created_at) VALUES(?,?,?,?,?,'active',?,?,?) RETURNING *")
        .get(d.project_id,d.task_id??null,d.event_id??null,d.kind,redact(d.content),t?.revision??null,req.principal.user_id,utc())!;
      audit(db,req.principal.user_id,'context.decision.create',Number(result.id),{task_id:result.task_id,revision:result.revision,status:result.status});
      return result;
    });
    return res.code(201).send(row);
  });
  app.post('/api/v1/decisions/:id/revoke',async req=>{
    const {id}=routeId.parse(req.params),{reason}=z.strictObject({reason:z.string().trim().min(1).max(1000)}).parse(req.body);
    return tx(db,()=>{
      const row=db.prepare('SELECT * FROM decisions WHERE id=?').get(id)??fail(404,'找不到决定');
      if(req.principal.role!=='admin') {
        if(row.task_id===null) fail(403,'仅管理员可撤销项目决定');
        const t=owned(db,Number(row.task_id),req.principal);
        if(t.project_id!==row.project_id || (row.event_id!==null && !idsOf(timeline(db,t)).has(Number(row.event_id)))) fail(404,'当前任务内没有该决定');
      }
      if(row.status==='revoked') return row;
      if(row.status!=='active') fail(409,'该决定已被替代');
      audit(db,req.principal.user_id,'context.decision.revoke',id,{task_id:row.task_id,revision:row.revision,status:'revoked'});
      return db.prepare("UPDATE decisions SET status='revoked',revoked_at=?,revoked_by=?,revocation_reason=? WHERE id=? RETURNING *").get(utc(),req.principal.user_id,redact(reason),id);
    });
  });
  app.get('/api/v1/tasks/:id/context',async req=>{
    const t=owned(db,routeId.parse(req.params).id,req.principal);
    const {limit}=z.object({limit:z.coerce.number().int().min(1).max(100).default(30)}).parse(req.query);
    const rows=db.prepare("SELECT * FROM context_manifests WHERE task_id=? AND (?='admin' OR project_id=?) ORDER BY id DESC LIMIT ?").all(t.id,req.principal.role,t.project_id,limit);
    return {items:rows.map(r=>({...r,items:JSON.parse(String(r.items))}))};
  });
  app.get('/api/v1/attempts/:id/context',async req=>{
    const {id}=z.object({id:z.string().min(1).max(64)}).parse(req.params);
    const row=db.prepare('SELECT m.* FROM execution_attempts a JOIN context_manifests m ON m.id=a.manifest_id AND m.attempt_id=a.id AND m.task_id=a.task_id WHERE a.id=?').get(id)??fail(404,'找不到上下文清单');
    const t=owned(db,Number(row.task_id),req.principal);
    if(req.principal.role!=='admin' && t.project_id!==row.project_id) fail(404,'找不到上下文清单');
    return {...row,items:JSON.parse(String(row.items))};
  });
  app.get('/api/v1/operations/tasks/:id/attempts',async req=>{
    const t=owned(db,routeId.parse(req.params).id,req.principal);
    return {items:db.prepare('SELECT * FROM execution_attempts WHERE task_id=? ORDER BY attempt_no').all(t.id).map(r=>({...serialize(r),base_sha:r.base_sha===null?null:JSON.parse(String(r.base_sha))}))};
  });
}
