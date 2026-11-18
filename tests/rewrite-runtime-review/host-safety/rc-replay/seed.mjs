// Run against the extracted 30bceac storage sources, without loading the candidate.
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [source, work] = process.argv.slice(2);
const { openStorage } = await import(pathToFileURL(join(source, 'index.ts')));
const { seed, live, request, allow, draftFor } = await import(pathToFileURL(join(source, 'tests/helpers.ts')));
const time = Date.parse('2026-01-01T00:00:00Z');
const s = openStorage(join(work, 'superagent.db'), { stateRoot: work, clock: () => time });
const lease = s.startController('synthetic-stopped-controller').lease;
const task = seed(s);
const draft = draftFor(s, task);
s.decideDraft(draft.draftId, 'approve', draft.actionHash);
s.markDispatching(lease, s.claimDelivery(lease, draft.draftId, draft.actionHash, allow), allow);
const attempt = live({ s, lease, task });
const approval = s.requestWorkerApproval(lease, attempt, request);
s.dispatchWorkerDecision(lease, attempt, approval.id, {
  actor: 'owner', actionHash: approval.action_hash, decision: 'approve', authorize: () => true,
});
const insert = s.db.prepare(`INSERT INTO conversation_bridge_operations
  (actor_id,request_key,payload_hash,status,result,created_at,updated_at)
  VALUES ('admin',?,'fixture',?,?,?,?)`);
const stamp = new Date(time).toISOString();
insert.run('recovery-sample', 'pending', null, stamp, stamp);
insert.run('completed-control', 'completed', '{"sample":true}', stamp, stamp);
// No tool or channel is invoked. Leave both recorded dispatch intents without a receipt.
process.exit(73);
