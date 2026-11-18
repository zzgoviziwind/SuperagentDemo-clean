import { randomUUID } from 'node:crypto';
import { appendFile, lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import { join, parse, relative } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';

interface FixtureOptions {
  scenario: 'reply' | 'analysis' | 'repair' | 'approval';
  exitAt?: 'before_turn_response' | 'after_turn_response' | 'after_approval_response';
  turnResponseDelayMs: number;
  repairFixture?: boolean;
  persistThreads?: boolean;
  holdForSteer?: boolean;
  projectPath?: string;
  referenceFixturePath?: string;
}

interface Incoming {
  id?: number | string;
  method?: string;
  params?: { cwd?: string; sandbox?: string; threadId?: string; expectedTurnId?: string; input?: { type: string; text: string }[] };
  result?: { decision?: string; success?: boolean };
}

interface ActiveTurn {
  threadId: string;
  turnId: string;
}

const options = JSON.parse(process.argv[2]!) as FixtureOptions;
// Kept literal so this separately shipped fixture cannot be pointed at other files by argv.
const analysisFile = '合成输入.txt';
const repairFile = 'fixture-value.txt';
const repairBefore = 'before\n';
const repairAfter = 'after\n';
const threads = new Map<string, string>();
const waiting = new Map<string, ActiveTurn>();
let held: ActiveTurn | undefined;
const history = `${process.cwd()}.threads.ndjson`;
const repo = options.projectPath ?? '';
const analysisPath = options.referenceFixturePath ?? (repo ? `${repo}/${analysisFile}` : analysisFile);
if (repo && !/^[\p{L}\p{N}_-][\p{L}\p{N}_. -]*(?:\/[\p{L}\p{N}_-][\p{L}\p{N}_. -]*)*$/u.test(repo)) {
  throw new Error('Invalid fixture repository path');
}
let phase: 'new' | 'starting' | 'ready' = 'new';

function environmentIsOffline(): boolean {
  const keys = Object.fromEntries(Object.entries(process.env).map(([key, value]) => [key.toUpperCase(), value]));
  if (process.platform !== 'win32') return Object.keys(keys).length === 0;
  const cwd = process.cwd();
  const volume = parse(cwd).root;
  const expected = { USERPROFILE: cwd, HOMEDRIVE: volume.replace(/\\$/, ''), HOMEPATH: cwd.slice(volume.length - 1),
    TEMP: cwd, TMP: cwd, PATH: '', LOGONSERVER: 'offline', USERDOMAIN: 'offline', USERNAME: 'offline' };
  const system = ['SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR'];
  return Object.keys(keys).every(key => Object.hasOwn(expected, key) || system.includes(key))
    && Object.entries(expected).every(([key, value]) => keys[key] === value);
}

function send(message: object): Promise<void> {
  return new Promise((resolve, reject) => {
    process.stdout.write(`${JSON.stringify(message)}\n`, (error) => error ? reject(error) : resolve());
  });
}

function notify(method: string, params: object): Promise<void> {
  return send({ method, params });
}

async function finish(binding: ActiveTurn, status: 'completed' | 'failed', steered = false): Promise<void> {
  if (status === 'completed') {
    const summary = steered ? '离线样例结果（已确认补充）' : '离线样例结果';
    const name = options.scenario === 'analysis' ? analysisFile : repairFile;
    await notify('item/completed', {
      ...binding, item: { type: 'agentMessage', id: randomUUID(), text: options.projectPath !== undefined || options.referenceFixturePath
        ? JSON.stringify({ status: 'completed', summary, paths: [options.scenario === 'analysis' ? analysisPath : repo ? `${repo}/${name}` : name] }) : summary, simulated: true },
    });
  }
  await notify('turn/completed', { threadId: binding.threadId, turn: { id: binding.turnId, status } });
}

async function turn(message: Incoming, threadId: string): Promise<void> {
  const binding = { threadId, turnId: randomUUID() };
  if (options.exitAt === 'before_turn_response') {
    await new Promise<void>((resolve) => process.stderr.write('synthetic-fixture-diagnostic\n', () => resolve()));
    process.exit(71);
  }
  if (options.turnResponseDelayMs) await delay(options.turnResponseDelayMs);

  const pending = { id: binding.turnId, status: 'inProgress' };
  await send({ id: message.id, result: { turn: pending } });
  await notify('turn/started', { threadId, turn: pending });
  if (options.exitAt === 'after_turn_response') process.exit(72);
  if (options.holdForSteer) { held = binding; return; }

  if (options.scenario === 'approval' || options.scenario === 'analysis') {
    const id = randomUUID();
    waiting.set(id, binding);
    if (options.scenario === 'approval') {
      await send({ id, method: 'item/commandExecution/requestApproval', params: {
        ...binding, itemId: randomUUID(), command: 'fake-approval-command', cwd: process.cwd(),
        availableDecisions: ['accept', 'decline'],
      } });
    } else {
      await send({ id, method: 'item/tool/call', params: {
        ...binding, callId: randomUUID(), tool: 'read_file', arguments: { path: analysisPath },
      } });
    }
    return;
  }

  if (options.scenario === 'repair') {
    await notify('item/completed', {
      ...binding, item: { type: 'commandExecution', id: randomUUID(), cwd: process.cwd(),
        command: 'fake-test-command', status: 'completed', exitCode: 0, simulated: true },
    });
  }
  await finish(binding, 'completed');
}

async function dispatch(message: Incoming): Promise<void> {
  const { id, method, params, result } = message;
  if (method === 'initialize' && phase === 'new') {
    if (!environmentIsOffline()) throw new Error('Fixture environment is not isolated');
    phase = 'starting';
    await send({ id, result: { fixture: true, pid: process.pid } });
    return;
  }
  if (method === 'initialized' && phase === 'starting') {
    phase = 'ready';
    return;
  }
  if (phase === 'ready' && method === 'thread/start' && params?.cwd === process.cwd()
      && (params.sandbox === 'read-only' || params.sandbox === 'workspace-write')) {
    const threadId = randomUUID();
    threads.set(threadId, params.sandbox);
    if (options.persistThreads) await appendFile(history, `${JSON.stringify([threadId, params.sandbox])}\n`, 'utf8');
    await send({ id, result: { thread: { id: threadId, cwd: process.cwd() } } });
    return;
  }
  if (phase === 'ready' && method === 'thread/resume' && params?.cwd === process.cwd() && params.threadId && options.persistThreads) {
    const lines = (await readFile(history, 'utf8').catch(() => '')).split('\n').filter(Boolean);
    const entry = lines.map(line => JSON.parse(line) as string[]).find(([known]) => known === params.threadId);
    if (entry && entry[1] === params.sandbox) {
      threads.set(params.threadId, entry[1]);
      await send({ id, result: { thread: { id: params.threadId, cwd: process.cwd() } } });
      return;
    }
  }
  if (method === 'turn/steer' && held && params?.threadId === held.threadId && params.expectedTurnId === held.turnId
      && typeof params.input?.[0]?.text === 'string' && params.input[0].text.trim()) {
    const binding = held;
    held = undefined;
    await send({ id, result: { turnId: binding.turnId } });
    await finish(binding, 'completed', true);
    return;
  }
  if (phase === 'ready' && method === 'turn/start' && params?.threadId && threads.has(params.threadId)
      && params.input?.[0]?.type === 'text' && typeof params.input[0].text === 'string'
      && ![...waiting.values()].some((binding) => binding.threadId === params.threadId)) {
    await turn(message, params.threadId);
    return;
  }
  const binding = typeof id === 'string' ? waiting.get(id) : undefined;
  if (typeof id === 'string' && binding && !method && result) {
    waiting.delete(id);
    if (options.scenario === 'approval' && options.exitAt === 'after_approval_response') process.exit(73);
    if (options.scenario === 'approval') await notify('serverRequest/resolved', { ...binding, requestId: id });
    const success = options.scenario === 'approval' ? result.decision === 'accept' : result.success === true;
    if (options.scenario === 'approval' && options.repairFixture && success) {
      const file = join(process.cwd(), repo, repairFile);
      const info = await lstat(file);
      if (!info.isFile() || info.nlink !== 1 || relative(file, await realpath(file)) || await readFile(file, 'utf8') !== repairBefore) {
        await finish(binding, 'failed');
        return;
      }
      await writeFile(file, repairAfter, 'utf8');
    }
    if (options.scenario === 'analysis') {
      await notify('item/completed', { ...binding, item: {
        type: 'dynamicToolCall', id: randomUUID(), tool: 'read_file', success, simulated: true,
      } });
    }
    await finish(binding, success ? 'completed' : 'failed');
    return;
  }
  await send({ id, error: { code: -32602, message: 'Unsupported fixture request' } });
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  await dispatch(JSON.parse(line) as Incoming);
}
