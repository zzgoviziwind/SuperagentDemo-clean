import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { ZodError } from 'zod';
import { openStorage, StorageConflict } from '../../../packages/storage/src/index.ts';
import { registerAuth } from './auth.js';
import { fenceHostWrites } from './lease.js';
import { registerSettings } from './settings.js';
import { registerProjects } from './projects.js';
import { registerIntake } from './intake.js';
import { registerContext } from './context.js';
import { registerBudget } from './budget.js';
import { registerBrowse } from './browse.js';
import { registerNodes } from './nodes.js';
import { registerRules } from './rules.js';
import { registerControls } from './controls.js';
import { registerDeliveries } from './deliveries/index.ts';
import { registerWorker } from './worker/index.ts';
import { registerField } from './field/index.ts';
import { createWorkbenchScheduler, registerWorkbench } from './workbench/index.ts';
import { workbenchRuntime } from './workbench/runtime.ts';

export async function buildServer(env: NodeJS.ProcessEnv) {
  const data = env.SUPERAGENT_DATA_DIR;
  if (!data || !isAbsolute(data)) throw new Error('请设置独立的绝对数据目录 SUPERAGENT_DATA_DIR');
  mkdirSync(data, { recursive: true });
  const root = realpathSync(data);
  const app = Fastify({logger:false,bodyLimit:1024*1024,exposeHeadRoutes:false});
  const store = openStorage(join(root,'superagent.db'), {stateRoot:root});
  try {
    const {lease} = store.startController(randomUUID());
    const heartbeat = setInterval(() => {
      try { store.renewLease(lease); store.sweepDeliveries(lease); }
      catch { void app.close(); }
    }, 10_000);
    heartbeat.unref();
    app.addHook('onClose', async () => { clearInterval(heartbeat); store.close(); });
    app.setErrorHandler((error,req,reply) => {
      const status = error instanceof ZodError ? 422 : error instanceof StorageConflict ? 409 :
        (typeof error === 'object' && error !== null && 'statusCode' in error ? Number(error.statusCode) : 500);
      const safe = Number.isInteger(status) && status >= 400 && status < 600 ? status : 500;
      const detail = error instanceof ZodError ? '请求字段缺失、类型或取值无效' :
        (safe < 500 && error instanceof Error ? error.message : '服务无法处理请求');
      reply.code(safe).send({detail});
    });
    registerAuth(app,env);
    app.addHook('preHandler',async req=>{
      if(!['GET','HEAD','OPTIONS'].includes(req.method)) checkLease();
    });
    app.get('/health',async () => ({status:'ok',version:'0.2.0-dev.1',implementation:'typescript'}));
    registerSettings(app,store.db,env);
    registerProjects(app,store.db,env);
    registerContext(app,store.db);
    registerBudget(app,store.db);
    registerBrowse(app,env);
    registerNodes(app,store.db,env);
    registerRules(app,store.db);
    const worker = registerWorker(app,store,lease,root,env);
    registerIntake(app,store.db,env,worker);
    registerControls(app,store.db,worker);
    registerDeliveries(app,store,lease,root,env);
    registerField(app,store,root,env);
    const scheduler=createWorkbenchScheduler(store.db,{lease,stateRoot:root,env,ports:workbenchRuntime(app)});
    registerWorkbench(app,store.db,scheduler);
    let checkLease:()=>void;
    app.addHook('onReady',async()=>{checkLease=fenceHostWrites(store.db,lease);});
    if (env.SUPERAGENT_WEB_DIST) {
      await app.register(fastifyStatic,{root:realpathSync(env.SUPERAGENT_WEB_DIST),index:'index.html',dotfiles:'deny'});
    }
    await app.ready();
    return app;
  } catch (error) {
    await app.close().catch(() => {});
    try { store.close(); } catch { /* registration may already have closed the connection */ }
    throw error;
  }
}
