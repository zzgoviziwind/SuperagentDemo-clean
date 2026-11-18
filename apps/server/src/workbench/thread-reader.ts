import { realpath, stat, mkdir } from 'node:fs/promises';
import { extname, isAbsolute, join, relative } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Readable } from 'node:stream';
import type { DatabaseSync } from 'node:sqlite';
import { spawnOwned, type OwnedProcess } from '@superagent/windows-job';
import { offlineEnvironment } from '../../../../packages/runtime/fixtures/environment.ts';
import { pinnedSelection } from '../worker/local-agents.js';
import { codexThreadReader } from './runtime.ts';
import { fields } from './store.ts';

const frameLimit = 4 * 1024 * 1024;

async function* frames(source: Readable) {
  let buffer = Buffer.alloc(0);
  for await (const incoming of source) {
    const chunk = Buffer.isBuffer(incoming) ? incoming : Buffer.from(incoming);
    buffer = Buffer.concat([buffer, chunk]);
    let split: number;
    while ((split = buffer.indexOf(10)) >= 0) {
      const line = buffer.subarray(0, split);
      buffer = buffer.subarray(split + 1);
      if (line.length > frameLimit) throw new Error('Codex 历史帧过大');
      if (line.length) yield fields(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line)));
    }
    if (buffer.length > frameLimit) throw new Error('Codex 历史帧过大');
  }
}

/** A dedicated peer accepts exactly initialize and thread/read. It cannot issue a model turn. */
export async function readCodexThread(launch: () => Promise<OwnedProcess>, threadId: string, signal: AbortSignal): Promise<unknown> {
  signal.throwIfAborted();
  const peer = await launch();
  const child = peer.child;
  const closed = new Promise<boolean>(resolve => {
    child.once('close', (code, by) => resolve(code !== null && code !== 125 && by === null));
  });
  const terminate = () => { try { peer.terminate(); } catch { /* tree exit is checked separately */ } };
  const reader = frames(child.stdout);
  const onStreamError = () => terminate();
  child.stdin.on('error', onStreamError);
  child.on('error', onStreamError);
  child.stderr.resume();
  let rejectAbort: (error: unknown) => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  void aborted.catch(() => {});
  const abort = () => { terminate(); rejectAbort(new Error('Codex 历史读取超时')); };
  signal.addEventListener('abort', abort, { once: true });
  const send = (packet: object) => child.stdin.write(JSON.stringify(packet) + '\n');
  async function response(id: number) {
    for (let i = 0; i < 128; i++) {
      const packet = await Promise.race([reader.next(), aborted]);
      if (packet.done) throw new Error('Codex 历史连接已关闭');
      const row = packet.value;
      if (row.method !== undefined && row.id !== undefined) throw new Error('历史进程请求了交互操作');
      if (row.id === undefined) continue;
      if (row.id !== id || row.error !== undefined || row.result === undefined) throw new Error('Codex 历史响应未确认');
      return row.result;
    }
    throw new Error('Codex 历史响应超出帧数上限');
  }
  let result: unknown;
  let exited = false;
  try {
    signal.throwIfAborted();
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'superagent-transcript', version: '1' },
      capabilities: { experimentalApi: true } } });
    await response(1);
    send({ method: 'initialized', params: {} });
    send({ id: 2, method: 'thread/read', params: { threadId, includeTurns: true } });
    result = await response(2);
  } finally {
    signal.removeEventListener('abort', abort);
    child.stdin.end();
    const quick = await Promise.race([closed, delay(500, false, { ref: false })]);
    if (quick) exited = true;
    else {
      terminate();
      exited = await Promise.race([closed, delay(2000, false, { ref: false })]);
    }
    child.stdout.destroy();
    void reader.return(undefined).catch(() => {});
  }
  const thread = fields(fields(result).thread ?? result);
  if (!exited || thread.id !== threadId || !Array.isArray(thread.turns)) throw new Error('未核对 Codex 历史及其进程退出');
  return { thread };
}

export function localThreadReader(db: DatabaseSync, stateRoot: string) {
  return codexThreadReader(async (binding, _method, { threadId }, signal) => {
    const pinned = pinnedSelection(db);
    if (!pinned || !['chatgpt', 'api_key'].includes(pinned.auth_type) || !isAbsolute(pinned.executable)
      || !isAbsolute(pinned.home)) throw new Error('尚未配置受信本机 Codex');
    if (binding.kind === 'worker' && db.prepare(`SELECT 1 FROM tasks t JOIN project_execution_nodes n ON n.project_id=t.project_id
      WHERE t.id=? AND n.node_id IS NOT NULL`).get(binding.id)) throw new Error('远端 Worker 当前无历史读取连接');
    const [root, executable, account] = await Promise.all([realpath(stateRoot), realpath(pinned.executable), realpath(pinned.home)]);
    if (executable !== pinned.executable || account !== pinned.home || !(await stat(executable)).isFile()
      || !(await stat(account)).isDirectory() || (process.platform === 'win32' && extname(executable).toLowerCase() !== '.exe')) {
      throw new Error('本机 Codex 或账号目录与受信配置不符');
    }
    const path = join(root, 'workbench-transcript');
    await mkdir(path, { recursive: true });
    const cwd = await realpath(path);
    const rel = relative(root, cwd);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('历史读取目录越界');
    return readCodexThread(() => spawnOwned(executable, ['app-server', '--disable', 'plugins', '--disable', 'apps',
      '--disable', 'remote_plugin', '--disable', 'hooks', '--disable', 'plugin_discovery_prefetch', '-c', 'mcp_servers={}',
      '-c', 'approval_policy="never"', '-c', 'sandbox_mode="read-only"',
      '-c', 'sandbox_workspace_write.network_access=false'], { cwd, env: { ...offlineEnvironment(cwd), CODEX_HOME: account } }),
    threadId, signal);
  });
}
