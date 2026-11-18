import { isDeepStrictEqual } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';
import type { z } from 'zod';
import { fail, type Principal } from '../auth.js';
import { audit, owned, tx, utc, type Row } from '../sql.js';
import { decisionInput, implementationInput, type Draft } from './contracts.js';
import { attachmentForTask, imageView, type Image, type MediaMetadata } from './files.js';

export const linkable = ['queued', 'paused', 'waiting_input', 'review_ready', 'failed'];
const readonlyStates = "('queued','paused','waiting_input','review_ready','failed')";

export function json<T>(value: unknown): T {
  return JSON.parse(String(value)) as T;
}

export function projectFor(db: DatabaseSync, id: number) {
  if (!db.prepare('SELECT id FROM projects WHERE id=? AND enabled=1 AND archived=0').get(id)) {
    fail(422, '请选择可用项目');
  }
}

export function playback(db: DatabaseSync, ident: string) {
  const job = db.prepare("SELECT media FROM field_media_jobs WHERE id=? AND state='ready'").get(ident);
  if (!job) return null;
  const { video, duration_ms } = json<MediaMetadata>(job.media);
  return { video, duration_ms };
}

export function targets(db: DatabaseSync, project: number) {
  return db.prepare(`SELECT id,title,state_version FROM tasks WHERE project_id=? AND kind='analysis'
    AND status IN ${readonlyStates} AND NOT outcome_unknown ORDER BY id DESC LIMIT 100`).all(project);
}

export function candidateView(item: Row) {
  return { id: item.id, record_id: item.record_id, draft: json<Draft>(item.draft),
    decision: item.decision === null ? null : json(item.decision) };
}

function newTask(db: DatabaseSync, project: number, principal: Principal, kind: 'analysis' | 'repair',
  title: string, goal: string, criteria = '') {
  const now = utc();
  const task = db.prepare(`INSERT INTO tasks(project_id,owner_id,kind,title,goal,source,acceptance_criteria,status,
    revision,state_version,control_version,outcome_unknown,created_at,updated_at)
    VALUES(?,?,?,?,?,'field',?,'queued',1,1,1,0,?,?) RETURNING id,revision`)
    .get(project, principal.user_id, kind, title, goal, criteria, now, now)!;
  db.prepare('INSERT INTO governance_task_owners(task_id,user_id) VALUES(?,?)').run(task.id, principal.user_id);
  audit(db, principal.user_id, 'task.assign', Number(task.id), { user_id: principal.user_id });
  return task;
}

function fieldImages(db: DatabaseSync, task: Row) {
  return db.prepare("SELECT content FROM artifacts WHERE task_id=? AND kind='field_attachment' ORDER BY id")
    .all(task.id).map(row => String(row.content));
}

function addImages(db: DatabaseSync, task: Row, images: string[]) {
  const existing = new Set(fieldImages(db, task));
  const extra = [...new Set(images)].filter(image => !existing.has(image));
  const count = db.prepare(`SELECT count(*) AS count FROM artifacts
    WHERE task_id=? AND revision=? AND kind='source_attachment'`).get(task.id, task.revision);
  if (existing.size + extra.length + Number(count?.count) > 10) fail(409, '当前事件附件超限，请创建新的只读事件');
  const add = db.prepare("INSERT INTO artifacts(task_id,revision,kind,content,created_at) VALUES(?,?,'field_attachment',?,?)");
  for (const image of extra) add.run(task.id, task.revision, image, utc());
}

function linkTask(db: DatabaseSync, project: number, principal: Principal, body: z.infer<typeof decisionInput>) {
  if (body.task_id === null || body.expected_state_version === null) fail(409, '请关联同项目可补充的只读事件');
  const task = owned(db, body.task_id, principal);
  if (task.project_id !== project || task.kind !== 'analysis' || !linkable.includes(String(task.status)) || task.outcome_unknown ||
      task.state_version !== body.expected_state_version) fail(409, '请关联同项目可补充的只读事件，或刷新当前版本');
  const active = db.prepare(`SELECT 1 FROM execution_attempts
    WHERE task_id=? AND status IN ('claimed','running','waiting_approval','stopping')`).get(task.id);
  if (active) fail(409, '请先停止当前运行再补充现场记录');
  const updated = db.prepare(`UPDATE tasks SET revision=revision+1,state_version=state_version+1,control_version=control_version+1,
    status=CASE WHEN status='paused' THEN status ELSE 'queued' END,
    last_error=CASE WHEN status='paused' THEN last_error ELSE NULL END, updated_at=? WHERE id=? RETURNING *`).get(utc(), task.id)!;
  db.prepare(`INSERT INTO artifacts(task_id,revision,kind,content,created_at)
    SELECT task_id,?,kind,content,? FROM artifacts WHERE task_id=? AND revision=? AND kind='source_attachment'`)
    .run(updated.revision, utc(), task.id, task.revision);
  db.prepare("UPDATE approvals SET status='expired' WHERE task_id=? AND status='pending'").run(task.id);
  return updated;
}

const addEvent = (db: DatabaseSync) => db.prepare(`INSERT INTO events(task_id,source,external_id,event_type,content,data,created_at)
  VALUES(?,'field',?,?,?,?,?) RETURNING id`);

export function decide(db: DatabaseSync, attachments: string, id: number, principal: Principal, body: z.infer<typeof decisionInput>) {
  return tx(db, () => {
    const item = db.prepare('SELECT * FROM field_candidates WHERE id=?').get(id) ?? fail(404, '候选事项不存在');
    const prior = json<{ request: unknown } | null>(item.decision);
    if (prior) {
      if (!isDeepStrictEqual(prior.request, body)) fail(409, '候选事项已审核');
      return candidateView(item);
    }
    let taskId: number | null = null;
    let eventId: number | null = null;
    if (body.action !== 'dismiss') {
      const row = db.prepare('SELECT * FROM field_records WHERE id=?').get(item.record_id) ?? fail(404, '现场记录不存在');
      const project = Number(row.project_id);
      projectFor(db, project);
      const title = body.title.trim();
      if (!title || !body.detail.trim()) fail(422, '请填写事项标题和内容');
      const draft = json<Draft>(item.draft);
      const evidence = draft.evidence ?? [];
      const images = json<Image[]>(row.screenshots);
      const selected = draft.screenshots.map(id => {
        const image = images[id - 1];
        if (!image) fail(409, '候选事项引用的截图已不可用');
        return { id, image };
      });
      let content = `${title}\n${body.detail.trim()}`;
      if (draft.quote) content += `\n现场笔记第 ${draft.note_line} 行：${draft.quote}`;
      if (evidence.length) content += '\n现场证据：' + evidence.map(ref => `${ref.id} ${ref.text.slice(0, 150)}`).join('\n');
      const instruction = body.kind === 'bug' ? '只读排查疑似问题并给出可核对的线索' : '只读评估可行性并列出待澄清事项';
      const task = body.action === 'create'
        ? newTask(db, project, principal, 'analysis', title, `${instruction}。\n${content}`)
        : linkTask(db, project, principal, body);
      taskId = Number(task.id);
      addImages(db, task, selected.map(({ image }) => attachmentForTask(attachments, image, String(row.id))));
      eventId = Number(addEvent(db).get(taskId, `candidate:${id}`, 'message.received', content, JSON.stringify({
        actor_id: principal.user_id, routing_status: 'manually_linked', field_record_id: row.id,
        candidate_id: id, field_kind: body.kind, field_evidence: evidence, field_media: playback(db, String(row.id)),
        screenshots: selected.map(({ id, image }) => imageView(image, id)),
      }), utc())?.id);
    }
    const decision = { request: body, actor: principal.user_id, task_id: taskId, event_id: eventId, decided_at: utc() };
    db.prepare('UPDATE field_candidates SET decision=? WHERE id=?').run(JSON.stringify(decision), id);
    audit(db, principal.user_id, `field.candidate.${body.action}`, id, { task_id: taskId, source: 'field', decision: body.action });
    return { ...candidateView(item), decision };
  });
}

function verifiedSummary(db: DatabaseSync, task: Row) {
  const latest = db.prepare('SELECT id,content,attempt_id FROM artifacts WHERE task_id=? AND revision=? AND kind=? ORDER BY id DESC LIMIT 1');
  const verification = latest.get(task.id, task.revision, 'verification');
  const summary = latest.get(task.id, task.revision, 'summary');
  if (!verification || !summary || !String(summary.content).trim() || verification.attempt_id !== summary.attempt_id) return;
  try {
    const proof = json<{ has_changes?: unknown; analysis_read_evidence?: { evidence_calls?: unknown } }>(verification.content);
    const reads = proof.analysis_read_evidence?.evidence_calls;
    if (proof.has_changes === false && typeof reads === 'number' && Number.isInteger(reads) && reads > 0) return summary;
  } catch { /* Missing or invalid historical evidence cannot authorize implementation. */ }
}

export function implement(db: DatabaseSync, attachments: string, id: number, principal: Principal, body: z.infer<typeof implementationInput>) {
  return tx(db, () => {
    const parent = owned(db, id, principal);
    const externalId = `implementation:${id}:${parent.revision}`;
    const prior = db.prepare("SELECT task_id,data FROM events WHERE source='field' AND external_id=?").get(externalId);
    if (prior) {
      if (!isDeepStrictEqual(json<{ request: unknown }>(prior.data).request, body)) fail(409, '此版本已批准实施');
      return { task_id: prior.task_id };
    }
    const field = db.prepare("SELECT 1 FROM events WHERE task_id=? AND source='field' AND event_type='message.received'").get(id);
    const summary = verifiedSummary(db, parent);
    if (parent.kind !== 'analysis' || parent.outcome_unknown || !['review_ready', 'completed'].includes(String(parent.status))
      || !field || !summary || !body.scope.trim() || !body.acceptance_criteria.trim()) {
      fail(409, '请先取得当前版本的已核验只读分析结果，再批准实施');
    }
    const project = Number(parent.project_id);
    projectFor(db, project);
    const updated = db.prepare('UPDATE tasks SET state_version=state_version+1,updated_at=? WHERE id=? AND state_version=?')
      .run(utc(), id, body.expected_state_version);
    if (updated.changes !== 1) fail(409, '事件组已变化，请刷新');
    const task = newTask(db, project, principal, 'repair', `实施：${parent.title}`.slice(0, 300), body.scope.trim(), body.acceptance_criteria.trim());
    addImages(db, task, fieldImages(db, parent).map(value => attachmentForTask(attachments, json<Image>(value))));
    addEvent(db).get(task.id, externalId, 'implementation.approved', `分析事件 #${id} · 版本 ${parent.revision}\n${summary.content}`,
      JSON.stringify({ request: body, analysis_task_id: id, summary_id: summary.id, actor_id: principal.user_id }), utc());
    audit(db, principal.user_id, 'field.implementation.approve', id, { task_id: task.id, revision: parent.revision, source: 'field' });
    return { task_id: task.id };
  });
}
