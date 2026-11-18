import { lstat, mkdir, mkdtemp, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { CodexStartupError, FixtureProcessUnknown, fixtureAnalysisRead, fixtureWorkspaceSnapshot,
  prepareFixtureWorkspace, verifyFixtureRepair, prepareProjectWorkspace, projectWorkspaceSnapshot, projectVerificationCommand,
  readWorkspaceText, runProjectVerification, openRestrictedCodex, WorkspacePolicyError } from '../../../../packages/runtime/index.ts';
import type { CodexEvent, FakeCodexOptions, TurnBinding, FileReadEvidence, ProjectBaseline, ProjectRepository,
  RestrictedCodexDriver } from '../../../../packages/runtime/index.ts';
import type { ApprovalRow, Attempt, Fields, Lease, Storage } from '../../../../packages/storage/index.ts';
import { fail } from '../auth.js';
import { reserveModelRun, settleBudget } from '../budget.js';
import { assembleContext } from '../context.js';
import { assignedNode } from '../nodes.js';
import { settings } from '../settings.js';
import { audit, owned, record, serialize, tx, utc } from '../sql.js';
import { acceptTask, recheckWorkerWorkspace, workerProject, workerProjectKey } from './acceptance.ts';
import type { WorkerProject as Project } from './acceptance.ts';
import { pinnedSelection, registerLocalAgents } from './local-agents.ts';
import { buildWorkerPrompt } from './prompts.ts';

export { buildWorkerPrompt, WORKER_PROMPTS } from './prompts.ts';

type EvidenceSource = 'offline-codex-fixture' | 'local-codex-app-server';
type WorkerKind = 'reply' | 'repair' | 'analysis';
type Candidate = { id: number; project_id: number; kind: WorkerKind };
type Pending = { row: ApprovalRow; id: string | number; params: Fields };
type DecisionInFlight = { settle: (result: string) => void };

interface Run {
  task: Candidate;
  attempt: Attempt;
  source: EvidenceSource;
  cwd?: string;
  baseSha?: ProjectBaseline;
  client?: RestrictedCodexDriver;
  project: Project;
  fixtureRepo?: string;
  projectWorkspace?: boolean;
  binding?: TurnBinding;
  pending?: Pending;
  decision?: DecisionInFlight;
  done?: Promise<void>;
  deadline: number;
  abort: AbortController;
  messageCursor?: number;
  steering?: Promise<boolean>;
  stopRequested?: boolean;
  treeExitConfirmed?: boolean;
  workspaceExitUnknown?: boolean;
}

export interface WorkerControls {
  stop(taskId: number): Promise<boolean>;
  steer?(taskId: number, content: string): Promise<boolean>;
}

type Driver = {
  source: EvidenceSource;
  launch: (run: Run, cwd: string) => Promise<RestrictedCodexDriver>;
};

const commandApproval = 'item/commandExecution/requestApproval';
const fileApproval = 'item/fileChange/requestApproval';
const benignReplyItems = new Set(['userMessage', 'agentMessage', 'reasoning', 'plan', 'contextCompaction']);
const idSchema = z.coerce.number().int().positive();
const decisionBody = z.object({ decision: z.enum(['approve', 'reject']), action_hash: z.string().trim().min(1).max(255) });
const acceptanceBody = z.object({ accepted: z.boolean(), revision: z.int().positive(), comment: z.string().max(10_000).default('') });
const reconciliationBody = z.object({ outcome: z.enum(['stopped', 'abandoned']), evidence: z.string().trim().min(1).max(10_000),
  expected_state_version: z.int().nonnegative() });
const workerExitPoint = z.enum(['before_turn_response', 'after_turn_response', 'after_approval_response']);
const repoSchema = z.array(z.strictObject({ path: z.string(), base_branch: z.string() })).max(20);
const allowedPaths = (project: Project) => z.array(z.string()).parse(JSON.parse(project.allowed_paths));
const projectKey = workerProjectKey;

class RunStopped extends Error {}

function driverFrom(env: NodeJS.ProcessEnv, store: Storage): Driver | undefined {
  if (env.SUPERAGENT_DRIVER === 'fixture') {
    const exitAt = workerExitPoint.optional().parse(env.SUPERAGENT_FIXTURE_EXIT_AT);
    const scenarios = { reply: 'reply', repair: 'approval', analysis: 'analysis' } as const satisfies Record<WorkerKind, FakeCodexOptions['scenario']>;
    return { source: 'offline-codex-fixture', launch: (run, cwd) => openRestrictedCodex({
      source: 'offline-codex-fixture', cwd, scenario: scenarios[run.task.kind], repairFixture: run.task.kind === 'repair', exitAt,
      persistThreads: true, projectPath: run.fixtureRepo, signal: run.abort.signal,
      holdForSteer: run.task.kind === 'reply' && env.SUPERAGENT_FIXTURE_HOLD_REPLY === '1',
    }) };
  }
  if (env.SUPERAGENT_DRIVER !== undefined && env.SUPERAGENT_DRIVER !== 'codex') return;
  const selection = pinnedSelection(store.db);
  if (!selection || !isAbsolute(selection.executable) || !isAbsolute(selection.home) || !['chatgpt', 'api_key'].includes(selection.auth_type)) return;
  return { source: 'local-codex-app-server', launch: (run, cwd) =>
    openRestrictedCodex({ source: 'local-codex-app-server', cwd, executable: selection.executable, accountDirectory: selection.home, useExistingLogin: true,
      mode: run.task.kind, signal: run.abort.signal }) };
}

function idOf(request: FastifyRequest<{ Params: { id: string } }>) {
  return idSchema.parse(request.params.id);
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function eventScope(event: CodexEvent, binding: TurnBinding): boolean {
  const thread = event.params.threadId;
  const nested = object(event.params.turn)?.id;
  const direct = event.params.turnId;
  const lifecycle = event.method === 'turn/started' || event.method === 'turn/completed';
  const turn = lifecycle ? nested : (direct ?? nested);
  if (typeof thread !== 'string' || !thread || typeof turn !== 'string' || !turn) {
    throw new RunStopped('执行帧缺少会话或轮次标识');
  }
  if (direct !== undefined && nested !== undefined && direct !== nested) throw new RunStopped('执行帧的轮次标识互相冲突');
  return thread === binding.threadId && turn === binding.turnId;
}

async function makeWorkspace(root: string, taskId: number) {
  const canonical = await realpath(root);
  const base = join(canonical, 'worker-workspaces');
  await mkdir(base, { recursive: true });
  if (relative(base, await realpath(base)) !== '') throw new RunStopped('执行工作目录指向外部位置');
  return mkdtemp(join(base, `${taskId}-`));
}

/** Registers the worker routes and owns execution only. The caller owns the store, lease, and delivery. */
export function registerWorker(app: FastifyInstance, store: Storage, lease: Lease, root: string, env: NodeJS.ProcessEnv): WorkerControls {
  if (env.SUPERAGENT_DRIVER === 'fixture') workerExitPoint.optional().parse(env.SUPERAGENT_FIXTURE_EXIT_AT);
  const runs = new Map<number, Run>();
  const db = store.db;
  registerLocalAgents(app, db, root, env);
  const deadlineMs = z.coerce.number().int().min(100).max(900_000).parse(env.SUPERAGENT_WORKER_MAX_RUN_MS ?? 240_000);
  let stopping = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  function projectOf(id: number) {
    return workerProject(db, id);
  }

  function current(run: Run) {
    const project = projectOf(run.task.project_id);
    if (!project || projectKey(project) !== projectKey(run.project) || assignedNode(db, run.task.project_id, env)) return false;
    return db.prepare(`SELECT id FROM tasks WHERE id=? AND revision=? AND control_version=?
      AND project_id=? AND NOT outcome_unknown AND status IN ('running','waiting_approval')`)
      .get(run.task.id, run.attempt.revision, run.attempt.control_version, run.task.project_id);
  }

  function checkRunning(run: Run) {
    assertController(utc());
    if (stopping || run.stopRequested || run.abort.signal.aborted || performance.now() >= run.deadline || !current(run)) {
      throw new RunStopped(run.abort.signal.reason === 'deadline' ? '执行超过绝对期限' : '执行已停止或任务绑定已变化');
    }
  }

  function latestMessage(taskId: number) {
    return Number(db.prepare("SELECT COALESCE(MAX(id),0) AS id FROM events WHERE task_id=? AND event_type='message'").get(taskId)?.id);
  }

  async function prepareRunWorkspace(run: Run) {
    const prior = db.prepare('SELECT codex_thread_id,workspace_path FROM tasks WHERE id=?').get(run.task.id);
    const repos: ProjectRepository[] = repoSchema.parse(JSON.parse(run.project.repositories));
    const synthetic = run.source === 'offline-codex-fixture' && !repos.length && relative(root, run.project.repo_path) === ''
      && !await lstat(join(run.project.repo_path, '.git')).catch(() => undefined);
    run.projectWorkspace = run.task.kind !== 'reply' && !synthetic;
    if (run.source === 'offline-codex-fixture' && run.projectWorkspace) run.fixtureRepo = repos[0]?.path.replaceAll('\\', '/') ?? '';
    if (prior?.codex_thread_id) {
      const known = db.prepare(`SELECT e.data,a.base_sha,a.workspace_path,a.status FROM events e JOIN execution_attempts a ON a.id=json_extract(e.data,'$.attempt_id')
        WHERE e.task_id=? AND e.event_type='worker_thread_bound' AND a.thread_id=? ORDER BY e.id DESC LIMIT 1`)
        .get(run.task.id, prior.codex_thread_id);
      const info = known && object(JSON.parse(String(known.data)));
      if (!info || info.evidence_source !== run.source || info.kind !== run.task.kind || info.project_key !== projectKey(run.project)
          || typeof known?.workspace_path !== 'string' || known.workspace_path !== prior.workspace_path || known.status === 'unknown') {
        throw new RunStopped('既有会话工作区或来源未核实，请人工核对');
      }
      const base = join(await realpath(root), 'worker-workspaces');
      const cwd = await realpath(known.workspace_path);
      const path = relative(base, cwd);
      if (!path || path.startsWith('..') || isAbsolute(path) || cwd !== known.workspace_path) throw new RunStopped('既有会话工作区超出范围');
      run.cwd = cwd;
      if (typeof known.base_sha === 'string') run.baseSha = JSON.parse(known.base_sha) as ProjectBaseline;
      if (run.task.kind !== 'reply' && !run.baseSha) throw new RunStopped('既有会话工作区缺少基线');
      return { cwd, thread: String(prior.codex_thread_id) };
    }
    const cwd = await makeWorkspace(root, run.task.id);
    run.cwd = cwd;
    if (run.task.kind !== 'reply') {
      if (run.projectWorkspace && run.task.kind === 'repair' && run.source === 'local-codex-app-server') {
        try { await projectVerificationCommand(cwd, run.project.test_command); }
        catch { throw new RunStopped('项目验证命令未配置为本机绝对程序路径的 JSON 参数数组'); }
      }
      run.baseSha = run.projectWorkspace
        ? await prepareProjectWorkspace(cwd, run.project.repo_path, run.project.base_branch, repos,
          { committedAnalysis: run.task.kind === 'analysis', signal: run.abort.signal })
        : await prepareFixtureWorkspace(cwd, run.task.kind, run.abort.signal);
    }
    return { cwd, thread: undefined };
  }

  function settleDecision(run: Run, receipt: 'confirmed' | 'unknown') {
    if (!run.pending || !run.decision) return;
    const decision = run.decision;
    const approvalId = run.pending.row.id;
    run.decision = undefined;
    run.pending = undefined;
    let result = 'unknown';
    try {
      result = store.finishWorkerDecision(lease, run.attempt.id, approvalId, receipt);
    } finally {
      decision.settle(result);
    }
  }

  function stopReason(error: unknown) {
    return error instanceof RunStopped || error instanceof CodexStartupError || error instanceof WorkspacePolicyError
      ? error.message : '执行连接、版本或结果未确认';
  }

  function assertController(now: string) {
    if (!db.prepare("SELECT id FROM controller_leases WHERE id='controller' AND owner=? AND epoch=? AND expires_at>?")
      .get(lease.owner, lease.epoch, now)) fail(409, '控制器租约已失效');
  }

  function freezeUnconfirmedTree(run: Run) {
    tx(db, () => {
      const now = utc();
      assertController(now);
      if (!current(run)) return;
      const reason = `执行进程树退出未确认，须人工核对 [${run.source}]`;
      const changed = db.prepare(`UPDATE execution_attempts SET status='unknown',ended_at=?,updated_at=?,last_error=?
        WHERE id=? AND owner=? AND status IN ('claimed','running','waiting_approval')`).run(now, now, reason, run.attempt.id, lease.owner);
      if (!changed.changes) return;
      db.prepare(`UPDATE tasks SET status='waiting_resource',outcome_unknown=1,last_error=?,updated_at=?,state_version=state_version+1
        WHERE id=? AND revision=? AND control_version=?`).run(reason, now, run.task.id, run.attempt.revision, run.attempt.control_version);
      db.prepare(`UPDATE approvals SET status='expired' WHERE task_id=? AND status='pending' AND json_extract(action,'$.attempt_id')=?`)
        .run(run.task.id, run.attempt.id);
      record(db, run.task.id, 'stop_unknown', reason, { attempt_id: run.attempt.id, evidence_source: run.source });
    });
  }

  async function observe(run: Run, client: RestrictedCodexDriver, binding: TurnBinding) {
    let started = false;
    let summary = '';
    let references: string[] = [];
    const reads: FileReadEvidence[] = [];
    for await (const event of client.events()) {
      checkRunning(run);
      if (event.method.startsWith('runtime/')) throw new RunStopped('执行进程退出且本轮结果未确认');
      if (event.method === 'serverRequest/resolved' && event.params.turnId === undefined) {
        if (event.params.threadId === binding.threadId && run.pending && run.decision && event.params.requestId === run.pending.id) {
          settleDecision(run, 'confirmed');
        }
        continue;
      }
      if (event.id === undefined && !event.method.startsWith('item/') && !event.method.startsWith('turn/')
          && event.method !== 'serverRequest/resolved' && event.method !== 'error') continue;
      if (!eventScope(event, binding)) continue;
      if (event.method === 'error') throw new RunStopped('同轮协议报告错误，缺少完整验证');

      if (event.method === 'turn/started') started = true;
      if (event.id !== undefined) {
        if (started && run.task.kind === 'analysis' && run.cwd && reads.length < 8
            && event.method === 'item/tool/call' && event.params.tool === 'read_file' && event.params.namespace == null) {
          const path = object(event.params.arguments)?.path;
          const result = run.projectWorkspace ? await readWorkspaceText(run.cwd, path) : await fixtureAnalysisRead(run.cwd, path);
          checkRunning(run);
          await client.respondReadTool(event.id, binding, result.text);
          reads.push({ ...result.evidence, source: 'host-filesystem-read' });
          continue;
        }
        const method = event.method;
        if (!started || run.task.kind !== 'repair' || (method !== commandApproval && method !== fileApproval)
            || (method === commandApproval && (typeof event.params.command !== 'string' || event.params.cwd !== run.cwd)) || run.pending) {
          throw new RunStopped('本轮请求了未授权的工具或审批');
        }
        const params = event.params as Fields;
        const row = store.requestWorkerApproval(lease, run.attempt.id, {
          ...binding, method, requestId: event.id, params,
        });
        run.pending = { row, id: event.id, params };
        continue;
      }
      if (event.method === 'serverRequest/resolved' && run.pending && run.decision && event.params.requestId === run.pending.id) {
        settleDecision(run, 'confirmed');
        continue;
      }
      if (event.method === 'item/started' || event.method === 'item/completed') {
        const item = object(event.params.item);
        if (run.task.kind === 'reply' && (!item || !benignReplyItems.has(String(item.type)))) {
          throw new RunStopped('回复轮次出现了工具调用或未知项目');
        }
        if (run.task.kind === 'analysis' && (!item || (!benignReplyItems.has(String(item.type)) &&
            !(item.type === 'dynamicToolCall' && item.tool === 'read_file' && item.success !== false)))) {
          throw new RunStopped('分析轮次出现只读范围之外的操作');
        }
        if (run.task.kind === 'repair' && item && (['mcpToolCall', 'dynamicToolCall', 'webSearch'].includes(String(item.type))
            || (event.method === 'item/completed' && ['commandExecution', 'fileChange'].includes(String(item.type))
              && (['failed', 'declined', 'cancelled', 'error'].includes(String(item.status)) || (typeof item.exitCode === 'number' && item.exitCode !== 0))))) {
          throw new RunStopped('修复轮次含未恢复的工具错误或超范围调用');
        }
        if (started && event.method === 'item/completed' && item?.type === 'agentMessage' && typeof item.text === 'string') {
          summary = item.text.trim();
        }
      }
      if (event.method !== 'turn/completed') continue;
      if (run.steering && !await run.steering) throw new RunStopped('本轮补充消息未确认');
      checkRunning(run);
      if (!started || run.pending || object(event.params.turn)?.status !== 'completed'
          || !summary || summary.length > 50_000 || run.messageCursor !== latestMessage(run.task.id)) {
        throw new RunStopped('同轮 Host 核验证据不足，须人工核对');
      }
      if (run.task.kind !== 'reply' && run.projectWorkspace) {
        const outcome = z.object({ status: z.literal('completed'), summary: z.string().trim().min(1),
          paths: z.array(z.string().trim().min(1)).min(1).max(100) }).safeParse(JSON.parse(summary));
        if (!outcome.success) {
          throw new RunStopped('本轮没有完整的结构化报告');
        }
        summary = outcome.data.summary;
        references = outcome.data.paths.map(path => path.replaceAll('\\', '/'));
      }
      if (!await client.close()) throw new RunStopped('执行进程树退出未确认，须人工核对');
      checkRunning(run);
      const extra = await validateWorkspaceProof(run, reads, references);
      checkRunning(run);
      if (run.messageCursor !== latestMessage(run.task.id)) throw new RunStopped('证据核对期间收到未执行的补充消息');
      store.completeAttempt(lease, run.attempt.id, binding, [
        { kind: 'summary', content: summary },
        { kind: 'verification', content: JSON.stringify({ kind: run.task.kind, tool_less: run.task.kind === 'reply', host_checked: true,
          evidence_source: run.source, thread_id: binding.threadId, turn_id: binding.turnId, turn_status: 'completed',
          workspace_kind: run.projectWorkspace ? 'project' : 'fixture', project_key: projectKey(run.project), paths: references, ...extra.proof }) },
        ...(extra.changes ? [{ kind: 'changes', content: JSON.stringify(extra.changes) }] : []),
      ]);
      return;
    }
    throw new RunStopped('执行结束且本轮结果未确认');
  }

  async function validateWorkspaceProof(run: Run, reads: FileReadEvidence[], references: string[]) {
    if (run.task.kind === 'reply') return { proof: {}, changes: undefined };
    if (!run.cwd || !run.baseSha) throw new RunStopped('缺少受限工作区基线');
    try {
      const signal = run.abort.signal;
      if (run.projectWorkspace) {
        const scope = run.task.kind === 'repair' ? allowedPaths(run.project) : undefined;
        const changes = await projectWorkspaceSnapshot(run.cwd, run.baseSha, scope, signal);
        const changed = changes.repositories.filter(({ snapshot }) => snapshot.changed.length || snapshot.untracked.length);
        if (run.task.kind === 'analysis') {
          if (!reads.length || changed.length || !references.every(path => reads.some(read => read.path === path))) {
            throw new Error('missing read, invalid references or unexpected changes');
          }
          return { changes, proof: { analysis_verified: true, workspace_sha256: changes.sha256, reads } };
        }
        const paths = changed.flatMap(({ path, snapshot }) => [...snapshot.changed, ...snapshot.untracked]
          .map(file => path === '.' ? file : `${path}/${file}`));
        if (!paths.length || !references.every(path => paths.includes(path))) throw new Error('repair has no verified changed paths');
        const test = await runProjectVerification(run.cwd, run.project.test_command, signal);
        if ((await projectWorkspaceSnapshot(run.cwd, run.baseSha, scope, signal)).sha256 !== changes.sha256) throw new Error('verification changed workspace');
        return { changes, proof: { repair_verified: true, workspace_sha256: changes.sha256, test } };
      }
      if (typeof run.baseSha !== 'string') throw new Error('fixture baseline invalid');
      const changes = await fixtureWorkspaceSnapshot(run.cwd, run.baseSha, signal);
      if (run.task.kind === 'repair') {
        const test = await verifyFixtureRepair(run.cwd, changes, signal);
        return { changes, proof: { repair_verified: true, workspace_sha256: changes.sha256, test } };
      }
      if (!reads.length || changes.diff || changes.changed.length || changes.untracked.length) throw new Error('missing read or unexpected changes');
      return { changes, proof: { analysis_verified: true, workspace_sha256: changes.sha256, reads } };
    } catch (error) {
      if (error instanceof FixtureProcessUnknown) throw error;
      throw new RunStopped('同轮工作区差异、只读记录或预置命令证据不足，须人工核对');
    }
  }

  async function execute(run: Run, selected: Driver) {
    const cutoff = setTimeout(() => run.abort.abort('deadline'), Math.max(0, run.deadline - performance.now()));
    let reservation: number | undefined;
    let turnInvoked = false;
    try {
      store.beginAttempt(lease, run.attempt.id);
      checkRunning(run);
      const { cwd, thread: existingThread } = await prepareRunWorkspace(run);
      checkRunning(run);
      store.recordWorkspace(lease, run.attempt.id, cwd, run.baseSha ?? null);
      const client = await selected.launch(run, cwd);
      run.client = client;
      checkRunning(run);
      const thread = existingThread ? await client.resumeThread(existingThread) : await client.startThread(run.task.kind === 'repair' ? 'workspace-write' : 'read-only');
      checkRunning(run);
      store.recordThread(lease, run.attempt.id, thread);
      record(db, run.task.id, 'worker_thread_bound', '', { attempt_id: run.attempt.id, thread_id: thread,
        evidence_source: run.source, project_key: projectKey(run.project), kind: run.task.kind, resumed: !!existingThread });
      const task = db.prepare('SELECT goal FROM tasks WHERE id=? AND revision=? AND control_version=?')
        .get(run.task.id, run.attempt.revision, run.attempt.control_version);
      if (typeof task?.goal !== 'string' || !task.goal.trim() || task.goal.length > 20_000) {
        throw new RunStopped('当前任务文本无效或超出长度');
      }
      run.messageCursor = latestMessage(run.task.id);
      const assembled = env.SUPERAGENT_CONTEXT_MODE === 'decisions' ? assembleContext(db, run.task.id) : undefined;
      const context = assembled?.prompt ?? legacyFollowups(run.task.id);
      const prompt = buildWorkerPrompt(run.task.kind, { goal: task.goal, context, workspace: cwd,
        allowedPaths: run.task.kind === 'repair' ? allowedPaths(run.project) : undefined });
      const configuration = settings(db);
      const profile = object(object(configuration.codex_task_profiles)?.[run.task.kind]);
      const model = profile?.model ?? configuration.codex_model;
      const effort = profile?.effort ?? configuration.codex_effort;
      if (client.billing === 'metered') {
        const estimate = configuration.budget_reservation_estimate_micros;
        if (typeof estimate !== 'number' || !Number.isSafeInteger(estimate) || estimate <= 0) {
          throw new RunStopped('按量 Codex 缺少已配置的单轮预算估算');
        }
        try {
          reservation = reserveModelRun(db, `worker-${run.attempt.id}`, estimate, run.task.id,
            '管理设置中的单轮预算预留估算（budget_reservation_estimate_micros）');
        } catch {
          throw new RunStopped('按量 Codex 未获得本轮预算预留');
        }
      }
      checkRunning(run);
      store.prepareTurn(lease, run.attempt.id, assembled?.items);
      if (client.billing === 'subscription') {
        audit(db, 'scheduler', 'model.plan_run', run.task.id, { attempt_id: run.attempt.id, evidence_source: run.source,
          plan: 'existing-subscription', phase: 'turn_intent' });
      }
      turnInvoked = true;
      const turn = client.startTurn(thread, prompt, { model: typeof model === 'string' ? model : undefined,
        effort: typeof effort === 'string' ? effort : undefined });
      if (reservation !== undefined) {
        try {
          settleBudget(db, reservation, null, null, 'scheduler');
        } catch {
          void turn.catch(() => {});
          throw new RunStopped('本轮已尝试派发，预算状态须人工核对');
        }
      }
      const binding = await turn;
      checkRunning(run);
      run.binding = binding;
      store.bindTurn(lease, run.attempt.id, binding);
      await observe(run, client, binding);
    } catch (error) {
      if (error instanceof FixtureProcessUnknown) run.workspaceExitUnknown = true;
      if (run.client) run.treeExitConfirmed = await run.client.close();
      if (reservation !== undefined && !turnInvoked) {
        try {
          settleBudget(db, reservation, 0, { source: 'local_pre_dispatch', evidence: '未调用 turn/start' }, 'scheduler');
        } catch {
          app.log.warn({ taskId: run.task.id, attemptId: run.attempt.id }, 'Unused budget reservation requires reconciliation');
        }
      }
      try {
        if (run.decision) settleDecision(run, 'unknown');
        else if (!run.stopRequested) {
          if (run.treeExitConfirmed === false || run.workspaceExitUnknown || (error instanceof CodexStartupError && error.unconfirmedTree)) freezeUnconfirmedTree(run);
          else store.failAttempt(lease, run.attempt.id,
            `${run.abort.signal.reason === 'deadline' ? '执行超过绝对期限' : stopReason(error)} [${run.source}]`);
        }
      } catch {
        // A lost lease or changed task version prevents this run from mutating the successor.
        app.log.warn({ taskId: run.task.id, attemptId: run.attempt.id }, 'Worker could not finalize its old attempt');
      }
    } finally {
      clearTimeout(cutoff);
      if (run.client) run.treeExitConfirmed = await run.client.close();
      runs.delete(run.task.id);
    }
  }

  function legacyFollowups(taskId: number) {
    const recent = db.prepare(`SELECT content FROM events WHERE task_id=? AND event_type='message' AND id>
      (SELECT COALESCE(MAX(id),0) FROM events WHERE task_id=? AND event_type='goal_changed') ORDER BY id DESC LIMIT 10`)
      .all(taskId, taskId).reverse();
    const context = recent.map(entry => String(entry.content)).join('\n\n');
    if (context.length > 20_000) throw new RunStopped('会话补充内容超出长度');
    return context;
  }

  function slots() {
    const value = settings(db).max_concurrent_tasks;
    return typeof value === 'number' ? value : 1;
  }

  function executing() {
    return [...runs.values()].filter(run => !run.pending || run.decision).length;
  }

  function poll() {
    if (stopping) return;
    for (const run of runs.values()) {
      try { if (!current(run)) run.abort.abort('version'); }
      catch { run.abort.abort('version'); }
    }
    if (settings(db).scheduler_enabled !== true || runs.size >= 16) return;
    const driver = driverFrom(env, store);
    const free = Math.min(slots() - executing(), 16 - runs.size);
    const queued = db.prepare(`SELECT t.id,t.kind,t.project_id FROM tasks t JOIN projects p ON p.id=t.project_id
      WHERE t.status='queued' AND NOT t.outcome_unknown AND p.enabled AND NOT p.archived AND t.kind IN ('reply','repair','analysis')
      ORDER BY t.id LIMIT 100`).all() as Candidate[];
    let claimed = 0;
    for (const task of queued) {
      if (runs.has(task.id)) continue;
      const project = projectOf(task.project_id);
      if (!project) continue;
      let blocked: string | undefined;
      try {
        if (assignedNode(db, task.project_id, env)) blocked = '项目已绑定远端节点，由 Python 已绑定节点承载；现场切换需单控制器';
      } catch { blocked = '远端节点配置无效，禁止派到本地'; }
      if (!blocked && task.kind !== 'reply' && (/^[/\\]{2}/.test(project.repo_path)
          || (task.kind === 'analysis' && project.reference_access !== 'workspace'))) {
        blocked = '共享目录或跨项目只读资料范围由 Python 承载；现场切换需单控制器';
      }
      if (blocked) {
        tx(db, () => {
          const now = utc();
          assertController(now);
          const changed = db.prepare(`UPDATE tasks SET status='waiting_resource',last_error=?,state_version=state_version+1,updated_at=?
            WHERE id=? AND project_id=? AND status='queued' AND NOT outcome_unknown`).run(blocked, now, task.id, task.project_id);
          if (changed.changes) record(db, task.id, 'worker_resource_blocked', blocked, { project_id: task.project_id });
        });
        continue;
      }
      if (!driver || claimed >= free) continue;
      const attempt = store.claimTask(lease, task.id);
      if (!attempt) continue;
      claimed++;
      const run: Run = { task, project, attempt, source: driver.source, deadline: performance.now() + deadlineMs, abort: new AbortController() };
      runs.set(task.id, run);
      run.done = execute(run, driver);
    }
  }

  app.addHook('onReady', async () => {
    // The controller has recovered old attempts before registration. Only our own still-reserved rows need handoff.
    if (env.SUPERAGENT_DRIVER !== 'fixture') {
      assertController(utc());
      const reservations = db.prepare(`SELECT r.id,a.phase FROM governance_budget_reservations r
        JOIN execution_attempts a ON r.request_key='worker-'||a.id AND r.task_id=a.task_id
        WHERE r.account_id='global' AND r.status='reserved' AND a.status IN ('unknown','abandoned','failed','completed')`).all();
      for (const item of reservations) {
        const beforeTurn = ['claimed', 'workspace', 'thread'].includes(String(item.phase));
        settleBudget(db, Number(item.id), beforeTurn ? 0 : null,
          beforeTurn ? { source: 'persisted_pre_dispatch', evidence: '恢复时执行阶段尚未进入 turn' } : null, 'scheduler');
      }
    }
    timer = setInterval(() => {
      try { poll(); } catch { app.log.warn('Worker poll was rejected'); }
    }, 200);
    timer.unref();
  });
  app.addHook('preClose', async () => {
    stopping = true;
    clearInterval(timer);
    const active = [...runs.values()];
    for (const run of active) run.abort.abort('shutdown');
    await Promise.all(active.map(run => run.client?.close()));
    await Promise.all(active.map(run => run.done));
  });

  app.post<{ Params: { id: string } }>('/api/v1/approvals/:id/decision', async request => {
    const approvalId = idOf(request);
    const input = decisionBody.parse(request.body);
    const row = db.prepare('SELECT task_id,action FROM approvals WHERE id=?').get(approvalId) ?? fail(404, '审批不存在');
    const taskId = Number(row.task_id);
    const task = owned(db, taskId, request.principal);
    const action = object(JSON.parse(String(row.action)));
    if (!action || (action.method !== commandApproval && action.method !== fileApproval)) fail(409, '此入口只处理已绑定的 Worker 工具审批');
    const run = runs.get(taskId);
    if (task.kind !== 'repair' || !run?.binding || !run.client || run.pending?.row.id !== approvalId || run.decision) {
      fail(409, '工具审批没有活跃的修复轮次');
    }
    const { binding, client } = run;
    try { checkRunning(run); } catch { fail(409, '审批已超过期限或所绑定的执行已变化'); }
    const dispatch = store.dispatchWorkerDecision(lease, run.attempt.id, approvalId, {
      decision: input.decision, actionHash: input.action_hash, actor: request.principal.user_id,
      authorize: authorized => {
        if (stopping || run.stopRequested || run.abort.signal.aborted || performance.now() >= run.deadline || executing() >= slots() || !run.pending
            || authorized.request_id !== run.pending.id || !eventScope({ method: commandApproval, params: run.pending.params }, binding)) return false;
        if (input.decision === 'reject') return true;
        if (run.source !== 'offline-codex-fixture') return false;
        const project = db.prepare('SELECT allowed_paths FROM projects WHERE id=? AND enabled AND NOT archived').get(task.project_id);
        const allowed: unknown = project ? JSON.parse(String(project.allowed_paths)) : null;
        return Array.isArray(allowed) && allowed.includes('.') && run.pending.params.cwd === run.cwd;
      },
    });
    const confirmed = new Promise<string>(settle => { run.decision = { settle }; });
    try {
      await client.respondApproval(dispatch.requestId, binding, dispatch.decision);
    } catch {
      try { settleDecision(run, 'unknown'); } finally { await client.close(); }
    }
    const status = await confirmed;
    if (status === 'unknown') fail(503, '审批响应结果未知，请人工对账');
    if (status === 'expired_after_dispatch') fail(409, '审批响应期间任务版本已变化');
    return serialize(db.prepare('SELECT * FROM approvals WHERE id=?').get(approvalId)!);
  });

  app.post<{ Params: { id: string } }>('/api/v1/tasks/:id/acceptance', async request => {
    const taskId = idOf(request);
    const body = acceptanceBody.parse(request.body);
    const before = owned(db, taskId, request.principal);
    const workspace = await recheckWorkerWorkspace(db, root, before, taskId, body, env.SUPERAGENT_DRIVER === 'fixture');
    return tx(db, () => {
      const task = owned(db, taskId, request.principal);
      const now = utc();
      assertController(now);
      acceptTask(db, task, taskId, body, env.SUPERAGENT_DRIVER === 'fixture', workspace);
      const status = body.accepted ? 'completed' : 'waiting_input';
      db.prepare('UPDATE tasks SET status=?,control_version=control_version+1,state_version=state_version+1,updated_at=? WHERE id=?')
        .run(status, now, taskId);
      record(db, taskId, 'acceptance', body.comment, { accepted: body.accepted, revision: body.revision });
      audit(db, request.principal.user_id, 'task.acceptance', taskId, { status, revision: body.revision });
      return serialize(db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId)!);
    });
  });

  app.post<{ Params: { id: string } }>('/api/v1/tasks/:id/reconcile', request => {
    const taskId = idOf(request);
    const body = reconciliationBody.parse(request.body);
    owned(db, taskId, request.principal);
    store.reconcileTask(lease, taskId, { outcome: body.outcome, evidence: body.evidence,
      expectedStateVersion: body.expected_state_version, actor: request.principal.user_id, isStopped: () => !runs.has(taskId) });
    return serialize(db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId)!);
  });

  return {
    async stop(taskId) {
      const run = runs.get(taskId);
      if (!run?.done) return false;
      run.stopRequested = true;
      run.abort.abort('stop');
      void run.client?.close();
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          run.done.then(() => run.treeExitConfirmed === true && !run.workspaceExitUnknown, () => false),
          new Promise<boolean>(resolve => { deadline = setTimeout(() => resolve(false), 6_000); }),
        ]);
      } finally {
        clearTimeout(deadline);
      }
    },
    async steer(taskId, content) {
      const run = runs.get(taskId);
      if (!run?.client || !run.binding || run.messageCursor === undefined || run.steering || run.pending || !content.trim()) return false;
      const next = db.prepare("SELECT id,content FROM events WHERE task_id=? AND event_type='message' AND id>? ORDER BY id LIMIT 1")
        .get(taskId, run.messageCursor);
      if (!next || next.content !== content) return false;
      const { client, binding } = run;
      const perform = async () => {
        try {
          checkRunning(run);
          await client.steerTurn(binding, content);
          checkRunning(run);
          run.messageCursor = Number(next.id);
          return true;
        } catch {
          // The control route fences a failed steer; the end-of-turn cursor also forbids stale evidence.
          return false;
        }
      };
      run.steering = perform();
      try { return await run.steering; } finally { run.steering = undefined; }
    },
  };
}
