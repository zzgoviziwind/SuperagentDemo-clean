import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { lstat, open, realpath, stat } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute } from 'node:path';
import { Readable } from 'node:stream';
import { TextDecoder } from 'node:util';
import { fileURLToPath } from 'node:url';
import { spawnOwned } from '@superagent/windows-job';
import { offlineEnvironment } from './fixtures/environment.ts';
import { readOnlyToolNames, readOnlyTools } from './readonly.ts';

type JsonObject = Record<string, unknown>;

export interface CodexEvent {
  method: string;
  params: JsonObject;
  id?: string | number;
}

export interface TurnBinding {
  threadId: string;
  turnId: string;
}

export interface FakeCodexOptions {
  cwd: string;
  scenario?: 'reply' | 'analysis' | 'repair' | 'approval';
  exitAt?: 'before_turn_response' | 'after_turn_response' | 'after_approval_response';
  timeoutMs?: number;
  turnResponseDelayMs?: number;
  repairFixture?: boolean;
  persistThreads?: boolean;
  holdForSteer?: boolean;
  projectPath?: string;
  referenceFixturePath?: string;
  signal?: AbortSignal;
}

export interface LocalCodexOptions {
  cwd: string;
  executable: string;
  accountDirectory: string;
  useExistingLogin: true;
  mode?: DriverMode;
  signal?: AbortSignal;
}

export type DriverMode = 'reply' | 'analysis' | 'repair';
export interface RestrictedCodexDriver {
  readonly cwd: string;
  readonly billing: CodexBilling;
  startThread(sandbox?: 'read-only' | 'workspace-write'): Promise<string>;
  resumeThread(threadId: string): Promise<string>;
  startTurn(threadId: string, prompt: string, profile?: { model?: string; effort?: string }): Promise<TurnBinding>;
  startTurnWithImages?(threadId: string, prompt: string, profile: {model?: string; effort?: string}, paths: readonly string[]): Promise<TurnBinding>;
  steerTurn(binding: TurnBinding, content: string): Promise<void>;
  respondApproval(id: string | number, binding: TurnBinding, decision: 'approve' | 'reject'): Promise<void>;
  respondReadTool(id: string | number, binding: TurnBinding, text: string, success?: boolean): Promise<void>;
  events(): AsyncIterable<CodexEvent>;
  close(): Promise<boolean>;
}

export type CodexBilling = 'fixture' | 'subscription' | 'metered';
export type LocalCodexAccount = { authType: 'chatgpt' | 'api_key'; billing: 'subscription' | 'metered'; version: string | null };

export class CodexUnknownOutcome extends Error {
  constructor(method: string, detail: string) {
    super(`${method}: ${detail}`);
    this.name = 'CodexUnknownOutcome';
  }
}

export class CodexStartupError extends Error {
  readonly unconfirmedTree: boolean;

  constructor(message: string, unconfirmedTree = false) {
    super(message);
    this.name = 'CodexStartupError';
    this.unconfirmedTree = unconfirmedTree;
  }
}

const fixture = fileURLToPath(new URL('./fixtures/fake-app-server.ts', import.meta.url));
const approvalMethod = 'item/commandExecution/requestApproval';
const fileApprovalMethod = 'item/fileChange/requestApproval';
const toolMethod = 'item/tool/call';
const incomingFrameLimit = 512 * 1024;
const outgoingFrameLimit = 1024 * 1024;
const eventLimit = 256;
const subscriptionPlans = new Set(['plus', 'pro', 'team', 'business', 'enterprise', 'edu', 'go']);

function object(value: unknown): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected a JSON object');
  }
  return value as JsonObject;
}

function stringId(value: unknown): string {
  if (typeof value !== 'string' || !value) throw new Error('Expected a string ID');
  return value;
}

function matches(event: CodexEvent, binding: TurnBinding): boolean {
  return event.params.threadId === binding.threadId && event.params.turnId === binding.turnId;
}

interface Pending {
  method: string;
  timer: ReturnType<typeof setTimeout>;
  resolve(result: JsonObject): void;
  reject(error: Error): void;
}

interface OwnedCodexProcess {
  child: ChildProcessWithoutNullStreams;
  pid: number;
  terminate(): void;
}

async function startOwned(executable: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv) {
  try {
    return await spawnOwned(executable, args, { cwd, env });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const osCode = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    const detail = /^Windows Job [a-z_]+ failed \([0-9]+\)$/.test(message) ? message
      : typeof osCode === 'string' && /^[A-Z_0-9]+$/.test(osCode) ? osCode : '未收到就绪确认';
    throw new CodexStartupError(`Job 启动失败（${detail}）`);
  }
}

async function observedWithin<T>(operation: Promise<T>, milliseconds: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<T>(resolve => { timer = setTimeout(() => resolve(fallback), milliseconds); })]);
  } finally {
    clearTimeout(timer);
  }
}

/** Windows-compatible transport for the bundled offline fixture. */
export class FakeCodex {
  readonly pid: number;
  readonly cwd: string;
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly owned: OwnedCodexProcess;
  private readonly timeoutMs: number;
  private readonly fixtureMode: boolean;
  private readonly inbox = new Readable({ objectMode: true, read() {} });
  private readonly pending = new Map<number, Pending>();
  private readonly serverRequests = new Map<string | number, CodexEvent>();
  private readonly activeTurns = new Map<string, string>();
  private readonly lastCompleted = new Map<string, string>();
  private nextId = 0;
  private buffer = Buffer.alloc(0);
  private stopped = false;
  private closing?: Promise<boolean>;
  private verifiedBilling?: CodexBilling;
  private localAccount?: LocalCodexAccount;
  private readonly mode: DriverMode;

  private constructor(owned: OwnedCodexProcess, cwd: string, timeoutMs: number, fixtureMode: boolean, mode: DriverMode, signal?: AbortSignal) {
    const { child } = owned;
    this.owned = owned;
    this.child = child;
    this.pid = owned.pid;
    this.cwd = cwd;
    this.timeoutMs = timeoutMs;
    this.fixtureMode = fixtureMode;
    this.mode = mode;
    if (fixtureMode) this.verifiedBilling = 'fixture';
    child.stderr.resume();
    child.stdin.on('error', () => this.stop('stdin unavailable'));
    child.stdout.on('data', (chunk: Buffer) => this.readChunk(chunk));
    child.on('error', () => this.stop('process unavailable'));
    this.exited = new Promise((resolve) => {
      child.once('close', (code, signal) => {
        this.stop('process disconnected', { code, signal });
        resolve({ code, signal });
      });
    });
    if (signal) {
      const abort = () => { void this.close(); };
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
      void this.exited.then(() => signal.removeEventListener('abort', abort));
    }
  }

  static async start(options: FakeCodexOptions): Promise<FakeCodex> {
    options.signal?.throwIfAborted();
    const cwd = await realpath(options.cwd);
    const timeoutMs = options.timeoutMs ?? 5_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
      throw new Error('Invalid request timeout');
    }
    const turnResponseDelayMs = options.turnResponseDelayMs ?? 0;
    if (!Number.isSafeInteger(turnResponseDelayMs) || turnResponseDelayMs < 0 || turnResponseDelayMs > 60_000) {
      throw new Error('Invalid fixture delay');
    }
    options.signal?.throwIfAborted();
    const owned = await startOwned(process.execPath, [fixture, JSON.stringify({
      scenario: options.scenario ?? 'reply',
      exitAt: options.exitAt,
      turnResponseDelayMs,
      repairFixture: options.repairFixture === true,
      persistThreads: options.persistThreads === true,
      holdForSteer: options.holdForSteer === true,
      projectPath: options.projectPath,
      referenceFixturePath: options.referenceFixturePath,
    })], cwd, offlineEnvironment(cwd));
    return new FakeCodex(owned, cwd, timeoutMs, true, options.scenario === 'analysis' ? 'analysis'
      : !options.scenario || options.scenario === 'reply' ? 'reply' : 'repair', options.signal).initialize();
  }

  static async startLocal(options: LocalCodexOptions): Promise<FakeCodex> {
    options.signal?.throwIfAborted();
    if (options.useExistingLogin !== true || !isAbsolute(options.executable) || !isAbsolute(options.accountDirectory)) {
      throw new Error('Local Codex requires explicit account authorization and absolute paths');
    }
    const [cwd, executable, accountDirectory] = await Promise.all([
      realpath(options.cwd), realpath(options.executable), realpath(options.accountDirectory),
    ]);
    if (executable !== options.executable || accountDirectory !== options.accountDirectory
        || !(await stat(accountDirectory)).isDirectory() || !(await stat(executable)).isFile()
        || (process.platform === 'win32' && extname(executable).toLowerCase() !== '.exe')) {
      throw new Error('Local Codex requires a pinned executable and account directory');
    }
    const mode = options.mode ?? 'reply';
    options.signal?.throwIfAborted();
    const owned = await startOwned(executable, ['app-server', '--disable', 'plugins', '--disable', 'apps',
      '--disable', 'remote_plugin', '--disable', 'hooks', '--disable', 'plugin_discovery_prefetch',
      '-c', 'mcp_servers={}', '-c', 'approval_policy="never"', '-c', 'sandbox_mode="read-only"',
      '-c', 'sandbox_workspace_write.network_access=false', '-c', 'sandbox_workspace_write.writable_roots=[]',
      '-c', 'sandbox_workspace_write.exclude_tmpdir_env_var=true', '-c', 'sandbox_workspace_write.exclude_slash_tmp=true'],
    cwd, { ...offlineEnvironment(cwd), CODEX_HOME: accountDirectory });
    return new FakeCodex(owned, cwd, 30_000, false, mode, options.signal).initialize();
  }

  private async initialize(): Promise<FakeCodex> {
    try {
      const result = await this.request('initialize', {
        clientInfo: { name: 'superagent-offline', version: '1' },
        capabilities: { experimentalApi: true },
      });
      if (this.fixtureMode && (result.fixture !== true || result.pid !== this.pid)) {
        throw new Error('Unexpected fixture handshake');
      }
      await this.write({ method: 'initialized', params: {} });
      if (!this.fixtureMode) {
        const accountResult = await this.request('account/read', { refreshToken: false });
        const account = object(accountResult.account);
        let authType: LocalCodexAccount['authType'];
        if (account.type === 'chatgpt') {
          authType = 'chatgpt';
          this.verifiedBilling = typeof account.planType === 'string' && subscriptionPlans.has(account.planType.toLowerCase())
            ? 'subscription' : 'metered';
        } else if (account.type === 'apiKey') {
          authType = 'api_key';
          this.verifiedBilling = 'metered';
        } else {
          throw new Error('Local Codex login type is unsupported');
        }
        const version = typeof result.userAgent === 'string' ? /\b\d+\.\d+\.\d+(?:[-+][a-z0-9.-]+)?\b/i.exec(result.userAgent)?.[0] ?? null : null;
        this.localAccount = { authType, billing: this.verifiedBilling, version };
      }
      return this;
    } catch (error) {
      const closed = await this.close();
      if (!closed) throw new CodexStartupError('Codex 握手失败且未确认进程树退出', true);
      if (!this.fixtureMode) throw new CodexStartupError('Codex 握手或现有本机账号验证失败');
      if (error instanceof CodexUnknownOutcome) throw new CodexStartupError(`假 Codex 握手失败（${error.message}）`);
      throw new CodexStartupError('假 Codex 握手返回的进程标识无效');
    }
  }

  get billing(): CodexBilling {
    if (!this.verifiedBilling) throw new Error('Local Codex billing is unverified');
    return this.verifiedBilling;
  }

  accountInfo(): LocalCodexAccount | undefined {
    return this.localAccount ? { ...this.localAccount } : undefined;
  }

  private threadOptions(sandbox = this.mode === 'repair' ? 'workspace-write' : 'read-only') {
    if (!this.fixtureMode && sandbox !== (this.mode === 'repair' ? 'workspace-write' : 'read-only')) throw new Error('Sandbox does not match driver mode');
    return { cwd: this.cwd, sandbox, approvalPolicy: this.fixtureMode ? 'on-request' : 'never' };
  }

  async startThread(sandbox?: 'read-only' | 'workspace-write'): Promise<string> {
    const result = await this.request('thread/start', { ...this.threadOptions(sandbox),
      ...(this.fixtureMode || this.mode === 'repair' ? {} : this.mode === 'reply'
        ? { developerInstructions: '仅根据用户输入直接回复。禁止调用工具或访问文件。' }
        : { developerInstructions: '只允许使用 Host 提供的只读工具访问本轮明确列出的工作区和资料别名。禁止 shell、联网和修改文件。',
          dynamicTools: readOnlyTools }),
    });
    return this.acknowledgedId(result, 'thread');
  }

  async resumeThread(threadId: string): Promise<string> {
    const result = await this.request('thread/resume', { ...this.threadOptions(), threadId });
    try {
      const thread = object(result.thread);
      if (thread.id === threadId && typeof thread.cwd === 'string' && await realpath(thread.cwd) === this.cwd
          && !(Array.isArray(thread.turns) && thread.turns.some(turn => turn?.status === 'inProgress'))) return threadId;
    } catch { /* A malformed or inaccessible workspace cannot identify the resumed thread. */ }
    void this.close();
    throw new CodexUnknownOutcome('thread/resume', 'thread or workspace mismatch');
  }

  async startTurn(threadId: string, prompt: string, profile: { model?: string; effort?: string } = {}): Promise<TurnBinding> {
    return this.sendTurn(threadId, prompt, profile, []);
  }

  async startTurnWithImages(threadId: string, prompt: string, profile: {model?: string; effort?: string}, paths: readonly string[]) {
    if (!paths.length || paths.length > 4) throw new Error('Invalid assessment image count');
    const root = await realpath(this.cwd);
    let total = 0;
    const images: JsonObject[] = [];
    for (const path of paths) {
      if (!isAbsolute(path) || dirname(path) !== root || (await realpath(path)) !== path ||
          !/^source-[1-9][0-9]*-[0-9a-f-]{36}\.(png|jpg|gif|webp)$/.test(basename(path))) throw new Error('Invalid staged image path');
      const info = await lstat(path);
      total += info.size;
      if (!info.isFile() || info.nlink !== 1 || info.size < 12 || info.size > 10*1024*1024 || total > 20*1024*1024)
        throw new Error('Invalid staged image size or type');
      const file = await open(path, 'r');
      try {
        const header = Buffer.alloc(12);
        const { bytesRead } = await file.read(header, 0, header.length, 0);
        const type = extname(path);
        const valid = type === '.png' && header.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex'))
          || type === '.jpg' && header.subarray(0,3).equals(Buffer.from('ffd8ff','hex'))
          || type === '.gif' && ['GIF87a','GIF89a'].includes(header.toString('ascii',0,6))
          || type === '.webp' && header.toString('ascii',0,4)==='RIFF' && header.toString('ascii',8,12)==='WEBP';
        if (bytesRead !== header.length || !valid) throw new Error('Invalid staged image signature');
      } finally { await file.close(); }
      images.push({type:'localImage',path});
    }
    return this.sendTurn(threadId, prompt, profile, images);
  }

  private async sendTurn(threadId: string, prompt: string, profile: {model?: string; effort?: string}, images: JsonObject[]): Promise<TurnBinding> {
    const result = await this.request('turn/start', {
      threadId, input: [{ type: 'text', text: prompt, text_elements: [] }, ...images],
      ...(this.fixtureMode ? {} : { model: profile.model, effort: profile.effort }),
    });
    const turnId = this.acknowledgedId(result, 'turn');
    if (!this.stopped && this.lastCompleted.get(threadId) !== turnId) this.activeTurns.set(threadId, turnId);
    return { threadId, turnId };
  }

  async steerTurn(binding: TurnBinding, content: string): Promise<void> {
    if (!content.trim() || this.activeTurns.get(binding.threadId) !== binding.turnId) throw new Error('Steer requires the active turn');
    const result = await this.request('turn/steer', { threadId: binding.threadId, expectedTurnId: binding.turnId,
      input: [{ type: 'text', text: content, text_elements: [] }] });
    if (result.turnId !== binding.turnId) throw new CodexUnknownOutcome('turn/steer', 'turn acknowledgement mismatch');
  }

  async respondApproval(id: string | number, binding: TurnBinding, decision: 'approve' | 'reject'): Promise<void> {
    if (!this.fixtureMode && (this.mode !== 'repair' || decision !== 'reject')) throw new Error('Local driver does not escalate repair permissions');
    if (decision !== 'approve' && decision !== 'reject') throw new Error('Unsupported approval decision');
    const request = this.expectServerRequest(id, binding, approvalMethod, fileApprovalMethod);
    const choices = request.params.availableDecisions;
    const wireDecision = decision === 'approve' ? 'accept' : 'decline';
    const selected = choices === undefined || (Array.isArray(choices) && choices.includes(wireDecision)) ? wireDecision
      : decision === 'reject' && Array.isArray(choices) && choices.includes('cancel') ? 'cancel' : undefined;
    if (!selected) throw new Error('Decision unavailable');
    await this.respond(id, { decision: selected });
  }

  async respondReadTool(id: string | number, binding: TurnBinding, text: string, success = true): Promise<void> {
    if (!this.fixtureMode && this.mode !== 'analysis') throw new Error('Local driver does not relay tool results outside analysis');
    const request = this.expectServerRequest(id, binding, toolMethod);
    if (typeof request.params.tool !== 'string' || !readOnlyToolNames.has(request.params.tool) || request.params.namespace != null || typeof text !== 'string') {
      throw new Error('Unsupported fake tool response');
    }
    await this.respond(id, { success, contentItems: [{ type: 'inputText', text }] });
  }

  /** Single consumer. Buffered frames are available even after the subprocess exits. */
  async *events(): AsyncGenerator<CodexEvent> {
    for await (const event of this.inbox.iterator({ destroyOnReturn: false })) yield event as CodexEvent;
  }

  close(): Promise<boolean> {
    this.closing ??= this.shutdown();
    return this.closing;
  }

  private async shutdown(): Promise<boolean> {
    this.child.stdin.end();
    const exited = this.exited.then(() => true);
    if (!await observedWithin(exited, 500, false)) {
      try { this.owned.terminate(); } catch { return false; }
    }
    if (!await observedWithin(exited, 2_000, false)) {
      this.stop('process tree exit unconfirmed');
      return false;
    }
    if (process.platform !== 'win32' && this.fixtureMode) return true;
    const { code, signal } = await this.exited;
    // The Windows supervisor preserves the peer's exit code only after observing an empty Job.
    // 125 also represents supervision failure, so it is deliberately inconclusive.
    return process.platform === 'win32' && signal === null && code !== null && code !== 125;
  }

  private expectServerRequest(id: string | number, binding: TurnBinding, ...methods: string[]): CodexEvent {
    const event = this.serverRequests.get(id);
    if (this.stopped || !event || !methods.includes(event.method) || !matches(event, binding)
        || this.activeTurns.get(binding.threadId) !== binding.turnId) {
      throw new Error('Request does not belong to the active turn');
    }
    return event;
  }

  private acknowledgedId(result: JsonObject, field: 'thread' | 'turn'): string {
    try {
      return stringId(object(result[field]).id);
    } catch {
      this.stop('invalid acknowledgement');
      void this.close();
      throw new CodexUnknownOutcome(`${field}/start`, `${field} acknowledgement has no valid ID`);
    }
  }

  private async respond(id: string | number, result: JsonObject): Promise<void> {
    // Encode before consuming the request. A local size error can be corrected safely.
    const frame = this.encode({ id, result });
    this.serverRequests.delete(id);
    try {
      await this.sendFrame(frame);
    } catch {
      throw new CodexUnknownOutcome('server request response', 'stdin unavailable');
    }
  }

  private encode(message: JsonObject): string {
    const frame = `${JSON.stringify(message)}\n`;
    if (Buffer.byteLength(frame) > outgoingFrameLimit) throw new Error('Outgoing frame too large');
    return frame;
  }

  private sendFrame(frame: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.child.stdin.write(frame, (error) => error ? reject(error) : resolve());
    });
  }

  private write(message: JsonObject): Promise<void> {
    return this.sendFrame(this.encode(message));
  }

  private async request(method: string, params: JsonObject): Promise<JsonObject> {
    if (this.stopped) throw new Error('Fake Codex is closed');
    const id = ++this.nextId;
    const frame = this.encode({ id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CodexUnknownOutcome(method, 'timed out'));
        this.stop('request timeout');
        void this.close();
      }, this.timeoutMs);
      this.pending.set(id, { method, timer, resolve, reject });
      void this.sendFrame(frame).catch(() => this.stop('stdin unavailable'));
    });
  }

  private readChunk(chunk: Buffer): void {
    if (this.stopped) return;
    try {
      let start = 0;
      while (start < chunk.length) {
        const newline = chunk.indexOf(10, start);
        const part = chunk.subarray(start, newline < 0 ? chunk.length : newline);
        if (this.buffer.length + part.length >= incomingFrameLimit) throw new Error('Incoming frame too large');
        this.buffer = Buffer.concat([this.buffer, part]);
        if (newline < 0) return;
        this.readFrame(this.buffer);
        this.buffer = Buffer.alloc(0);
        start = newline + 1;
      }
    } catch {
      this.stop('invalid protocol frame');
      void this.close();
    }
  }

  private readFrame(frame: Buffer): void {
    const message = object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(frame)));
    if (typeof message.method === 'string') {
      const event: CodexEvent = { method: message.method, params: message.params == null ? {} : object(message.params) };
      if (typeof message.id === 'number' || typeof message.id === 'string') {
        event.id = message.id;
        if (this.serverRequests.has(event.id)) throw new Error('Duplicate server request');
        this.serverRequests.set(event.id, structuredClone(event));
      }
      if (event.method === 'turn/started') {
        this.activeTurns.set(stringId(event.params.threadId), stringId(object(event.params.turn).id));
      }
      if (event.method === 'turn/completed') {
        const threadId = stringId(event.params.threadId);
        const turnId = stringId(object(event.params.turn).id);
        this.lastCompleted.set(threadId, turnId);
        if (this.activeTurns.get(threadId) === turnId) this.activeTurns.delete(threadId);
        for (const [id, request] of this.serverRequests) {
          if (matches(request, { threadId, turnId })) this.serverRequests.delete(id);
        }
      }
      if (this.inbox.readableLength >= eventLimit) throw new Error('Event buffer exceeded');
      this.inbox.push(event);
      return;
    }
    const pending = typeof message.id === 'number' ? this.pending.get(message.id) : undefined;
    if (!pending) throw new Error('Response has no matching request');
    const result = message.error === undefined ? object(message.result) : undefined;
    this.pending.delete(message.id as number);
    clearTimeout(pending.timer);
    if (result) pending.resolve(result);
    else pending.reject(new Error(`${pending.method}: rejected by fixture`));
  }

  private stop(reason: string, exit: JsonObject = {}): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new CodexUnknownOutcome(pending.method, reason));
    }
    this.pending.clear();
    this.serverRequests.clear();
    this.activeTurns.clear();
    this.inbox.push({ method: 'runtime/disconnected', params: { reason, ...exit } });
    this.inbox.push(null);
  }
}

/** Projects fixture observations only. The caller must independently verify business results. */
export function collectFakeTurnEvidence(binding: TurnBinding, events: readonly CodexEvent[]) {
  const observations: CodexEvent[] = [];
  let completion: string | null = null;
  let disconnectedBeforeCompletion = false;
  for (const event of events) {
    if (event.method === 'runtime/disconnected' && completion === null) disconnectedBeforeCompletion = true;
    if (event.params.threadId !== binding.threadId) continue;
    if (event.method === 'turn/started' || event.method === 'turn/completed') {
      const turn = object(event.params.turn);
      if (turn.id !== binding.turnId) continue;
      observations.push(event);
      if (event.method === 'turn/completed' && completion === null
          && !disconnectedBeforeCompletion && typeof turn.status === 'string') {
        completion = turn.status;
      }
    } else if (matches(event, binding)) {
      observations.push(event);
    }
  }
  return { source: 'offline-codex-fixture' as const, binding, observations, completion, disconnectedBeforeCompletion };
}
