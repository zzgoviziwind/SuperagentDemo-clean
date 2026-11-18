import { realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { fixtureWorkspaceSnapshot, projectWorkspaceSnapshot } from '../../../../packages/runtime/index.ts';
import type { ProjectBaseline } from '../../../../packages/runtime/index.ts';
import { fail } from '../auth.js';
import type { Row } from '../sql.js';

type Decision = { accepted: boolean; revision: number };
type Snapshot = Awaited<ReturnType<typeof fixtureWorkspaceSnapshot | typeof projectWorkspaceSnapshot>>;
type WorkspaceRecheck = { path: string; attemptId: string; verificationId: number; snapshot: Snapshot; projectKey?: string };
export type WorkerProject = { repo_path: string; base_branch: string; repositories: string; test_command: string; allowed_paths: string;
  reference_access: string; reference_dirs: string };

export function workerProject(db: DatabaseSync, id: number) {
  return db.prepare(`SELECT repo_path,base_branch,repositories,test_command,allowed_paths,reference_access,reference_dirs FROM projects
    WHERE id=? AND enabled AND NOT archived`).get(id) as WorkerProject | undefined;
}

export function workerProjectKey(project: WorkerProject) {
  const { reference_dirs, ...base } = project;
  return createHash('sha256').update(JSON.stringify(project.reference_access === 'directories' ? { ...base, reference_dirs } : base)).digest('hex');
}

function latestVerification(db: DatabaseSync, taskId: number, revision: number) {
  return db.prepare(`SELECT id,content,attempt_id FROM artifacts WHERE task_id=? AND revision=? AND kind='verification'
    ORDER BY id DESC LIMIT 1`).get(taskId, revision);
}

export async function recheckWorkerWorkspace(db: DatabaseSync, root: string, task: Row, taskId: number, decision: Decision,
  fixtureMode: boolean): Promise<WorkspaceRecheck | undefined> {
  if (!decision.accepted || task.kind === 'reply') return;
  if (!['analysis', 'repair'].includes(String(task.kind)) || task.outcome_unknown
      || task.status !== 'review_ready' || task.revision !== decision.revision || typeof task.workspace_path !== 'string') {
    fail(409, '缺少可重新检查的本轮工作区');
  }
  const verification = latestVerification(db, taskId, decision.revision);
  if (typeof verification?.attempt_id !== 'string') fail(409, '缺少工作区验证关联');
  let proof: { evidence_source?: string; workspace_kind?: string; project_key?: string } | null;
  try { proof = JSON.parse(String(verification.content)); } catch { fail(409, '工作区证据格式无效'); }
  if (!proof || (proof.evidence_source === 'offline-codex-fixture' && !fixtureMode)
      || (proof.workspace_kind !== 'project' && (!fixtureMode || proof.evidence_source !== 'offline-codex-fixture'))) {
    fail(409, '工作区证据来源无效');
  }
  const attempt = db.prepare(`SELECT workspace_path,base_sha FROM execution_attempts WHERE id=? AND task_id=? AND status='completed'`)
    .get(verification.attempt_id, taskId);
  if (attempt?.workspace_path !== task.workspace_path || typeof attempt.base_sha !== 'string') fail(409, '工作区基线已变化');
  let snapshot: WorkspaceRecheck['snapshot'];
  let projectKey: string | undefined;
  try {
    const canonical = await realpath(task.workspace_path);
    const workspaces = join(await realpath(root), 'worker-workspaces');
    const contained = relative(workspaces, canonical);
    const baseSha = JSON.parse(attempt.base_sha) as ProjectBaseline;
    if (!contained || contained === '..' || contained.startsWith(`..${sep}`) || isAbsolute(contained)
        || canonical !== task.workspace_path || !baseSha) throw new Error('Workspace escaped root');
    const signal = AbortSignal.timeout(15_000);
    if (proof.workspace_kind === 'project') {
      const project = workerProject(db, Number(task.project_id));
      if (!project || (projectKey = workerProjectKey(project)) !== proof.project_key) throw new Error('Project configuration changed');
      snapshot = await projectWorkspaceSnapshot(canonical, baseSha, task.kind === 'repair' ? JSON.parse(project.allowed_paths) as string[] : undefined, signal);
    } else {
      if (typeof baseSha !== 'string') throw new Error('Fixture baseline changed');
      snapshot = await fixtureWorkspaceSnapshot(canonical, baseSha, signal);
    }
  } catch { fail(409, '无法核对当前工作区状态'); }
  return { attemptId: verification.attempt_id, verificationId: Number(verification.id), path: task.workspace_path, snapshot, projectKey };
}

export function acceptTask(db: DatabaseSync, task: Row, taskId: number, decision: Decision, fixtureMode: boolean, workspace?: WorkspaceRecheck) {
  if (task.status !== 'review_ready' || task.revision !== decision.revision || task.outcome_unknown) {
    fail(409, '版本已变化、结果未知或任务尚未准备验收');
  }
  if (!decision.accepted) return;
  if (typeof task.codex_thread_id !== 'string' || !task.codex_thread_id
      || typeof task.codex_turn_id !== 'string' || !task.codex_turn_id) fail(409, '缺少当前轮次的验收证据');
  const verification = latestVerification(db, taskId, decision.revision);
  if (!verification) fail(409, '缺少本轮验证');
  const summary = db.prepare(`SELECT content FROM artifacts WHERE task_id=? AND revision=? AND kind='summary' AND attempt_id IS ?
    ORDER BY id DESC LIMIT 1`).get(taskId, decision.revision, verification.attempt_id);
  let proof: { kind?: string; tool_less?: boolean; thread_id?: string; turn_id?: string; turn_status?: string;
    evidence_source?: string; host_checked?: boolean; analysis_verified?: boolean; repair_verified?: boolean;
    workspace_sha256?: string; reads?: { source?: string; size?: number; sha256?: string }[];
    test?: { source?: string; exit_code?: number; cwd?: string } } | undefined;
  try { proof = JSON.parse(String(verification.content)) ?? undefined; } catch { /* Invalid legacy evidence is insufficient. */ }
  if (!proof || proof.kind !== task.kind || proof.turn_status !== 'completed'
      || proof.thread_id !== task.codex_thread_id || proof.turn_id !== task.codex_turn_id
      || typeof summary?.content !== 'string' || !summary.content.trim()) fail(409, '缺少本轮验证');
  if (proof.evidence_source !== undefined && (proof.host_checked !== true || verification.attempt_id === null
      || !['offline-codex-fixture', 'local-codex-app-server'].includes(proof.evidence_source))) fail(409, '回复证据来源无效');
  if (proof.evidence_source === 'offline-codex-fixture' && !fixtureMode) fail(409, '离线验证需在夹具模式下验收');
  if (verification.attempt_id !== null && !db.prepare(`SELECT id FROM execution_attempts WHERE id=? AND task_id=? AND revision=?
      AND control_version=? AND thread_id=? AND turn_id=? AND status='completed'`).get(verification.attempt_id, taskId,
        decision.revision, task.control_version, task.codex_thread_id, task.codex_turn_id)) fail(409, '验证不属于当前执行尝试');
  if (task.kind === 'reply') {
    if (proof.tool_less !== true) fail(409, '缺少无工具的回复证据');
    return;
  }
  if (!workspace || workspace.attemptId !== verification.attempt_id || !proof.evidence_source
      || workspace.verificationId !== verification.id || workspace.path !== task.workspace_path
      || proof.workspace_sha256 !== workspace.snapshot.sha256) fail(409, '工作区状态已变化或本轮证据不足');
  if (workspace.projectKey) {
    const current = workerProject(db, Number(task.project_id));
    if (!current || workerProjectKey(current) !== workspace.projectKey) fail(409, '项目绑定已变化');
  }
  const changes = db.prepare(`SELECT content FROM artifacts WHERE task_id=? AND revision=? AND attempt_id=? AND kind='changes'
    ORDER BY id DESC LIMIT 1`).get(taskId, decision.revision, workspace.attemptId);
  if (changes?.content !== JSON.stringify(workspace.snapshot)) fail(409, '当前工作区与核验时差异不一致');
  const valid = task.kind === 'repair'
    ? proof.repair_verified === true && proof.test?.source === 'host-command' && proof.test.exit_code === 0 && proof.test.cwd === workspace.path
    : task.kind === 'analysis' && proof.analysis_verified === true && Array.isArray(proof.reads)
      && proof.reads.some(read => read?.source === 'host-filesystem-read' && typeof read.size === 'number' && read.size > 0
        && typeof read.sha256 === 'string' && /^[a-f0-9]{64}$/.test(read.sha256));
  if (!valid) fail(409, '缺少独立命令验证或受限读取证据');
}
