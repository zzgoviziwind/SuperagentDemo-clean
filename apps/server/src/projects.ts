import type { FastifyInstance } from 'fastify';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, realpathSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, join, parse, relative, sep } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';
import { fail, roleOf } from './auth.js';
import { admin, audit, record, serialize, tx, utc } from './sql.js';

const label = z.string().trim().min(1).max(255), branch = label.refine(s => !s.startsWith('-') && !/[\x00-\x1f]/.test(s));
const ids = z.array(label);
const project = z.strictObject({name:label,repo_path:z.string().min(1),repositories:z.array(z.strictObject({path:label,base_branch:branch})).max(20).default([]),
  reference_access:z.enum(['workspace','projects','directories']).default('workspace'),reference_dirs:z.array(z.string()).max(12).default([]),
  base_branch:branch.default('main'),test_command:z.string().max(8192).default(''),allowed_paths:ids.default([]),
  dingtalk_chat_ids:ids.default([]),redmine_project_ids:ids.default([]),enabled:z.boolean().default(true)});
const identity = z.strictObject({source:z.enum(['redmine','dingtalk']),actor_id:label,user_id:label,enabled:z.boolean().default(true),
  project_ids:z.array(z.int().positive()).max(1000).default([]),permissions:z.array(z.literal('request')).max(1).default([])});
const param = z.object({id:z.coerce.number().int().positive()});
export function within(parent:string,child:string) {
  const rest = relative(parent,child);
  return rest !== '..' && !rest.startsWith('..'+sep) && !isAbsolute(rest);
}
function directory(value:string) {
  try {
    if (isAbsolute(value) && statSync(value).isDirectory()) return realpathSync(value);
  } catch { /* report a stable input error */ }
  return fail(422,'目录必须是存在的绝对路径');
}
function childPath(root:string, entry:string, allowRoot:boolean) {
  if (entry === '.' && allowRoot) return root;
  const parts = entry.replaceAll('\\','/').split('/');
  if (parts.some(p=>!p || p==='.' || p==='..' || /[\x00-\x1f:]/.test(p) || p.toLowerCase()==='.git')) fail(422,'项目相对路径无效');
  let child = root;
  for(const part of parts) {
    child=join(child,part);
    if (existsSync(child) && lstatSync(child).isSymbolicLink()) fail(422,'相对目录含链接');
  }
  return child;
}
function validate(value:z.infer<typeof project>,env:NodeJS.ProcessEnv) {
  value.repo_path=directory(value.repo_path);
  const roots=env.SUPERAGENT_ALLOWED_REPO_ROOTS?.split(delimiter).filter(Boolean).map(directory);
  if (roots?.length && !roots.some(p=>within(p,value.repo_path))) fail(422,'项目目录不在允许范围');
  value.allowed_paths.forEach(p=>childPath(value.repo_path,p,true));
  const repos:string[]=[];
  for(const item of value.repositories) {
    const p=directory(childPath(value.repo_path,item.path,false));
    if (repos.some(q=>within(p,q)||within(q,p))) fail(422,'仓库目录重复或互相包含');
    repos.push(p);
    const git=(args:string[])=>execFileSync('git',['--no-optional-locks','-C',p,...args],{encoding:'utf8',windowsHide:true,timeout:5000,stdio:['ignore','pipe','ignore']}).trim();
    try {
      if (relative(p,directory(git(['rev-parse','--show-toplevel']))) !== '') fail(422,'子仓库必须位于仓库根目录');
      git(['rev-parse','--verify','refs/heads/'+item.base_branch+'^{commit}']);
    } catch { fail(422,'子仓库或基线分支不可用'); }
  }
  if (value.reference_access === 'directories') {
    if (!value.reference_dirs.length) fail(422,'请添加只读资料目录');
    value.reference_dirs=value.reference_dirs.map(directory);
    for(const p of value.reference_dirs) {
      const anchor=parse(p).root,home=env.USERPROFILE||homedir();
      const protectedDirs=[join(home,'AppData'),env.SystemRoot||join(anchor,'Windows'),...['ProgramData','Program Files','Program Files (x86)'].map(s=>join(anchor,s))];
      if (p===anchor || within(p,home) || protectedDirs.some(d=>within(p,d)||within(d,p)) ||
          (roots?.length && !roots.some(r=>within(r,p)))) fail(422,'资料目录超出允许范围');
    }
  } else value.reference_dirs=[];
  return value;
}
function bind(value:unknown):SQLInputValue {
  if (typeof value==='boolean') return Number(value);
  if (typeof value==='string' || typeof value==='number' || value===null) return value;
  return JSON.stringify(value);
}
const identityQuery = 'SELECT i.*,COALESCE(g.project_ids,\'[]\') project_ids,COALESCE(g.permissions,\'[]\') permissions FROM governance_identities i LEFT JOIN governance_identity_grants g ON g.identity_id=i.id';
export function registerProjects(app:FastifyInstance,db:DatabaseSync,env:NodeJS.ProcessEnv) {
  app.post('/api/v1/tasks/:id/project',async req=>{
    admin(req.principal);
    const {id}=param.parse(req.params);
    const v=z.strictObject({project_id:z.int().positive(),expected_state_version:z.int().positive(),reason:z.string().trim().min(1).max(2000)}).parse(req.body);
    return tx(db,()=>{
      const t=db.prepare('SELECT * FROM tasks WHERE id=?').get(id)??fail(404,'任务不存在');
      if(t.state_version!==v.expected_state_version) fail(409,'状态已变化，请刷新');
      const p=db.prepare('SELECT * FROM projects WHERE id=?').get(v.project_id)??fail(404,'项目不存在');
      if(!p.enabled || p.archived) fail(409,'目标项目不可用');
      if(p.id===t.project_id) return serialize(t);
      if(t.outcome_unknown || !['paused','waiting_input','review_ready','failed'].includes(String(t.status)) ||
        db.prepare("SELECT id FROM execution_attempts WHERE task_id=? AND status IN ('claimed','running','waiting_approval') LIMIT 1").get(id)) fail(409,'请先停止执行并核验状态');
      if(db.prepare("SELECT id FROM events WHERE task_id=? AND source='field' LIMIT 1").get(id)) fail(409,'含现场证据的事件不能更换项目');
      if(db.prepare('SELECT 1 FROM task_routes WHERE project_id=? AND task_id!=? AND route_key IN (SELECT route_key FROM task_routes WHERE task_id=?) LIMIT 1').get(p.id,id,id)) fail(409,'目标项目已有来源冲突');
      const row=db.prepare("UPDATE tasks SET project_id=?,workspace_path=NULL,codex_thread_id=NULL,codex_turn_id=NULL,revision=revision+1,control_version=control_version+1,state_version=state_version+1,status='waiting_input',last_error='项目已更换，旧工作区和结果保留为历史；请确认后继续',updated_at=? WHERE id=? RETURNING *").get(p.id,utc(),id)!;
      db.prepare('UPDATE task_routes SET project_id=? WHERE task_id=?').run(p.id,id);
      db.prepare('UPDATE worker_subscriptions SET enabled=0 WHERE task_id=?').run(id);
      db.prepare("UPDATE approvals SET status='expired' WHERE task_id=? AND status='pending'").run(id);
      record(db,id,'project_rebound','所属项目已更换为「'+p.name+'」。原因：'+v.reason,{from_project_id:t.project_id,project_id:p.id,revision:row.revision,previous_workspace:t.workspace_path,previous_thread_id:t.codex_thread_id,actor:req.principal.user_id});
      audit(db,req.principal.user_id,'task.project.update',id,{revision:row.revision,state_version:row.state_version});
      return serialize(row);
    });
  });
  app.post('/api/v1/projects',async req=>{
    admin(req.principal);
    const p=validate(project.parse(req.body),env);
    return tx(db,()=>{
      const keys=Object.keys(p);
      const row=db.prepare('INSERT INTO projects('+keys.join(',')+',created_at,archived) VALUES('+keys.map(()=>'?').join(',')+',?,0) RETURNING *').get(...Object.values(p).map(bind),utc())!;
      audit(db,req.principal.user_id,'project.create',Number(row.id));
      return serialize(row);
    });
  });
  app.patch('/api/v1/projects/:id',async req=>{
    admin(req.principal);
    const {id}=param.parse(req.params);
    const changes=z.record(z.string(),z.unknown()).parse(req.body);
    return tx(db,()=>{
      const current=serialize(db.prepare('SELECT * FROM projects WHERE id=?').get(id)??fail(404,'项目不存在'));
      const {id:ignored,created_at,archived,...editable}=current;
      const p=validate(project.parse({...editable,...changes}),env);
      const row=db.prepare('UPDATE projects SET '+Object.keys(p).map(k=>k+'=?').join(',')+' WHERE id=? RETURNING *').get(...Object.values(p).map(bind),id)!;
      audit(db,req.principal.user_id,'project.update',id);
      return serialize(row);
    });
  });
  app.delete('/api/v1/projects/:id',async req=>{
    admin(req.principal);
    const {id}=param.parse(req.params);
    return tx(db,()=>{
      if (!db.prepare('UPDATE projects SET enabled=0,archived=1 WHERE id=?').run(id).changes) fail(404,'项目不存在');
      const historical=!!db.prepare('SELECT id FROM tasks WHERE project_id=? LIMIT 1').get(id);
      audit(db,req.principal.user_id,historical?'project.archive':'project.delete',id);
      return historical?{archived:true,message:'项目已归档，历史事件和会话可继续查看'}:{deleted:true};
    });
  });
  app.get('/api/v1/identities',async req=>{admin(req.principal);return db.prepare(identityQuery+' ORDER BY i.id').all().map(serialize);});
  app.route({method:['POST','PATCH'],url:'/api/v1/identities',handler:async req=>{
    admin(req.principal);
    const v=identity.parse(req.body);
    if (!roleOf(env,v.user_id)) fail(422,'用户未配置');
    return tx(db,()=>{
      const projects=[...new Set(v.project_ids)].sort((a,b)=>a-b);
      if (projects.some(id=>!db.prepare('SELECT id FROM projects WHERE id=?').get(id))) fail(422,'授权项目不存在');
      const {id}=db.prepare('INSERT INTO governance_identities(source,actor_id,user_id,enabled) VALUES(?,?,?,?) ON CONFLICT(source,actor_id) DO UPDATE SET user_id=excluded.user_id,enabled=excluded.enabled RETURNING id')
        .get(v.source,v.actor_id,v.user_id,Number(v.enabled))!;
      db.prepare('INSERT INTO governance_identity_grants(identity_id,project_ids,permissions) VALUES(?,?,?) ON CONFLICT(identity_id) DO UPDATE SET project_ids=excluded.project_ids,permissions=excluded.permissions')
        .run(id,JSON.stringify(projects),JSON.stringify(v.permissions));
      audit(db,req.principal.user_id,'identity.write',Number(id),{...v,project_ids:projects});
      return serialize(db.prepare(identityQuery+' WHERE i.id=?').get(id)!);
    });
  }});
  app.delete('/api/v1/identities/:id',async req=>{
    admin(req.principal);
    const {id}=param.parse(req.params);
    return tx(db,()=>{
      if(!db.prepare('UPDATE governance_identities SET enabled=0 WHERE id=?').run(id).changes) fail(404,'身份映射不存在');
      audit(db,req.principal.user_id,'identity.disable',id);
      return serialize(db.prepare(identityQuery+' WHERE i.id=?').get(id)!);
    });
  });
}
