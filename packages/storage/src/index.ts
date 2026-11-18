import { Core, nonempty } from './core.ts';
import type { Options } from './core.ts';
import { approvals } from './approvals.ts';
import { controller } from './controller.ts';
import { delivery } from './delivery.ts';
import { execution } from './execution.ts';

export { actionHash, StorageConflict } from './core.ts';
export type { Attempt, Task, Fields, Json, Lease, Options, WorkerMethod } from './core.ts';
export type { WorkerRequest, ApprovalRow, Decision, WorkerDecision } from './approvals.ts';
export type { DeliveryPlan, DeliveryPolicy, DeliveryPolicyInput, Claim } from './delivery.ts';
export type { ArtifactInput, Turn } from './execution.ts';

export function openStorage(path: string, options: Options = {}) {
  nonempty(path, 'SQLite 文件路径');
  const c = new Core(path, options);
  return { db: c.db, ...controller(c, path, options), ...execution(c), ...approvals(c), ...delivery(c) };
}
export type Storage = ReturnType<typeof openStorage>;
