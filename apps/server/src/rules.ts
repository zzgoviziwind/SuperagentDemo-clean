import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { fail } from './auth.js';
import { admin, audit, tx, utc } from './sql.js';

const rule = z.strictObject({
  name:z.string().min(1).max(80),enabled:z.boolean().default(true),project_id:z.int().positive().nullable().default(null),
  source:z.enum(['dingtalk','redmine']).nullable().default(null),chat_id:z.string().max(255).nullable().default(null),
  actor_id:z.string().max(255).nullable().default(null),kind:z.enum(['reply','analysis','repair']).nullable().default(null),
  action:z.enum(['pause','quiet','review','reply_quiet']),start_hour:z.int().min(0).max(23).default(20),end_hour:z.int().min(0).max(23).default(8)
}).refine(r=>(!r.chat_id || r.source==='dingtalk') && (!r.action.includes('quiet') || r.start_hour!==r.end_hour));
function rules(db:DatabaseSync) {
  const row=db.prepare("SELECT value FROM governance_settings WHERE key='private_event_rules'").get();
  return z.array(rule).parse(row ? JSON.parse(String(row.value)) : []);
}
export function evaluateRules(db:DatabaseSync,source:string,project:number,kind:string,data:{thread_id?:string;actor_id?:string},at=Date.now()) {
  const hour=new Date(at+8*3600000).getUTCHours();
  return new Set(rules(db).filter(r=>r.enabled && (!r.project_id||r.project_id===project) && (!r.source||r.source===source)
    && (!r.chat_id||r.chat_id===data.thread_id) && (!r.actor_id||r.actor_id===data.actor_id) && (!r.kind||r.kind===kind)
    && (!r.action.includes('quiet') || (r.start_hour<r.end_hour?hour>=r.start_hour && hour<r.end_hour:hour>=r.start_hour || hour<r.end_hour))).map(r=>r.action));
}
export function registerRules(app:FastifyInstance,db:DatabaseSync) {
  app.get('/api/v1/event-rules',async req=>{admin(req.principal);return {items:rules(db),timezone:'Asia/Shanghai'};});
  app.put('/api/v1/event-rules',async req=>{
    admin(req.principal);
    const {items}=z.strictObject({items:z.array(rule).max(100)}).parse(req.body);
    return tx(db,()=>{
      if(items.some(r=>r.project_id && !db.prepare('SELECT id FROM projects WHERE id=?').get(r.project_id))) fail(422,'项目不存在');
      db.prepare("INSERT INTO governance_settings(key,value,updated_at) VALUES('private_event_rules',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at")
        .run(JSON.stringify(items),utc());
      audit(db,req.principal.user_id,'event_rules.update','settings',{count:items.length});
      return {items,timezone:'Asia/Shanghai'};
    });
  });
}
