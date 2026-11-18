import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { inspect } from 'node:util';

const [entry, mode] = process.argv.slice(2);
const { FakeCodex, FakeChannel, ChannelOutcomeUnknown, CodexUnknownOutcome,
  collectFakeTurnEvidence } = await import(pathToFileURL(entry).href);
const marker = 'synthetic-review-marker';

if (mode.startsWith('channel-')) {
  const channel = await FakeChannel.open(process.cwd());
  const delivery = { actionId: 'action-review', actionHash: 'hash-review',
    target: { source: 'fake', threadId: 'thread-review' }, content: '合成回复' };
  let issued = 0;
  const dispatch = async () => {
    issued++;
    return channel.send(delivery, step => {
      if (step === 'after_receipt') throw new Error('synthetic adapter error ' + marker);
    });
  };
  let failure;
  await assert.rejects(dispatch, error => {
    failure = error;
    return error instanceof ChannelOutcomeUnknown;
  });
  const receipts = await (await FakeChannel.open(process.cwd())).receipts();
  assert.equal(issued, 1);
  assert.equal(receipts.length, 1);
  const [receipt] = receipts;
  assert.deepEqual(receipt.target, delivery.target);
  assert.equal(receipt.actionId, delivery.actionId);
  assert.equal(receipt.actionHash, delivery.actionHash);
  assert.equal(JSON.stringify(receipts).includes(marker), false);
  if (mode === 'channel-error') {
    assert.equal(inspect(failure).includes(marker), false, 'public Error inspection contains fixture marker');
  }
} else {
  const client = await FakeCodex.start({ cwd: process.cwd(),
    timeoutMs: mode === 'timeout' ? 1700 : 5000 });
  try {
    if (mode.startsWith('tree-')) {
      writeFileSync('driver-ready', String(client.pid));
      const deadline = Date.now() + 8000;
      while (!existsSync('go') && Date.now() < deadline) await delay(20);
      assert.ok(existsSync('go'), 'observer never armed');
      if (mode.endsWith('-owner')) process.exit(34);
      await client.close();
      writeFileSync('closed', 'closed');
      // The service remains alive while the independent observer checks descendants.
      const checkDeadline = Date.now() + 8000;
      while (!existsSync('observer-done') && Date.now() < checkDeadline) await delay(20);
      assert.ok(existsSync('observer-done'), 'observer did not finish');
    } else if (mode === 'argv' || mode === 'environment') {
      const observed = JSON.parse(readFileSync('observed.json', 'utf8'));
      assert.deepEqual(observed.inherited, []);
      assert.equal(observed.isolatedEnvironment, true);
      if (mode === 'argv') {
        await client.startTurn(await client.startThread(), 'synthetic prompt ' + marker);
        assert.equal(observed.markerInArgv, false, 'fixture marker present in process argv');
      }
    } else if (mode === 'thread-uncertain') {
      let failure;
      try { await client.startThread(); } catch (error) { failure = error; }
      assert.deepEqual(readFileSync('threads-created', 'utf8').trim().split('\n'), ['created']);
      assert.ok(failure instanceof CodexUnknownOutcome, 'thread created, unusable acknowledgement must be unknown');
    } else {
      const thread = await client.startThread();
      if (mode === 'eof' || mode === 'timeout') {
        await assert.rejects(client.startTurn(thread, 'fixture'), CodexUnknownOutcome);
        const events = [];
        for await (const event of client.events()) events.push(event);
        assert.ok(events.some(e => e.method === 'runtime/disconnected'));
        assert.ok(!events.some(e => e.method === 'turn/completed'));
        await assert.rejects(client.startTurn(thread, 'synthetic follow-up'), /closed/);
      } else {
        const binding = await client.startTurn(thread, 'fixture');
        const events = [];
        await client.close();
        for await (const event of client.events()) events.push(event);
        assert.equal(collectFakeTurnEvidence(binding, events).completion, 'completed');
        assert.equal(JSON.stringify(events).includes(marker), false);
      }
      assert.deepEqual(readFileSync('received', 'utf8').trim().split('\n'), ['accepted']);
    }
  } finally {
    await client.close();
  }
}
