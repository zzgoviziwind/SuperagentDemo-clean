import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { ChannelOutcomeUnknown, CodexUnknownOutcome, FakeChannel, FakeCodex, collectFakeTurnEvidence } from '../index.ts';
import type { CodexEvent, DeliveryCheckpoint, FakeCodexOptions, FakeDelivery, TurnBinding } from '../index.ts';
import { offlineEnvironment } from '../fixtures/environment.ts';

const sender = fileURLToPath(new URL('../fixtures/fake-channel-sender.ts', import.meta.url));
const runFile = promisify(execFile);
const delivery: FakeDelivery = {
  actionId: 'action-1', actionHash: 'synthetic-hash', target: { source: 'fake', threadId: '原会话', messageId: '原来信' },
  content: '离线回复',
};

async function makeTemporary() {
  const parent = await realpath(tmpdir());
  return mkdtemp(join(parent, 'superagent-runtime-中文 空格-'));
}

async function temporary(t: TestContext) {
  const directory = await makeTemporary();
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function start(t: TestContext, options: Omit<FakeCodexOptions, 'cwd'> = {}) {
  const cwd = await makeTemporary();
  let running: FakeCodex | undefined;
  t.after(async () => {
    try {
      await running?.close();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
  const client = await FakeCodex.start({ cwd, ...options });
  running = client;
  assert.ok(client.pid > 0 && client.pid !== process.pid);
  return client;
}

async function untilTerminal(stream: AsyncIterable<CodexEvent>) {
  const captured: CodexEvent[] = [];
  for await (const event of stream) {
    captured.push(event);
    if (event.method === 'turn/completed' || event.method === 'runtime/disconnected') break;
  }
  return captured;
}

test('real child handshake, scoped evidence, normal exit', { timeout: 15_000 }, async (t) => {
  const names = ['SUPERAGENT_TEST_CHANNEL_CREDENTIAL', 'SUPERAGENT_TEST_DATABASE_CREDENTIAL', 'SUPERAGENT_TEST_MODEL_CREDENTIAL'];
  const previous = names.map((name) => process.env[name]);
  t.after(() => {
    for (const [index, name] of names.entries()) {
      if (previous[index] === undefined) delete process.env[name];
      else process.env[name] = previous[index];
    }
  });
  for (const name of names) process.env[name] = 'synthetic-parent-environment-marker';
  const client = await start(t);
  const thread = await client.startThread();
  const binding = await client.startTurn(thread, '离线合成输入');
  const trace = await untilTerminal(client.events());
  assert.deepEqual(trace.map(({ method }) => method), ['turn/started', 'item/completed', 'turn/completed']);
  const evidence = collectFakeTurnEvidence(binding, [
    { method: 'item/completed', params: { ...binding, threadId: 'unrelated' } },
    { method: 'turn/completed', params: { threadId: binding.threadId, turn: { id: 'stale', status: 'failed' } } },
    ...trace,
  ]);
  assert.equal(evidence.source, 'offline-codex-fixture');
  assert.equal(evidence.completion, 'completed');
  assert.equal(evidence.disconnectedBeforeCompletion, false);
  assert.deepEqual(evidence.observations, trace);
  await client.close();
  assert.deepEqual(await client.exited, { code: 0, signal: null });
});

test('sole approval must match thread and turn and can be answered only once', { timeout: 15_000 }, async (t) => {
  const client = await start(t, { scenario: 'approval' });
  const binding = await client.startTurn(await client.startThread(), '等待审批');
  const [approval, trace] = await respondAndTrace(client, 'item/commandExecution/requestApproval', async (id) => {
    await assert.rejects(client.respondApproval(id, { ...binding, turnId: 'stale' }, 'approve'), /active turn/);
    await client.respondApproval(id, binding, 'approve');
    await assert.rejects(client.respondApproval(id, binding, 'approve'), /active turn/);
  });
  assert.equal(approval.params.threadId, binding.threadId);
  assert.equal(collectFakeTurnEvidence(binding, trace).completion, 'completed');
});

test('analysis and repair report only synthetic tool and command observations', { timeout: 15_000 }, async (t) => {
  const analysis = await start(t, { scenario: 'analysis' });
  const analysisBinding = await analysis.startTurn(await analysis.startThread(), '只读分析');
  const [, analysisTrace] = await respondAndTrace(analysis, 'item/tool/call', async (id) => {
    await assert.rejects(analysis.respondReadTool(id, { ...analysisBinding, threadId: 'other' }, 'wrong'), /active turn/);
    await analysis.respondReadTool(id, analysisBinding, '合成内容');
  });
  assert.ok(hasSyntheticItem(analysisBinding, analysisTrace, 'dynamicToolCall'));

  const repair = await start(t, { scenario: 'repair' });
  const repairBinding = await repair.startTurn(await repair.startThread('workspace-write'), '修复');
  const repairTrace = await untilTerminal(repair.events());
  assert.ok(hasSyntheticItem(repairBinding, repairTrace, 'commandExecution'));
  assert.equal(collectFakeTurnEvidence(analysisBinding, repairTrace).completion, null);
});

test('child exits before the turn acknowledgement: the request is unknown', { timeout: 15_000 }, async (t) => {
  const client = await start(t, { exitAt: 'before_turn_response' });
  const thread = await client.startThread();
  await assert.rejects(client.startTurn(thread, '合成输入'), (error) =>
    error instanceof CodexUnknownOutcome && error.message === 'turn/start: process disconnected');
  assert.equal((await client.exited).code, 71);
  assert.deepEqual(await untilTerminal(client.events()), [{
    method: 'runtime/disconnected', params: { reason: 'process disconnected', code: 71, signal: null },
  }]);
});

test('child exits after acknowledging a turn, without completing it', { timeout: 15_000 }, async (t) => {
  const client = await start(t, { exitAt: 'after_turn_response' });
  const binding = await client.startTurn(await client.startThread(), '合成输入');
  const evidence = collectFakeTurnEvidence(binding, await untilTerminal(client.events()));
  assert.equal((await client.exited).code, 72);
  assert.equal(evidence.completion, null);
  assert.equal(evidence.disconnectedBeforeCompletion, true);
});

test('late turn acknowledgement is unknown and cannot satisfy a new request', { timeout: 15_000 }, async (t) => {
  const client = await start(t, { timeoutMs: 3_000, turnResponseDelayMs: 8_000 });
  const thread = await client.startThread();
  await assert.rejects(client.startTurn(thread, '延迟回执'), { name: 'CodexUnknownOutcome', message: /timed out/ });
  await assert.rejects(client.startTurn(thread, '再次请求'), /closed/);
  await client.exited;
  assert.deepEqual(await untilTerminal(client.events()), [{ method: 'runtime/disconnected', params: { reason: 'request timeout' } }]);
});

test('child exits after reading the approval and before reporting a terminal result', { timeout: 15_000 }, async (t) => {
  const client = await start(t, { scenario: 'approval', exitAt: 'after_approval_response' });
  const binding = await client.startTurn(await client.startThread(), '合成输入');
  const [approval, trace] = await respondAndTrace(client, 'item/commandExecution/requestApproval', (id) => {
    return client.respondApproval(id, binding, 'reject');
  });
  assert.equal((await client.exited).code, 73);
  assert.equal(collectFakeTurnEvidence(binding, trace).disconnectedBeforeCompletion, true);
  const restarted = await start(t, { scenario: 'approval' });
  await assert.rejects(restarted.respondApproval(approval.id!, binding, 'approve'), /active turn/);
});

test('send receipt survives both process exit and reopening; repeated writes remain observable', { timeout: 15_000 }, async (t) => {
  const root = await temporary(t);
  const args = [sender, root, JSON.stringify(delivery)];
  const first = await runFile(process.execPath, args, { cwd: root, env: offlineEnvironment(root), timeout: 5_000, windowsHide: true });
  const external = await FakeChannel.open(root);
  assert.deepEqual(await external.receipts(), [JSON.parse(first.stdout)]);
  assert.match(first.stdout, /离线回复/);
  const second = await external.send(delivery);
  assert.notEqual(second.id, JSON.parse(first.stdout).id);
  assert.equal((await (await FakeChannel.open(root)).receipts()).length, 2);
});

for (const [point, code, count] of [
  ['before_receipt', 81, 0], ['after_receipt', 82, 1],
] as const satisfies readonly [DeliveryCheckpoint, number, number][]) {
  test(`hard exit at ${point} leaves ${count} published receipts`, { timeout: 15_000 }, async (t) => {
    const root = await temporary(t);
    await assert.rejects(runFile(process.execPath, [sender, root, JSON.stringify(delivery), point], {
      cwd: root, env: offlineEnvironment(root), timeout: 5_000, windowsHide: true,
    }), { code, stdout: '', stderr: '' });
    const receipts = await (await FakeChannel.open(root)).receipts();
    assert.equal(receipts.length, count);
    if (count) assert.deepEqual(receipts[0]?.target, delivery.target);
  });
}

test('receipt exists even when confirmation fails', { timeout: 15_000 }, async (t) => {
  const external = await FakeChannel.open(await temporary(t));
  await assert.rejects(external.send(delivery, (point) => {
    if (point === 'after_receipt') throw new Error('synthetic transport timeout');
  }), (error) => error instanceof ChannelOutcomeUnknown && error.cause === undefined);
  const [receipt, ...extras] = await external.receipts();
  assert.equal(extras.length, 0);
  assert.equal(receipt?.actionId, delivery.actionId);
  assert.equal(receipt?.actionHash, delivery.actionHash);
  assert.equal(receipt?.content, delivery.content);
});

async function respondAndTrace(
  client: FakeCodex,
  method: string,
  respond: (id: string | number) => Promise<void>,
): Promise<[CodexEvent, CodexEvent[]]> {
  const trace: CodexEvent[] = [];
  let request: CodexEvent | undefined;
  for await (const event of client.events()) {
    trace.push(event);
    if (event.method === method && event.id !== undefined) {
      request = event;
      await respond(event.id);
    }
    if (event.method === 'turn/completed' || event.method === 'runtime/disconnected') break;
  }
  assert.ok(request);
  return [request, trace];
}

function hasSyntheticItem(binding: TurnBinding, trace: CodexEvent[], type: string): boolean {
  return collectFakeTurnEvidence(binding, trace).observations.some((event) => {
    const item = event.params.item as { type?: string; simulated?: boolean } | undefined;
    return event.method === 'item/completed' && item?.type === type && item.simulated === true;
  });
}
