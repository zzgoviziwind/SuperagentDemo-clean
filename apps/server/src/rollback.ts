import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { openStorage } from '../../../packages/storage/src/index.ts';
import { createWorkbenchScheduler } from './workbench/scheduler.js';

/** Prepare the same database for the frozen Python controller without starting any adapters. */
export async function preparePythonRollback(env:NodeJS.ProcessEnv) {
  const data=env.SUPERAGENT_DATA_DIR;
  if(!data || !isAbsolute(data)) throw new Error('请选择已有的绝对数据目录 SUPERAGENT_DATA_DIR');
  const root=realpathSync(data),path=join(root,'superagent.db');
  if(!lstatSync(path).isFile()) throw new Error('数据目录没有普通文件 superagent.db');
  const readonly=new DatabaseSync(path,{readOnly:true});
  const snapshots=join(root,'rollback-backups'),file=join(snapshots,randomUUID()+'.db');
  try {
    const lease=readonly.prepare("SELECT expires_at FROM controller_leases WHERE id='controller'").get();
    if(lease && Date.parse(String(lease.expires_at))>Date.now())
      throw new Error('原控制器的租约仍有效，请停止服务并等待租约到期');
    if(readonly.prepare('PRAGMA quick_check').get()?.quick_check!=='ok') throw new Error('数据库完整性检查失败');
    mkdirSync(snapshots,{recursive:true});
    if(realpathSync(snapshots)!==snapshots) throw new Error('备份目录不能指向其他位置');
    await backup(readonly,file);
  } finally { readonly.close(); }
  const copy=new DatabaseSync(file,{readOnly:true});
  try {
    if(copy.prepare('PRAGMA integrity_check').get()?.integrity_check!=='ok') throw new Error('备份完整性检查失败');
  } finally { copy.close(); }
  const store=openStorage(path,{stateRoot:root});
  try {
    const {lease,recovery}=store.startController(randomUUID());
    createWorkbenchScheduler(store.db,{lease,stateRoot:root,env,pollMs:0}).recoverOnly();
    store.sweepDeliveries(lease);
    const unfinished=store.db.prepare(`SELECT EXISTS(SELECT 1 FROM workbench_model_runs WHERE status='running')
      OR EXISTS(SELECT 1 FROM conversation_bridge_operations WHERE status='pending')
      OR EXISTS(SELECT 1 FROM execution_attempts WHERE status IN ('claimed','running','waiting_approval'))
      OR EXISTS(SELECT 1 FROM delivery_records WHERE json_extract(result,'$.write_status') IN ('claimed','dispatching')) AS present`).get();
    if(unfinished?.present) throw new Error('仍有未完成恢复的派发记录，请先核验备份和主库');
    const deliveryIds=store.db.prepare("SELECT action_id FROM delivery_records WHERE json_extract(result,'$.write_status')='unknown' ORDER BY action_id")
      .all().map(row=>row.action_id);
    const tasks=store.db.prepare('SELECT id FROM tasks WHERE outcome_unknown ORDER BY id').all().map(row=>row.id);
    const approvals=store.db.prepare("SELECT id FROM approvals WHERE status='unknown' ORDER BY id").all().map(row=>row.id);
    const models=store.db.prepare("SELECT id FROM workbench_model_runs WHERE status='unknown' ORDER BY id").all().map(row=>row.id);
    const bridge=store.db.prepare("SELECT id FROM conversation_bridge_operations WHERE status='unknown' ORDER BY id").all().map(row=>row.id);
    return {prepared:true,database:path,backup:file,recovery,unknown_delivery_ids:deliveryIds,unknown_task_ids:tasks,
      unknown_approval_ids:approvals,unknown_model_run_ids:models,unknown_bridge_operation_ids:bridge};
  } finally { store.close(); }
}
