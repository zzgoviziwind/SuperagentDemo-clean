import type { DatabaseSync } from 'node:sqlite';
import { StorageConflict, type Lease } from '../../../packages/storage/src/index.ts';

/** Guard writes on this connection, including async continuations after an ownership change. */
export function fenceHostWrites(db:DatabaseSync,lease:Lease) {
  db.exec('CREATE TEMP TABLE host_lease(owner TEXT, epoch INTEGER)');
  db.prepare('INSERT INTO host_lease VALUES(?,?)').run(lease.owner,lease.epoch);
  const valid=`SELECT 1 FROM main.controller_leases c JOIN host_lease h
    ON h.owner=c.owner AND h.epoch=c.epoch WHERE c.id='controller' AND julianday(c.expires_at)>julianday('now')`;
  const tables=db.prepare("SELECT name FROM main.sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name!='controller_leases'").all();
  const quote=(name:string)=>'"'+name.replaceAll('"','""')+'"';
  for(const {name} of tables) {
    for(const action of ['INSERT','UPDATE','DELETE']) {
      db.exec('CREATE TEMP TRIGGER '+quote('fence_'+name+'_'+action)+' BEFORE '+action+' ON main.'+quote(String(name))
        +' WHEN NOT EXISTS('+valid+") BEGIN SELECT RAISE(ABORT,'controller lease lost'); END");
    }
  }
  const check=db.prepare(valid);
  return ()=>{if(!check.get()) throw new StorageConflict('控制器租约已失效');};
}
