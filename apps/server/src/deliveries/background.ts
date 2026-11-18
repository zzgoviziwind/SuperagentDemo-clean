import type { FastifyInstance } from 'fastify';
import type { Lease, Storage } from '../../../../packages/storage/index.ts';

export function checkController(store:Storage,lease:Lease,signal:AbortSignal) {
  signal.throwIfAborted();
  const row=store.db.prepare("SELECT expires_at FROM controller_leases WHERE id='controller' AND owner=? AND epoch=?").get(lease.owner,lease.epoch);
  if(!row || Date.parse(String(row.expires_at))<=Date.now()) throw new Error('控制器租约已过期');
}

export function background(app:FastifyInstance,name:string,tick:(signal:AbortSignal)=>Promise<void>,interval=500) {
  const lifetime=new AbortController();
  let timer:ReturnType<typeof setTimeout>|undefined,active:Promise<void>|undefined;
  let backoff=interval;
  function schedule(ms:number) {
    if(lifetime.signal.aborted) return;
    timer=setTimeout(()=>{
      active=Promise.resolve().then(()=>tick(lifetime.signal)).then(()=>{backoff=interval;},()=>{
        if(!lifetime.signal.aborted) app.log.warn({job:name},'后台操作未确认');
        backoff=Math.min(30000,backoff*2);
      }).finally(()=>schedule(backoff));
    },ms);
    timer.unref();
  }
  app.addHook('onReady',async()=>schedule(0));
  app.addHook('preClose',async()=>{
    lifetime.abort();clearTimeout(timer);
    if(!active) return;
    let timeout:ReturnType<typeof setTimeout>|undefined;
    try{await Promise.race([active,new Promise<void>(r=>{timeout=setTimeout(r,2500);})]);}
    finally{clearTimeout(timeout);}
  });
}
