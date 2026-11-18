import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { openStorage } from '../index.ts';
import { seed, draftFor, allow, turn } from './helpers.ts';

const [mode,path,dir] = process.argv.slice(2);
const s = openStorage(path, mode === 'race' ? {clock: () => Date.UTC(2026,10,18)} : {});
if (mode === 'race') {
  process.send!('ready');
  process.once('message', (lease: {owner:string;epoch:number}) => {
    const id = s.claimTask(lease,1)?.id ?? null;
    s.close();
    process.send!({id}, () => process.disconnect!());
  });
} else {
  const { lease } = s.startController('crashed');
  const task = seed(s);
  const id = s.claimTask(lease,task)!.id;
  s.beginAttempt(lease,id);
  s.recordThread(lease,id,turn.threadId);
  if (mode !== 'thread') s.prepareTurn(lease,id,[]);
  const draft = draftFor(s,task);
  s.decideDraft(draft.draftId,'approve',draft.actionHash);
  const claim = s.claimDelivery(lease,draft.draftId,draft.actionHash,allow)!;
  if (mode === 'sent') {
    s.markDispatching(lease,claim,allow);
    appendFileSync(join(dir,'独立收件.txt'), claim.actionId + '\n');
  }
  process.send!({task,id,draft,claim});
  setInterval(() => {},60000); // Parent kills this process with database and local lock open.
}
