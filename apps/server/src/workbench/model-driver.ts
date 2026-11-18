import type { DatabaseSync } from 'node:sqlite';
import { isAbsolute } from 'node:path';
import { FakeCodex, type CodexEvent, type TurnBinding } from '../../../../packages/runtime/index.ts';
import { reserveModelRun, settleBudget } from '../budget.js';
import { settings } from '../settings.js';
import { pinnedSelection } from '../worker/local-agents.js';
import { fields } from './store.ts';
import { comparisonAssessmentPrompt, projectAssessmentPrompt } from './prompts.ts';

export type WorkbenchModelKind = 'semantic' | 'router' | 'watchdog';

export interface WorkbenchModelClient {
  readonly billing: 'fixture' | 'subscription' | 'metered';
  startThread(mode: 'read-only'): Promise<string>;
  resumeThread?(threadId: string): Promise<string>;
  startTurn(threadId: string, text: string, profile: { model?: string; effort?: string }): Promise<TurnBinding>;
  startTurnWithImages?(threadId: string, text: string, profile: { model?: string; effort?: string },
    paths: readonly string[]): Promise<TurnBinding>;
  events(): AsyncIterable<CodexEvent>;
  close(): Promise<boolean>;
}

export interface WorkbenchModelDriver {
  readonly source: string;
  available(): boolean;
  imagesAvailable?(): boolean;
  open(cwd: string, kind: WorkbenchModelKind, signal: AbortSignal): Promise<WorkbenchModelClient>;
}

export function pinnedWorkbenchDriver(db: DatabaseSync, env: NodeJS.ProcessEnv): WorkbenchModelDriver {
  const imagesAvailable = () => typeof (FakeCodex.prototype as WorkbenchModelClient).startTurnWithImages === 'function';
  if (env.SUPERAGENT_DRIVER === 'fixture') {
    const exit = env.SUPERAGENT_FIXTURE_EXIT_AT;
    return { source: 'offline-codex-fixture', available: () => true, imagesAvailable,
      async open(cwd, kind, signal) {
        const client = await FakeCodex.start({ cwd, scenario: 'reply', persistThreads: true, signal,
          exitAt: exit === 'before_turn_response' || exit === 'after_turn_response' ? exit : undefined });
        let assessment = false;
        let comparison = false;
        const startImages = (client as WorkbenchModelClient).startTurnWithImages?.bind(client);
        return { billing: 'fixture', startThread: mode => client.startThread(mode),
          resumeThread: id => client.resumeThread(id), startTurn(thread, text, profile) {
            assessment = text.startsWith(projectAssessmentPrompt);
            comparison = text.startsWith(comparisonAssessmentPrompt);
            return client.startTurn(thread, text, profile);
          },
          startTurnWithImages: startImages && ((thread, text, profile, paths) => {
            assessment = text.startsWith(projectAssessmentPrompt);
            comparison = text.startsWith(comparisonAssessmentPrompt);
            return startImages(thread, text, profile, paths);
          }),
          close: () => client.close(), async *events() {
            for await (const packet of client.events()) {
              const item = fields(packet.params.item);
              // The existing protocol fixture emits one literal text reply. Adapt only that new fixture frame.
              if (kind !== 'router' && packet.method === 'item/completed' && item.type === 'agentMessage'
                && item.simulated === true && item.text === '离线样例结果') {
                const reason = '独立离线协议进程已返回合成结果';
                const value = assessment ? { project_status: 'needs_context', proposed_project_id: null, evidence_event_ids: [],
                  reason, missing_context: '离线样本不判断实际项目归属',
                  ...(comparison ? { relationship: 'uncertain', relationship_reason: '离线样本只验证协议' } : {}) } : kind === 'semantic'
                  ? { action: 'confirm', kind: 'analysis', task_id: null, state_version: null, reason }
                  : { action: 'observe', reason };
                yield { ...packet, params: { ...packet.params, item: { ...item, text: JSON.stringify(value) } } };
              } else yield packet;
            }
          } };
      } };
  }
  function selected() {
    if (env.SUPERAGENT_DRIVER !== undefined && env.SUPERAGENT_DRIVER !== 'codex') return;
    const row = pinnedSelection(db);
    return row && ['chatgpt', 'api_key'].includes(row.auth_type) && isAbsolute(row.executable) && isAbsolute(row.home) ? row : undefined;
  }
  return {
    source: 'local-codex-app-server',
    available: () => Boolean(selected()),
    imagesAvailable,
    open(cwd, _kind, signal) {
      const row = selected();
      if (!row) throw new Error('尚未配置受信本机 Codex');
      return FakeCodex.startLocal({ cwd, executable: row.executable, accountDirectory: row.home, useExistingLogin: true,
        mode: 'reply', signal });
    },
  };
}

export interface ModelInvocation {
  id: string;
  kind: WorkbenchModelKind;
  cwd: string;
  prompt: string;
  threadId?: string;
  taskId: number | null;
  imagePaths?: readonly string[];
  signal: AbortSignal;
  onThread(threadId: string): void;
  prepareTurn(reservationId: number | null): void;
  bindTurn(binding: TurnBinding): void;
}

const allowedItems = new Set(['userMessage', 'agentMessage', 'reasoning', 'plan', 'contextCompaction']);

async function readAnswer(client: WorkbenchModelClient, binding: TurnBinding, signal: AbortSignal) {
  const responses = new Map<string, string>();
  for await (const packet of client.events()) {
    signal.throwIfAborted();
    const p = packet.params;
    if (packet.id !== undefined) throw new Error('只读分派收到工具或审批请求');
    if (packet.method.startsWith('runtime/')) throw new Error('协议连接中断');
    const turn = fields(p.turn);
    if (p.threadId !== binding.threadId || (p.turnId ?? turn.id) !== binding.turnId) continue;
    if (packet.method === 'item/completed' || packet.method === 'item/started') {
      const item = fields(p.item);
      if (!allowedItems.has(String(item.type))) throw new Error('只读分派检测到工具活动');
      if (packet.method === 'item/completed' && item.type === 'agentMessage'
        && typeof item.id === 'string' && typeof item.text === 'string' && item.text.trim()) {
        if (item.text.length > 100_000 || responses.size >= 32) throw new Error('模型输出超过限额');
        responses.set(item.id, item.text);
      }
    }
    if (packet.method === 'turn/completed') {
      if (turn.status !== 'completed' || !responses.size) throw new Error('没有可核验的本轮模型答复');
      return [...responses.values()];
    }
  }
  throw new Error('连接关闭前未确认本轮完成');
}

export type InvocationResult = { answered: true; items: string[]; binding: TurnBinding; treeExited: true }
  | { answered: false; unknown: boolean; reason: string; treeExited: boolean };

export async function invokeWorkbenchModel(db: DatabaseSync, driver: WorkbenchModelDriver,
  invocation: ModelInvocation): Promise<InvocationResult> {
  let client: WorkbenchModelClient | undefined;
  let reservation: number | undefined;
  let sent = false;
  let treeExited = true;
  let result: { items: string[]; binding: TurnBinding } | undefined;
  let reason = '模型调用未完成';
  const stop = () => { void client?.close().catch(() => false); };
  invocation.signal.addEventListener('abort', stop, { once: true });
  try {
    invocation.signal.throwIfAborted();
    client = await driver.open(invocation.cwd, invocation.kind, invocation.signal);
    invocation.signal.throwIfAborted();
    const imagePaths = invocation.imagePaths;
    const startImages = client.startTurnWithImages?.bind(client);
    if (imagePaths?.length && !startImages) {
      reason = '本机模型驱动尚未启用安全图片输入';
      throw new Error(reason);
    }
    const prior = invocation.threadId;
    const threadId = prior && client.resumeThread ? await client.resumeThread(prior) : await client.startThread('read-only');
    if (!threadId || (prior && client.resumeThread && prior !== threadId)) throw new Error('模型线程绑定无效');
    invocation.onThread(threadId);
    const cfg = settings(db);
    const entry = fields(fields(cfg.codex_task_profiles)[invocation.kind === 'semantic' ? 'semantic_routing' : invocation.kind]);
    const model = entry.model ?? cfg.codex_model;
    const effort = entry.effort ?? cfg.codex_effort;
    if (client.billing === 'metered') {
      const estimate = cfg.budget_reservation_estimate_micros;
      if (typeof estimate !== 'number' || !Number.isSafeInteger(estimate) || estimate <= 0) {
        reason = '按量 Codex 缺少单轮预算预留金额';
        throw new Error(reason);
      }
      reason = '按量 Codex 未获得预算预留';
      reservation = reserveModelRun(db, 'workbench:' + invocation.id, estimate, invocation.taskId, '工作台单轮模型预算预留');
    }
    invocation.signal.throwIfAborted();
    invocation.prepareTurn(reservation ?? null);
    if (reservation !== undefined) {
      reason = '预算状态未确认，等待人工对账';
      settleBudget(db, reservation, null, null, 'workbench');
    }
    reason = '本轮模型结果未知，请人工核验';
    // No asynchronous gap between persisting the dispatch intent and starting the protected call.
    invocation.signal.throwIfAborted();
    sent = true;
    const profile = {
      model: typeof model === 'string' ? model : undefined, effort: typeof effort === 'string' ? effort : undefined,
    };
    const bound = imagePaths?.length && startImages ? await startImages(threadId, invocation.prompt, profile, imagePaths)
      : await client.startTurn(threadId, invocation.prompt, profile);
    if (bound.threadId !== threadId || !bound.turnId) throw new Error('模型轮次绑定无效');
    invocation.bindTurn(bound);
    result = { binding: bound, items: await readAnswer(client, bound, invocation.signal) };
  } catch (error) {
    if (!client && fields(error).unconfirmedTree === true) treeExited = false;
  } finally {
    if (client) treeExited = await client.close().catch(() => false);
    if (reservation !== undefined && !sent) {
      try { settleBudget(db, reservation, 0, { source: 'local_pre_dispatch', evidence: '未调用 turn/start' }, 'workbench'); }
      catch { reason = '预算预留待人工对账'; }
    }
    invocation.signal.removeEventListener('abort', stop);
  }
  if (result && treeExited) return { answered: true, ...result, treeExited: true };
  return { answered: false, unknown: sent || !treeExited, treeExited,
    reason: treeExited ? reason : '模型进程树退出未确认，请人工核验' };
}
