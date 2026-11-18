import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { fail } from './auth.js';
import { admin, audit, tx, utc } from './sql.js';
import { configureAccount } from './budget.js';
import { accessSchema,validateAccess } from './admission.js';
import { reconcileChannels } from './deliveries/channels.js';

const flag = z.boolean(), positive = z.int().positive(), text = z.string().min(1).max(255).refine(s=>!!s.trim()&&!/[\u0000-\u001f]/.test(s));
const historyZone=z.string().min(1).refine(zone=>{
  if (/^[+-](?:[01]\d|2[0-3]):[0-5]\d$/.test(zone)) return true;
  try { new Intl.DateTimeFormat('en',{timeZone:zone}); return true; } catch { return false; }
});
const model = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/).nullable();
const effort = z.enum(['low','medium','high','xhigh','max','ultra']).nullable();
const budget = z.int().min(0).max(10**15).nullable();
const profiles = z.partialRecord(z.enum(['router','semantic_routing','analysis','reply','repair','watchdog']),
  z.strictObject({model:model.optional(),effort:effort.optional()}));
const names = z.record(text,z.string().max(200));
const policy = z.strictObject({
  direct_messages:z.enum(['reply','off']),group_messages:z.enum(['requests','mentions','off']),
  delivery:z.enum(['draft','approved_send','auto_send']),default_project_id:positive.nullable(),
  group_scope:z.enum(['all','selected']).optional(),group_chat_ids:z.array(text).max(100).optional(),
  group_names:names.optional(),group_original_names:names.optional(),reply_guidance:z.string().max(1000).optional(),
  reply_max_age_minutes:positive.max(1440).optional()
}).refine(p => !p.group_scope || !!p.group_chat_ids && new Set(p.group_chat_ids).size === p.group_chat_ids.length);
const redmine = z.strictObject({
  enabled:flag.optional(),base_url:z.url().refine(s => {
    const u = new URL(s);
    return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password && !u.search && !u.hash;
  }).optional(),project_ids:z.array(positive).max(1000).optional(),user_id:positive.optional(),
  api_key_env:z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/).optional(),poll_seconds:z.number().min(1).max(86400).optional(),
  initial_since:z.string().datetime({offset:true}).optional(),account_map:z.record(text.max(100),z.array(positive).min(1).max(100))
    .refine(v=>Object.keys(v).length<=1000).optional()
}).refine(v=>!v.enabled || !!(v.base_url && v.project_ids?.length && v.user_id));
const dingtalk = z.strictObject({
  enabled:flag.optional(),profile:text.optional(),self_ids:z.array(text).nonempty().max(100).optional(),
  executable:z.union([z.string().trim().min(1).max(4096),z.array(z.string().trim().min(1).max(4096)).nonempty().max(32)]).refine(v => !(Array.isArray(v)?v:[v]).some(s=>/[\u0000-\u001f]/.test(s)||/(?:^|[-_])(token|password|secret|api[-_]?key)(?:=|$)/i.test(s))).optional(),
  kind:z.enum(['at-me','group','all-direct']).optional(),chat_id:text.optional(),
  history:z.strictObject({chat_ids:z.array(text).nonempty().max(100),initial_since:z.string().datetime({offset:true}),
    history_timezone:historyZone,sender_map:z.record(text,text).refine(v=>Object.keys(v).length<=1000).optional(),page_limit:positive.max(40).optional(),timeout:z.number().min(1).max(300).optional()}).optional()
}).refine(v=>(v.kind==='group')===!!v.chat_id && (!v.enabled || !!(v.executable && v.profile && v.self_ids?.length))
  && (!v.history || (v.kind!=='all-direct' && (v.kind!=='group'||v.history.chat_ids.every(chat=>chat===v.chat_id)))));
const schemas: Record<string,z.ZodType> = {
  dingtalk_request_access:accessSchema.nullable(),
  'connectors.redmine':redmine,'connectors.dingtalk':dingtalk,dingtalk_response_policy:policy,
  semantic_routing_enabled:flag,watchdog_enabled:flag,watchdog_interval_seconds:z.int().min(10).max(86400),
  router_agent_enabled:flag,dingtalk_route_all_mentions:flag,external_delivery_enabled:flag,scheduler_enabled:flag,
  max_concurrent_tasks:positive.max(4),dingtalk_enabled:flag,redmine_enabled:flag,
  budget_hard_limit_micros:budget,budget_reservation_estimate_micros:budget,codex_model:model,codex_effort:effort,
  codex_task_profiles:profiles
};
const defaults: Record<string, unknown> = {
  dingtalk_request_access:null,dingtalk_response_policy:null,semantic_routing_enabled:false,watchdog_enabled:false,
  watchdog_interval_seconds:60,router_agent_enabled:false,dingtalk_route_all_mentions:false,external_delivery_enabled:false,
  scheduler_enabled:false,max_concurrent_tasks:1,dingtalk_enabled:false,redmine_enabled:false,budget_hard_limit_micros:null,
  budget_reservation_estimate_micros:null,codex_model:'gpt-6.1-sol',codex_effort:'medium',codex_task_profiles:{},
  'connectors.dingtalk':{enabled:false},'connectors.redmine':{enabled:false}
};
const environments=new WeakMap<DatabaseSync,NodeJS.ProcessEnv>();
export function settings(db:DatabaseSync) {
  const values = {...defaults};
  const stored=new Set<string>();
  for (const {key,value} of db.prepare('SELECT key,value FROM governance_settings').all()) {
    const name = String(key);
    if (!Object.hasOwn(defaults,name)) continue;
    stored.add(name);
    const decoded:unknown = JSON.parse(String(value));
    const parsed = schemas[name].safeParse(decoded);
    if(name==='dingtalk_request_access' && !parsed.success) fail(503,'发起人范围配置无效');
    if (parsed.success) values[name] = parsed.data;
  }
  values.dingtalk_response_policy ??= {direct_messages:'reply',group_messages:values.dingtalk_route_all_mentions?'mentions':'requests',delivery:'draft',default_project_id:null};
  for (const channel of ['redmine','dingtalk']) {
    const key='connectors.'+channel;
    const raw=environments.get(db)?.['SUPERAGENT_'+channel.toUpperCase()+'_CONFIG'];
    if(!stored.has(key) && raw) {
      try {
        const parsed=schemas[key].safeParse(JSON.parse(raw));
        if(parsed.success) values[key]=parsed.data;
      } catch { /* Invalid optional environment configuration stays disabled. */ }
    }
    values[channel+'_enabled'] = (values[key] as {enabled?:boolean}).enabled ?? false;
  }
  return values;
}
export function registerSettings(app:FastifyInstance,db:DatabaseSync,env:NodeJS.ProcessEnv) {
  environments.set(db,env);
  app.get('/api/v1/settings', async () => ({...settings(db),service_mode:env.SUPERAGENT_SERVICE_MODE ?? 'service',
    authentication_required:Boolean(env.SUPERAGENT_API_TOKEN || env.SUPERAGENT_USERS_JSON)}));
  app.patch('/api/v1/settings', async req => {
    admin(req.principal);
    const changes = z.record(z.string(),z.unknown()).parse(req.body);
    for (const [name,value] of Object.entries(changes)) {
      if (!Object.hasOwn(schemas,name)) fail(422,'不支持的设置项');
      schemas[name].parse(value);
    }
    const snapshot=tx(db,() => {
      const before = settings(db);
      if(changes.dingtalk_request_access!=null) {
        const access=accessSchema.parse(changes.dingtalk_request_access);
        validateAccess(db,env,access);
        changes.dingtalk_request_access=access;
      }
      if (Object.hasOwn(changes,'budget_hard_limit_micros')) {
        const account=db.prepare("SELECT currency FROM governance_budget_accounts WHERE id='global'").get();
        configureAccount(db,'global',budget.parse(changes.budget_hard_limit_micros),String(account?.currency??'USD'),req.principal.user_id);
      }
      for (const ch of ['redmine','dingtalk']) {
        const key = 'connectors.'+ch, alias = ch+'_enabled';
        if (Object.hasOwn(changes,alias)) {
          const cfg = (changes[key] ?? before[key]) as {enabled?:boolean};
          if (Object.hasOwn(changes,key) && (cfg.enabled ?? false) !== changes[alias]) fail(422,'连接器启用字段冲突');
          changes[key] = schemas[key].parse({...cfg,enabled:changes[alias]});
        }
        if(Object.hasOwn(changes,key)) changes[alias]=(changes[key] as {enabled?:boolean}).enabled??false;
      }
      const save = db.prepare('INSERT INTO governance_settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at');
      for (const [key,value] of Object.entries(changes)) {
        save.run(key,JSON.stringify(value),utc());
        audit(db,req.principal.user_id,'settings.write',key,{value});
      }
      return settings(db);
    });
    if(Object.keys(changes).some(k=>['dingtalk_enabled','redmine_enabled','dingtalk_response_policy','connectors.dingtalk','connectors.redmine'].includes(k)))
      await reconcileChannels(app,changes);
    return snapshot;
  });
}
