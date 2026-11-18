import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openStorage } from '../index.ts';
import { allow, draftFor, request, seed, turn } from './helpers.ts';

// rollback_http.py runs both modes as separate processes inside its new temporary directory.
const mode = process.argv[2];
assert.ok(mode === 'interrupt' || mode === 'prepare');
const dir = process.cwd(), db = join(dir, 'service.db');
const store = openStorage(db, mode === 'interrupt' ? {clock: () => Date.now() - 60000} : {});
if (mode === 'interrupt') {
  const {lease} = store.startController('offline-worker');
  const task = seed(store), attempt = store.claimTask(lease, task)!.id;
  store.beginAttempt(lease, attempt);
  store.recordWorkspace(lease, attempt, dir, null);
  store.recordThread(lease, attempt, turn.threadId);
  store.prepareTurn(lease, attempt);
  store.bindTurn(lease, attempt, turn);
  for (const [requestId, decision] of [[1, 'approve'], [2, 'reject'], [3, null], [4, 'approve']] as const) {
    const approval = store.requestWorkerApproval(lease, attempt, {...request, requestId});
    if (decision === null) continue;
    store.dispatchWorkerDecision(lease, attempt, approval.id, {
      decision, actor:'offline-admin', actionHash:approval.action_hash, authorize:() => true,
    });
    if (requestId !== 4) store.finishWorkerDecision(lease, attempt, approval.id, 'confirmed');
  }
  const draft = draftFor(store, task);
  store.decideDraft(draft.draftId, 'approve', draft.actionHash);
  const claim = store.claimDelivery(lease, draft.draftId, draft.actionHash, allow)!;
  store.markDispatching(lease, claim, allow);
  writeFileSync(join(dir, 'receipt.txt'), claim.actionId + '\n', {flag:'wx'});
  process.exit(73);
}
try {
  const {lease, recovery} = store.startController('offline-handoff');
  const sweep = store.sweepDeliveries(lease);
  process.stdout.write(JSON.stringify({recovery, sweep}) + '\n');
} finally {
  store.close();
}
