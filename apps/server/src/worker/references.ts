import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pinReferenceRoot } from '../../../../packages/runtime/index.ts';
import type { PinnedReference, ReferencePolicy } from '../../../../packages/runtime/index.ts';
import { fail, roleOf } from '../auth.js';
import { admin, audit, owned, tx, utc } from '../sql.js';
import type { WorkerProject } from './acceptance.ts';

const ids = z.array(z.int().positive()).max(100).refine(items => new Set(items).size === items.length);
const settingKey = (projectId: number) => `worker.reference_projects.${projectId}`;
const projectParam = z.object({ id: z.coerce.number().int().positive() });
type Candidate = { alias: string; path: string; projectId?: number };
export type ReferenceScope = { key: string; bindingKey: string; roots: Map<string, { pin: PinnedReference; projectId?: number }> };

function configuredProjects(db: DatabaseSync, projectId: number): number[] | null {
  const row = db.prepare('SELECT value FROM governance_settings WHERE key=?').get(settingKey(projectId));
  return row ? ids.parse(JSON.parse(String(row.value))) : null;
}

function enabledProjects(db: DatabaseSync) {
  return db.prepare('SELECT id, name, repo_path FROM projects WHERE enabled AND NOT archived ORDER BY id').all();
}

function candidates(db: DatabaseSync, taskId: number, projectId: number, project: WorkerProject, env: NodeJS.ProcessEnv): Candidate[] {
  if (project.reference_access === 'workspace') return [];
  const owner = db.prepare(`SELECT COALESCE(NULLIF(t.owner_id,'local-admin'),o.user_id,t.owner_id) AS user_id
    FROM tasks t LEFT JOIN governance_task_owners o ON o.task_id=t.id WHERE t.id=? AND t.kind='analysis'`).get(taskId)?.user_id;
  if (typeof owner !== 'string' || roleOf(env, owner) !== 'admin') return [];
  if (project.reference_access === 'directories') {
    return z.array(z.string().min(1)).max(12).parse(JSON.parse(project.reference_dirs))
      .map((path, index) => ({ alias: `dir-${index + 1}`, path }));
  }
  if (project.reference_access !== 'projects') return [];
  const selected = configuredProjects(db, projectId);
  return enabledProjects(db).filter(row => selected === null || selected.includes(Number(row.id)))
    .map(row => ({ alias: `project-${row.id}`, path: String(row.repo_path), projectId: Number(row.id) }));
}

function keyFor(roots: Candidate[]) { return createHash('sha256').update(JSON.stringify(roots)).digest('hex'); }

export async function captureReferenceScope(db: DatabaseSync, taskId: number, projectId: number, project: WorkerProject,
  policy: ReferencePolicy, signal?: AbortSignal): Promise<ReferenceScope> {
  const selected = candidates(db, taskId, projectId, project, policy.env);
  const roots = new Map<string, { pin: PinnedReference; projectId?: number }>();
  for (const item of selected) {
    signal?.throwIfAborted();
    try { roots.set(item.alias, { pin: await pinReferenceRoot(item.path, policy), projectId: item.projectId }); }
    catch { /* Archived paths and paths outside approved roots are never exposed. */ }
  }
  const key = keyFor(selected);
  const bindingKey = createHash('sha256').update(JSON.stringify([key, [...roots].map(([alias, root]) => [alias, root.pin.sha256])])).digest('hex');
  return { key, bindingKey, roots };
}

export function referenceScopeCurrent(db: DatabaseSync, taskId: number, projectId: number, project: WorkerProject,
  env: NodeJS.ProcessEnv, scope: ReferenceScope) {
  return scope.key === keyFor(candidates(db, taskId, projectId, project, env));
}

export function registerReferenceControls(app: FastifyInstance, db: DatabaseSync, policy: ReferencePolicy) {
  app.get('/api/v1/projects/:id/reference-projects', async request => {
    admin(request.principal);
    const { id } = projectParam.parse(request.params);
    if (!db.prepare('SELECT id FROM projects WHERE id=? AND NOT archived').get(id)) fail(404, '项目不存在');
    const items = enabledProjects(db).map(({ id, name }) => ({ id, name }));
    return { project_ids: configuredProjects(db, id), items };
  });
  app.put('/api/v1/projects/:id/reference-projects', async request => {
    admin(request.principal);
    const { id } = projectParam.parse(request.params);
    const { project_ids } = z.strictObject({ project_ids: ids.nullable() }).parse(request.body);
    const verified = new Map<number, string>();
    for (const projectId of project_ids ?? []) {
      const row = db.prepare('SELECT repo_path FROM projects WHERE id=? AND enabled AND NOT archived').get(projectId);
      if (typeof row?.repo_path !== 'string') fail(422, '参考项目不存在、未启用或已归档');
      try { await pinReferenceRoot(row.repo_path, policy); }
      catch { fail(422, '参考项目目录超出只读资料范围'); }
      verified.set(projectId, row.repo_path);
    }
    return tx(db, () => {
      if (!db.prepare('SELECT id FROM projects WHERE id=? AND NOT archived').get(id)) fail(404, '项目不存在');
      for (const [projectId, path] of verified) {
        if (!db.prepare('SELECT id FROM projects WHERE id=? AND enabled AND NOT archived AND repo_path=?').get(projectId, path)) {
          fail(409, '参考项目已变化');
        }
      }
      if (project_ids === null) db.prepare('DELETE FROM governance_settings WHERE key=?').run(settingKey(id));
      else db.prepare(`INSERT INTO governance_settings(key,value,updated_at) VALUES(?,?,?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`)
        .run(settingKey(id), JSON.stringify([...project_ids].sort((a, b) => a - b)), utc());
      audit(db, request.principal.user_id, 'project.reference_projects', id, { project_ids });
      return { project_ids: configuredProjects(db, id) };
    });
  });
  app.addHook('preHandler', async request => {
    if (request.method !== 'POST') return;
    const params = request.params as { task_id?: string; draft_id?: string };
    const url = request.routeOptions.url;
    const taskId = url === '/api/v1/tasks/:task_id/deliveries' ? Number(params.task_id)
      : url === '/api/v1/deliveries/:draft_id/publish'
        ? Number(db.prepare('SELECT task_id FROM reply_drafts WHERE id=?').get(Number(params.draft_id))?.task_id) : NaN;
    if (Number.isSafeInteger(taskId) && db.prepare(`SELECT id FROM events WHERE task_id=? AND event_type='analysis_reference_scope' LIMIT 1`).get(taskId)) {
      owned(db, taskId, request.principal);
      fail(409, '跨目录分析只在工作台内查看，禁止渠道外发');
    }
  });
}
