import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { fail, roleOf } from './auth.js';
import type { Row } from './sql.js';

const projectId=z.int().positive(), ids=z.array(projectId).max(100);
export const accessSchema=z.strictObject({
  mode:z.enum(['mapped','all','selected','off']).default('mapped'),owner_user_id:z.string().trim().min(1).max(200).default('admin'),
  project_ids:ids.refine(v=>new Set(v).size===v.length).default([]),
  people:z.array(z.strictObject({actor_id:z.string().min(1).max(255),name:z.string().max(100).default(''),reply:z.boolean().default(true),
    project_ids:ids.default([])})).max(500).default([]),
  project_hints:z.array(z.strictObject({project_id:projectId,keywords:z.array(z.string().min(1).max(255)).max(30).default([])})).max(100).default([]),
  group_names:z.record(z.string().max(255),z.string().max(200)).default({}),
  on_unmatched:z.enum(['pending','ask','default']).default('pending'),default_project_id:projectId.nullable().default(null)
}).refine(v=>v.on_unmatched==='pending'||v.default_project_id!==null);
type Access=z.infer<typeof accessSchema>;
export function validateAccess(db:DatabaseSync,env:NodeJS.ProcessEnv,value:Access) {
  if(!['member','admin'].includes(roleOf(env,value.owner_user_id)??'')) fail(422,'请选择可处理请求的负责人');
  const ids=new Set([...value.project_ids,...value.project_hints.map(h=>h.project_id),...value.people.flatMap(p=>p.project_ids)]);
  if(value.default_project_id) ids.add(value.default_project_id);
  for(const id of ids) if(!db.prepare('SELECT id FROM projects WHERE id=? AND enabled AND NOT archived').get(id)) fail(422,'请选择有效的启用项目');
}
type Source={source:string;actor_id?:string;thread_id?:string;content:string;metadata:Record<string,unknown>};
export function admission(db:DatabaseSync,e:Source,access:Access|null) {
  const person=access?.people.find(p=>p.actor_id===e.actor_id);
  if(access && (access.mode==='off' || person?.reply===false || (access.mode==='selected'&&!person))) return {};
  if(!access || access.mode==='mapped') {
    const actor=db.prepare('SELECT i.user_id,g.project_ids,g.permissions FROM governance_identities i LEFT JOIN governance_identity_grants g ON i.id=g.identity_id WHERE i.enabled=1 AND i.source=? AND i.actor_id=?').get(e.source,e.actor_id??'');
    return {actor,candidates:actor?JSON.parse(String(actor.project_ids??'[]')) as number[]:[]};
  }
  if(!e.actor_id) return {};
  const candidates=person?.project_ids.length?person.project_ids:access.project_ids;
  const grant=[...candidates,...(access.default_project_id?[access.default_project_id]:[])];
  return {actor:{user_id:access.owner_user_id,project_ids:JSON.stringify(grant),permissions:'["request"]'},candidates};
}
export function selectAdmissionProject(db:DatabaseSync,id:number,e:Source,access:Access,candidates:number[]) {
  const rows=db.prepare('SELECT id,enabled,name,dingtalk_chat_ids FROM projects WHERE enabled AND NOT archived AND id IN (SELECT value FROM json_each(?))').all(JSON.stringify(candidates));
  const saved=db.prepare("SELECT value FROM governance_settings WHERE key='dingtalk_response_policy'").get();
  const policyNames=saved?JSON.parse(String(saved.value))?.group_names:null;
  const group=[e.metadata.conversation_title,e.metadata.chat_name,access.group_names[e.thread_id??''],policyNames?.[e.thread_id??'']].filter(Boolean).join('\n').toLowerCase();
  function named(input:string) {return rows.filter(r=>[String(r.name),...access.project_hints.find(h=>h.project_id===r.id)?.keywords??[]]
    .some(w=>w.trim() && input.includes(w.trim().toLowerCase())));}
  let matches=named(e.content.toLowerCase());
  if(!matches.length) matches=named(group);
  const quoted=e.metadata.reply_to_message_id;
  if(e.metadata.dws_event_type==='user_im_message_receive_o2o_all' && typeof quoted==='string' && quoted.trim() && e.thread_id) {
    const projects=db.prepare(`SELECT DISTINCT t.project_id FROM events e JOIN tasks t ON t.id=e.task_id
      WHERE e.id<? AND e.source='dingtalk' AND json_extract(e.data,'$.thread_id')=?
      AND COALESCE(json_extract(e.data,'$.metadata.profile'),'')=? AND json_extract(e.data,'$.metadata.message_id')=?
      AND json_extract(e.data,'$.routing_status') IN ('routed','manually_linked','self_context','context_only')
      AND (json_extract(e.data,'$.actor_id')=? OR json_extract(e.data,'$.metadata.self_authored')=1)`)
      .all(id,e.thread_id,String(e.metadata.profile??''),quoted,e.actor_id??'');
    if(projects.length) {
      const quotedProject=rows.find(row=>row.id===projects[0].project_id);
      if(projects.length!==1 || !quotedProject || matches.some(row=>row.id!==quotedProject.id)) {
        return {projects:[],clarification:false};
      }
      return {projects:[quotedProject],clarification:false};
    }
  }
  if(matches.length) return {projects:matches,clarification:false};
  matches=rows.filter(r=>(JSON.parse(String(r.dingtalk_chat_ids)) as unknown[]).includes(e.thread_id));
  if(matches.length===1) return {projects:matches,clarification:false};
  if(access.on_unmatched!=='default'||e.metadata.reply_to_message_id) {
    const recent=db.prepare(`SELECT t.project_id, e.data FROM events e JOIN tasks t ON e.task_id=t.id WHERE
      e.id<? AND e.source='dingtalk' AND json_extract(data,'$.actor_id')=? AND json_extract(data,'$.thread_id')=?
      AND COALESCE(json_extract(data,'$.metadata.profile'),'')=? AND json_extract(data,'$.routing_status')='routed' ORDER BY e.id DESC LIMIT 20`)
      .all(id,e.actor_id??'',e.thread_id??'',String(e.metadata.profile??''));
    const projects=new Set(recent.filter(r=>!JSON.parse(String(r.data)).project_clarification).map(r=>r.project_id));
    matches=rows.filter(r=>projects.has(r.id));
    if(matches.length===1) return {projects:matches,clarification:false};
    if(!recent.length && rows.length===1) return {projects:rows,clarification:false};
  }
  const fallback:Row[]=access.on_unmatched!=='pending'&&access.default_project_id?db.prepare('SELECT id,enabled FROM projects WHERE id=? AND enabled AND NOT archived').all(access.default_project_id):[];
  return {projects:fallback,clarification:access.on_unmatched==='ask' && fallback.length===1, fallback:true};
}
