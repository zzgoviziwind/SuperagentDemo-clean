import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { registerBridge } from './bridge.ts';
import { registerEventGroups } from './event-groups.ts';
import { registerEventStream } from './event-stream.ts';
import { registerReceipts } from './receipts.ts';
import { registerSessions } from './sessions.ts';
import { postSessionMessage, reconcileSession } from './session-writes.ts';
import { fields, WorkbenchStore } from './store.ts';
import { registerTasks } from './tasks.ts';
import { registerWatchdog } from './watchdog.ts';
import { configureWorkbenchRuntime, type WorkbenchRuntime } from './runtime.ts';
import { registerPromptCatalog, type PromptCatalog } from './prompts.ts';
import type { WorkbenchScheduler } from './scheduler.ts';

export { codexThreadReader, configureWorkbenchRuntime } from './runtime.ts';
export type { DingTalkHistoryBinding, DingTalkHistoryPage, SemanticDecision, SessionBinding, WorkbenchRuntime } from './runtime.ts';
export { createWorkbenchScheduler, enqueueSemanticReceipt } from './scheduler.ts';
export type { WorkbenchScheduler, WorkbenchSchedulerOptions } from './scheduler.ts';
export type { PromptCatalog, WorkerPromptKind } from './prompts.ts';
export type { WorkbenchModelClient, WorkbenchModelDriver, WorkbenchModelKind } from './model-driver.ts';

export function registerWorkbench(app: FastifyInstance, db: DatabaseSync, runtime?: WorkbenchRuntime | WorkbenchScheduler,
  workerPrompts?: () => PromptCatalog): void {
  const store = new WorkbenchStore(db);
  if (runtime) configureWorkbenchRuntime(app, runtime);
  const scheduler = runtime && 'start' in runtime ? runtime : undefined;
  if (scheduler) {
    app.addHook('onReady', async () => scheduler.start());
    app.addHook('preClose', async () => scheduler.close());
  }
  registerTasks(app, store);
  registerPromptCatalog(app, workerPrompts ?? scheduler?.workerPrompts);
  registerEventGroups(app, store);
  registerSessions(app, store);
  app.post<{ Params: { id: string } }>('/api/v1/sessions/:id/messages',
    request => postSessionMessage(app, store, request, request.params.id, fields(request.body)));
  app.post<{ Params: { id: string } }>('/api/v1/sessions/:id/reconcile',
    request => reconcileSession(app, store, request, request.params.id, fields(request.body)));
  registerReceipts(app, store);
  registerEventStream(app, store);
  registerWatchdog(app, store);
  registerBridge(app, store);
}
