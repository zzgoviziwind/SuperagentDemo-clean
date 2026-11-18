import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { fail } from './auth.js';
import { admin, audit, serialize, tx, utc, type Row } from './sql.js';

const amount=z.int().min(0).max(10**15);
const reservation=(r:Row)=>({...r,usage:r.usage==null?null:JSON.parse(String(r.usage))});
export function reserveModelRun(db:DatabaseSync,key:string,estimate:number,taskId:number|null,basis:string) {
  amount.positive().parse(estimate);
  const account='global';
  return tx(db,()=>{
    const old=db.prepare('SELECT * FROM governance_budget_reservations WHERE account_id=? AND request_key=?').get(account,key);
    if(old) {
      if(old.estimate_micros!==estimate || old.task_id!==taskId || old.estimate_basis!==basis) fail(409,'预算请求已绑定其他估算');
      return Number(old.id);
    }
    const updated=db.prepare('UPDATE governance_budget_accounts SET reserved_micros=reserved_micros+? WHERE id=? AND (hard_limit_micros IS NULL OR spent_micros+reserved_micros+?<=hard_limit_micros)').run(estimate,account,estimate);
    if(!updated.changes) fail(409,'预算不足或账户尚未配置');
    const id=Number(db.prepare("INSERT INTO governance_budget_reservations(account_id,request_key,task_id,estimate_micros,estimate_basis,status,created_at) VALUES(?,?,?,?,?,'reserved',?)").run(account,key,taskId,estimate,basis,utc()).lastInsertRowid);
    audit(db,'scheduler','budget.reserve',id,{estimate_micros:estimate});
    return id;
  });
}
export function settleBudget(db:DatabaseSync,id:number,actual:number|null,usage:{source:string;evidence?:string;pricing_version?:string}|null,actor:string) {
  if(actual!==null) {amount.parse(actual);if(!usage?.source) fail(422,'缺少用量依据');}
  return tx(db,()=>{
    const r=db.prepare('SELECT * FROM governance_budget_reservations WHERE id=?').get(id)??fail(404,'预算预留不存在');
    const evidence=usage===null?null:JSON.stringify(usage);
    if(r.status==='settled') {
      const prior=reservation(r);
      if(r.actual_micros!==actual || JSON.stringify(prior.usage)!==evidence) fail(409,'预算已按其他用量结算');
      return prior;
    }
    if(actual===null) {
      db.prepare("UPDATE governance_budget_reservations SET status='unknown' WHERE id=?").run(id);
      audit(db,actor,'budget.unknown',id);
    } else {
      if(!db.prepare('UPDATE governance_budget_accounts SET reserved_micros=reserved_micros-?,spent_micros=spent_micros+? WHERE id=? AND reserved_micros>=?')
        .run(r.estimate_micros,actual,r.account_id,r.estimate_micros).changes) fail(409,'预算账户与预留不一致');
      db.prepare("UPDATE governance_budget_reservations SET actual_micros=?,usage=?,status='settled' WHERE id=?").run(actual,evidence,id);
      audit(db,actor,'budget.settle',id,{actual_micros:actual,usage});
    }
    return reservation(db.prepare('SELECT * FROM governance_budget_reservations WHERE id=?').get(id)!);
  });
}
export function configureAccount(db:DatabaseSync,id:string,limit:number|null,currency:string,actor:string) {
  const changed=db.prepare(`INSERT INTO governance_budget_accounts(id,hard_limit_micros,currency,spent_micros,reserved_micros)
    VALUES(?,?,?,0,0) ON CONFLICT(id) DO UPDATE SET hard_limit_micros=excluded.hard_limit_micros,currency=excluded.currency
    WHERE currency=excluded.currency OR (spent_micros=0 AND reserved_micros=0)`).run(id,limit,currency);
  if(!changed.changes) fail(409,'已有用量的账户不可切换币种');
  if(id==='global') db.prepare("INSERT INTO governance_settings(key,value,updated_at) VALUES('budget_hard_limit_micros',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").run(JSON.stringify(limit),utc());
  audit(db,actor,'budget.configure',id,{hard_limit_micros:limit,currency});
  return db.prepare('SELECT * FROM governance_budget_accounts WHERE id=?').get(id);
}
export function registerBudget(app:FastifyInstance,db:DatabaseSync) {
  app.get('/api/v1/audit',async req=>{
    admin(req.principal);
    const limit=z.object({limit:z.coerce.number().int().min(1).max(1000).default(100)}).parse(req.query).limit;
    return db.prepare('SELECT * FROM governance_audit ORDER BY id DESC LIMIT ?').all(limit).map(serialize);
  });
  app.get('/api/v1/budgets',async req=>{admin(req.principal);return db.prepare('SELECT * FROM governance_budget_accounts ORDER BY id').all();});
  app.patch('/api/v1/budgets/:id',async req=>{
    admin(req.principal);
    const {id}=z.object({id:z.string().min(1).max(200)}).parse(req.params);
    const {hard_limit_micros,currency}=z.strictObject({hard_limit_micros:amount.nullable(),currency:z.string().min(1).max(20).default('USD')}).parse(req.body);
    return tx(db,()=>configureAccount(db,id,hard_limit_micros,currency,req.principal.user_id));
  });
  app.get('/api/v1/budget-reservations',async req=>{
    admin(req.principal);
    const q=z.object({account_id:z.string().optional(),status:z.enum(['reserved','unknown','settled']).optional(),limit:z.coerce.number().int().min(1).max(1000).default(100)}).parse(req.query);
    return db.prepare('SELECT * FROM governance_budget_reservations WHERE (? IS NULL OR account_id=?) AND (? IS NULL OR status=?) ORDER BY id DESC LIMIT ?')
      .all(q.account_id??null,q.account_id??null,q.status??null,q.status??null,q.limit).map(reservation);
  });
  app.post('/api/v1/budget-reservations/:id/reconcile',async req=>{
    admin(req.principal);
    const {id}=z.object({id:z.coerce.number().int().positive()}).parse(req.params);
    const body=z.strictObject({actual_micros:amount,evidence:z.string().trim().min(1).max(2000)}).parse(req.body);
    return settleBudget(db,id,body.actual_micros,{source:'administrator_reconciliation',evidence:body.evidence},req.principal.user_id);
  });
}
