import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { fail } from './auth.js';
import { admin, audit, tx } from './sql.js';

export function assignedNode(db:DatabaseSync,projectId:number,env:NodeJS.ProcessEnv):string|null {
  const row=db.prepare('SELECT node_id FROM project_execution_nodes WHERE project_id=?').get(projectId);
  if(row) return row.node_id===null?null:String(row.node_id);
  const map=z.record(z.string(),z.string().min(1).nullable()).parse(JSON.parse(env.SUPERAGENT_PROJECT_EXECUTION_NODES??'{}'));
  return map[String(projectId)]??null;
}
function nodes(env:NodeJS.ProcessEnv) {
  return z.array(z.object({id:z.string().min(1).max(100),project_ids:z.array(z.int().positive()),
    roots:z.array(z.string().refine(isAbsolute)).nonempty(),token_env:z.string().min(1)}))
    .refine(v=>new Set(v.map(n=>n.id)).size===v.length).parse(JSON.parse(env.SUPERAGENT_EXECUTION_NODES??'[]'));
}
export function registerNodes(app:FastifyInstance,db:DatabaseSync,env:NodeJS.ProcessEnv) {
  for(const operation of ['poll','exchange']) app.post('/api/v1/operations/daemon/'+operation,async(_request,reply)=>
    reply.code(503).send({detail:'远端执行设备由原 Python 控制器承载。请完成同库回切后连接原控制器。',execution_host:'python'}));
  app.get('/api/v1/operations/nodes',async req=>{
    admin(req.principal);
    const items=nodes(env).map(n=>{
      const row=db.prepare('SELECT seen FROM execution_nodes WHERE id=?').get(n.id);
      const seen=row?Number(row.seen)*1000:NaN;
      return {id:n.id,project_ids:n.project_ids,roots:n.roots,online:Number.isFinite(seen)&&seen>Date.now()-30_000,
        last_seen:Number.isFinite(seen)?new Date(seen).toISOString():null,shared_workspace_required:true,execution_host:'python'};
    });
    return {items,bindings:db.prepare('SELECT project_id,node_id FROM project_execution_nodes ORDER BY project_id').all()};
  });
  app.patch('/api/v1/operations/projects/:id/execution-node',async req=>{
    admin(req.principal);
    const {id}=z.object({id:z.coerce.number().int().positive()}).parse(req.params);
    const {node_id}=z.strictObject({node_id:z.string().min(1).max(100).nullable().default(null)}).parse(req.body);
    if(node_id && !nodes(env).some(n=>n.id===node_id && n.project_ids.includes(id))) fail(422,'节点未授权执行此项目');
    return tx(db,()=>{
      if(!db.prepare('SELECT id FROM projects WHERE id=?').get(id)) fail(404,'项目不存在');
      if(db.prepare("SELECT id FROM tasks WHERE project_id=? AND (status IN ('running','waiting_approval') OR outcome_unknown OR (codex_thread_id IS NOT NULL AND status NOT IN ('completed','cancelled'))) LIMIT 1").get(id))
        fail(409,'项目仍有活动任务或未结束的会话');
      db.prepare('INSERT INTO project_execution_nodes(project_id,node_id) VALUES(?,?) ON CONFLICT(project_id) DO UPDATE SET node_id=excluded.node_id').run(id,node_id);
      audit(db,req.principal.user_id,'execution_node.bind',id,{source:node_id??'local'});
      return {project_id:id,node_id};
    });
  });
}
