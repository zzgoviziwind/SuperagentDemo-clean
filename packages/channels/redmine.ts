import { z } from 'zod';
import { ChannelError, CursorStore, digest, limitedJson, utc } from './common.ts';
import type { Emit, Incoming } from './common.ts';
import type { Fields, Json } from '../storage/index.ts';
import { join } from 'node:path';
import { accept, boundedBytes, invalid, MiB } from './resources.ts';

const id=z.number().int().positive();
export const redmineAccountMap=z.record(z.string().min(1).max(100).refine(s=>!!s.trim()),z.array(id).min(1).max(100))
  .refine(map=>Object.keys(map).length<=1000);
const party=z.object({id});
const issueSchema=z.object({id,subject:z.string().nullish(),description:z.string().nullish(),project:party,
  assigned_to:party.nullish(),author:party.nullish(),updated_on:z.string(),status:z.object({is_closed:z.boolean().optional()}).optional(),
  attachments:z.array(z.record(z.string(),z.json())).default([]),journals:z.array(z.object({
    id,user:party.nullish(),created_on:z.string(),notes:z.string().nullish(),
    details:z.array(z.record(z.string(),z.json())).default([])})).default([])});
type Issue=z.infer<typeof issueSchema>;
type Snapshot={fingerprint:string;sequence:number;assigned_to_id:string};
export interface RedmineConfig {base_url:string;user_id:number;project_ids:number[];all_assigned_projects?:boolean;initial_since?:string;poll_seconds?:number;
  account_map?:Record<string,number[]>}
export class Redmine {
  readonly base:string;
  readonly config:RedmineConfig;
  #key:string;
  constructor(config:RedmineConfig,apiKey:string) {
    const u=new URL(config.base_url);
    if(config.account_map!==undefined) redmineAccountMap.parse(config.account_map);
    if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.search||u.hash||!apiKey||!id.safeParse(config.user_id).success)
      throw new ChannelError('redmine_configuration_invalid');
    this.base=config.base_url.replace(/\/+$/,'');this.config=config;this.#key=apiKey;
  }
  async #request(path:string, signal:AbortSignal, body?:unknown) {
    const write=body!==undefined;
    let response:Response;
    try {
      response=await fetch(this.base+path,{method:write?'PUT':'GET',headers:{'X-Redmine-API-Key':this.#key,'Content-Type':'application/json'},
        body:write?JSON.stringify(body):undefined,redirect:'manual',signal:AbortSignal.any([signal,AbortSignal.timeout(8000)])});
    } catch {throw new ChannelError('redmine_transport_failure',write);}
    if(!response.ok){await response.body?.cancel();throw new ChannelError('redmine_http_'+response.status,write && (response.status>=500 || response.status===408));}
    try{return await limitedJson(response);}catch{throw new ChannelError('redmine_invalid_response',write);}
  }
  async verify(signal:AbortSignal) {
    const me=await this.#request('/users/current.json',signal);
    if(me?.user?.id!==this.config.user_id) throw new ChannelError('redmine_account_mismatch');
  }
  async verifyIssue(issueId:number,signal:AbortSignal) {
    const result=await this.#request('/issues/'+id.parse(issueId)+'.json',signal);
    if(result.issue?.id!==issueId || !this.config.project_ids.includes(result.issue?.project?.id))
      throw new ChannelError('redmine_issue_scope_mismatch');
  }
  async attachments(issueId:number,requested:number[],projects:number[],dir:string,signal:AbortSignal) {
    await this.verify(signal);
    const {issue}=await this.#request('/issues/'+id.parse(issueId)+'.json?include=attachments',signal);
    if(issue?.id!==issueId || !projects.includes(issue.project?.id) || !this.config.project_ids.includes(issue.project?.id)
      || !Array.isArray(issue.attachments) || !requested.length || requested.length>10) invalid('attachment_issue_scope_mismatch');
    const results=[];let total=0;
    for(const aid of new Set(requested)) {
      id.parse(aid);
      const matches=issue.attachments.filter((a:{id:number})=>a.id===aid);
      if(matches.length!==1) invalid('attachment_manifest_missing');
      const a=matches[0],url=new URL(a.content_url,this.base+'/'),base=new URL(this.base);
      const expected=base.pathname.replace(/\/+$/,'')+'/attachments/download/'+aid;
      const suffix=url.pathname.slice(expected.length);
      if(url.origin!==base.origin || url.username || url.password || url.hash || !url.pathname.startsWith(expected)
        || (suffix!=='' && !/^\/[^/]+$/.test(suffix)) || /[\\/]/.test(decodeURIComponent(suffix.slice(1)))) invalid('attachment_url_mismatch');
      const limit=Math.min((String(a.content_type).startsWith('image/')?10:20)*MiB,40*MiB-total);
      if(!Number.isSafeInteger(a.filesize)||a.filesize<1||a.filesize>limit) invalid('attachment_size_limit');
      const r=await fetch(url,{headers:{'X-Redmine-API-Key':this.#key,'Accept-Encoding':'identity'},redirect:'error',signal});
      if(!r.ok){await r.body?.cancel();invalid('attachment_http_failure');}
      const bytes=await boundedBytes(r,limit);
      if(bytes.length!==a.filesize || r.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!==String(a.content_type).split(';')[0].trim().toLowerCase())
        invalid('attachment_incomplete');
      signal.throwIfAborted();results.push(await accept(join(dir,String(aid)),a.filename,bytes,a.content_type,limit));total+=bytes.length;
    }
    return results;
  }
  async comment(issueId:number,content:string,signal:AbortSignal) {
    id.parse(issueId);
    await this.#request('/issues/'+issueId+'.json',signal,{issue:{notes:content}});
    return {write_status:'succeeded',verification:'not_performed'};
  }
  async *issues(project:number|null,since:string|null,signal:AbortSignal) {
    const seen=new Set<number>();
    for(let offset=0;;) {
      const params=new URLSearchParams({status_id:'*',sort:'id:asc',offset:String(offset),limit:'100'});
      if(project===null) params.set('assigned_to_id',String(this.config.user_id));
      else {
        params.set('project_id',String(project));
        params.set('subproject_id','!*');
      }
      if(since) params.set('updated_on','>='+utc(since).slice(0,19)+'Z');
      const page=await this.#request('/issues.json?'+params,signal);
      if(!Array.isArray(page.issues)||!Number.isSafeInteger(page.total_count)||page.total_count<0||(page.offset??offset)!==offset)
        throw new ChannelError('redmine_invalid_pagination');
      for(const item of page.issues) {
        const n=id.parse(item.id);
        if(seen.has(n)) continue;
        seen.add(n);
        const issue=issueSchema.parse((await this.#request('/issues/'+n+'.json?include=journals,attachments',signal)).issue);
        if(issue.id!==n || (project!==null && issue.project.id!==project)) throw new ChannelError('redmine_issue_scope_mismatch');
        if(project!==null || issue.assigned_to?.id===this.config.user_id) yield issue;
      }
      offset+=page.issues.length;
      if(offset>=page.total_count) return;
      if(!page.issues.length) throw new ChannelError('redmine_incomplete_pagination');
    }
  }
}
function mentions(text:string,config:RedmineConfig) {
  const definite:string[]=[],uncertain:string[]=[];
  for(const match of text.matchAll(/(?<![\p{L}\p{N}_@])@([\p{L}\p{N}_.-]+)/gu)) {
    const alias=match[1],map=config.account_map;
    const mapped=map && Object.hasOwn(map,alias)?map[alias]:[];
    if(mapped.length===1 && mapped[0]===config.user_id) definite.push(alias);
    else if(!mapped.length || mapped.includes(config.user_id)) uncertain.push(alias);
  }
  return {mentions:definite,uncertain_mentions:uncertain};
}
function restored(state:CursorStore,c:Redmine,issue:number,project:number):Snapshot|null {
  const row=state.db.prepare(`SELECT data,external_id FROM events WHERE source='redmine' AND json_extract(data,'$.metadata.redmine_endpoint')=?
    AND CAST(json_extract(data,'$.issue_id') AS TEXT)=? AND CAST(json_extract(data,'$.metadata.external_user_id') AS TEXT)=?
    AND CAST(json_extract(data,'$.project_external_id') AS TEXT) =?
    AND COALESCE(json_extract(data,'$.original_event_type'),json_extract(data,'$.event_type'),event_type)='issue.updated'
    ORDER BY id DESC LIMIT 1`).get(c.base,String(issue),String(c.config.user_id),String(project));
  if(!row) return null;
  const e=JSON.parse(String(row.data)),m=e.metadata, newline=typeof e.content==='string'?e.content.indexOf('\n'):-1;
  const assigned=m.assigned_to_id ?? (m.assigned_to_me===true?String(c.config.user_id):null);
  if(e.source!=='redmine' || newline<0 || assigned===null || !/^\d*$/.test(String(assigned)) || (typeof m.assigned_to_me==='boolean' && m.assigned_to_me!==(String(assigned)===String(c.config.user_id)))) return null;
  const fingerprint=digest({subject:e.content.slice(0,newline),description:e.content.slice(newline+1),assigned_to_id:String(assigned),project_id:String(e.project_external_id)});
  if(m.issue_fingerprint!==undefined && m.issue_fingerprint!==fingerprint) return null;
  const prefix=c.base+':issue:'+issue+':', external=String(row.external_id);
  if(!external.startsWith(prefix) || e.external_id!==external) return null;
  const suffix=external.slice(prefix.length), snapshot=/^snapshot:([1-9]\d*):([a-f0-9]{64})$/.exec(suffix);
  if(snapshot ? snapshot[2]!==fingerprint : !/(Z|[+-]\d\d:\d\d)$/i.test(suffix)||!Number.isFinite(Date.parse(suffix))) return null;
  const sequence=snapshot?Number(snapshot[1]):1;
  return (m.issue_snapshot_sequence??sequence)===sequence ? {fingerprint,sequence,assigned_to_id:String(assigned)} : null;
}
export class RedminePoller {
  readonly key:string;
  readonly projects:number[];
  readonly client:Redmine;
  readonly state:CursorStore;
  readonly emit:Emit;
  #busy=false;
  constructor(client:Redmine,state:CursorStore,emit:Emit) {
    this.client=client;this.state=state;this.emit=emit;
    this.projects=[...new Set(z.array(id).min(client.config.all_assigned_projects?0:1).parse(client.config.project_ids))].sort((a,b)=>a-b);
    this.key='redmine:'+client.base+':'+(client.config.all_assigned_projects?'all-assigned:'+this.projects.join(','):this.projects.join(','))+':'+client.config.user_id;
  }
  async #consume(issue:Issue,signal:AbortSignal,replay=false) {
    const c=this.client, config=c.config, user=String(config.user_id), project=String(issue.project.id), n=String(issue.id);
    if(!this.projects.includes(issue.project.id) && !(config.all_assigned_projects && issue.assigned_to?.id===config.user_id)) throw new ChannelError('redmine_project_scope_mismatch');
    const key=this.key+':issue:'+n+':semantics', pending=this.key+':pending_initial_issue';
    const checkpoint=this.state.get<Snapshot>(key);
    const valid=checkpoint && /^[0-9a-f]{64}$/.test(checkpoint.fingerprint) && Number.isSafeInteger(checkpoint.sequence) && checkpoint.sequence>0;
    const previous=valid?checkpoint:restored(this.state,c,issue.id,issue.project.id);
    const semantics={subject:issue.subject??'',description:issue.description??'',project_id:project,assigned_to_id:String(issue.assigned_to?.id??'')};
    const fingerprint=digest(semantics), changed=previous?.fingerprint!==fingerprint, sequence=(previous?.sequence??0)+Number(changed);
    const assigned=semantics.assigned_to_id===user, prefix=c.base+':issue:'+n+':';
    const meta:Fields={assigned_to_me:assigned,assigned_to_id:semantics.assigned_to_id,project_id:null,redmine_endpoint:c.base,external_user_id:user};
    if(typeof issue.status?.is_closed==='boolean') meta.issue_is_closed=issue.status.is_closed;
    const common={source:'redmine' as const,thread_id:n,project_external_id:project,issue_id:n};
    const send=async(event:Incoming)=>{signal.throwIfAborted();await this.emit(event);signal.throwIfAborted();};
    const m=mentions(semantics.description,config);
    const initial=(!previous && (assigned || !!m.mentions.length || !!m.uncertain_mentions.length));
    if(initial && !replay) this.state.set(pending,issue);
    if(changed && (initial || assigned || previous?.assigned_to_id===user || m.mentions.length || m.uncertain_mentions.length)) {
      await send({...common,event_type:'issue.updated',external_id:prefix+(previous?'snapshot:'+sequence+':'+fingerprint:utc(issue.updated_on)),
        actor_id:String(issue.author?.id??''),content:semantics.subject+'\n'+semantics.description,occurred_at:utc(issue.updated_on),attachments:issue.attachments as Json[],
        metadata:{...meta,...m,needs_confirmation:!!m.uncertain_mentions.length && !assigned && !m.mentions.length,issue_fingerprint:fingerprint,issue_snapshot_sequence:sequence}});
    }
    for(const j of issue.journals) {
      const notes=j.notes??'', m=mentions(notes,config), details=j.details as Fields[];
      const assignment=details.some(d=>d.name==='assigned_to_id' && [String(d.new_value),String(d.old_value)].includes(user));
      if(!assigned && !assignment && !m.mentions.length && !m.uncertain_mentions.length) continue;
      const revision=digest({notes,details});
      const attached=new Set(details.filter(d=>d.property==='attachment').map(d=>String(d.name)));
      await send({...common,event_type:notes.trim()?'issue.comment':'issue.changed',external_id:prefix+'journal:'+j.id+':'+revision,
        actor_id:String(j.user?.id??''),content:notes,occurred_at:utc(j.created_on),attachments:issue.attachments.filter(a=>attached.has(String(a.id))) as Json[],
        metadata:{...meta,...m,details,journal_id:String(j.id),journal_revision:revision,
          needs_confirmation:!!m.uncertain_mentions.length && !assigned && !assignment && !m.mentions.length}});
    }
    signal.throwIfAborted();
    if(changed || !valid) this.state.set(key,{fingerprint,sequence,assigned_to_id:semantics.assigned_to_id});
    if(initial || replay) this.state.set(pending,null);
  }
  async pollOnce(signal:AbortSignal) {
    if(this.#busy) throw new ChannelError('redmine_poll_in_progress');
    this.#busy=true;
    try {
      await this.client.verify(signal);
      const before=this.state.get<string>(this.key), boundary=utc(Date.now());
      const since=before?utc(Date.parse(before)-120000):this.client.config.initial_since??null;
      const pending=this.state.get<Issue>(this.key+':pending_initial_issue');
      if(pending) await this.#consume(issueSchema.parse(pending),signal,true);
      for(const project of this.projects) for await(const issue of this.client.issues(project,since,signal)) await this.#consume(issue,signal);
      signal.throwIfAborted();
      if(this.client.config.all_assigned_projects) {
        for await(const issue of this.client.issues(null,since,signal)) {
          if(!this.projects.includes(issue.project.id)) await this.#consume(issue,signal);
        }
      }
      this.state.set(this.key,before && before>boundary?before:boundary);
      return boundary;
    } finally {this.#busy=false;}
  }
}
