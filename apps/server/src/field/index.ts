import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Storage } from '../../../../packages/storage/src/index.ts';
import { fail } from '../auth.js';
import { admin, tx, utc, type Row } from '../sql.js';
import { decisionInput, fieldId, implementationInput, imageLimit, orderedSegments, organize,
  positive, recordInput, type Draft, type Segment } from './contracts.js';
import { candidateView, decide, implement, json, playback, projectFor, targets } from './decisions.js';
import { attachmentRoot, decodeImage, imageView, loadImage, newFolder, removeNewFolder, writeImage, type Image } from './files.js';
import { registerFieldMedia } from './media.js';
import { fieldProcessor } from './processor.js';

export function persistRecord(db: DatabaseSync, id: string, project: number, title: string, notes: string,
  images: Image[], segments: Segment[], drafts: Draft[], owner: string) {
  db.prepare('INSERT INTO field_records(id,project_id,title,notes,screenshots,owner_id,created_at) VALUES(?,?,?,?,?,?,?)')
    .run(id, project, title, notes, JSON.stringify(images), owner, utc());
  if (segments.length) db.prepare('INSERT INTO field_timelines(record_id,transcript) VALUES(?,?)').run(id, JSON.stringify(segments));
  const candidate = db.prepare('INSERT INTO field_candidates(record_id,draft) VALUES(?,?)');
  for (const draft of drafts) candidate.run(id, JSON.stringify(draft));
}

function findRecord(db: DatabaseSync, id: string): Row {
  return db.prepare('SELECT * FROM field_records WHERE id=?').get(id) ?? fail(404, '现场记录不存在');
}

function viewRecord(db: DatabaseSync, row: Row) {
  const id = String(row.id);
  const candidates = db.prepare('SELECT * FROM field_candidates WHERE record_id=? ORDER BY id').all(id).map(candidateView);
  return { ...row,
    organizer: candidates[0]?.draft.organizer ?? 'offline_sample',
    timeline_imported: Boolean(db.prepare('SELECT 1 FROM field_timelines WHERE record_id=?').get(id)),
    media: playback(db, id),
    screenshots: json<Image[]>(row.screenshots).map((image, index) => imageView(image, index + 1)),
    candidates,
  };
}

const base = '/api/v1/field-intake';
const readId = (value: unknown) => fieldId.parse(value);
const numeric = (value: string) => positive.parse(Number(value));
const requireAdmin = async (request: FastifyRequest) => admin(request.principal);
const protectedBytes = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };

export function registerField(app: FastifyInstance, store: Storage, root: string, env: NodeJS.ProcessEnv) {
  const db = store.db;
  const attachments = attachmentRoot(root, env);
  const processor = fieldProcessor(env, root);
  app.register(async field => {
    field.addHook('onRequest', requireAdmin);
    field.get(base + '/organizer', async () => ({ mode: 'local_evidence', timeline: true, ocr: processor.ocr }));
    field.get(base + '/records', async () => db.prepare(`SELECT id,title,project_id,created_at FROM field_records
      ORDER BY created_at DESC,id DESC LIMIT 50`).all());
    field.post(base + '/records', { bodyLimit: 5 * 4 * Math.ceil(imageLimit / 3) + 768 * 1024 }, async request => {
      const body = recordInput.parse(request.body);
      projectFor(db, body.project_id);
      const frames = new Map(body.timeline?.keyframes.map(frame => [frame.filename.toLowerCase(), frame]) ?? []);
      const submitted = new Set(body.screenshots.map(image => image.filename.toLowerCase()));
      if (body.timeline && (submitted.size !== body.screenshots.length || submitted.size !== frames.size ||
        [...submitted].some(name => !frames.has(name)))) fail(422, '上传截图须与时间轴中的文件名一一对应');
      const segments = orderedSegments(body.timeline?.transcript ?? []);
      const id = randomUUID();
      const folder = body.screenshots.length ? newFolder(attachments, 'field', id) : undefined;
      try {
        const images = body.screenshots.map((image, index) => {
          const frame = frames.get(image.filename.toLowerCase());
          return writeImage(folder!, image.filename, index + 1, image.mime, decodeImage(image.base64), frame?.at_ms, frame?.ocr);
        });
        if (images.length && !body.timeline && processor.ocr) {
          const result = await processor.readScreenshots(images.map(image => image.local_path));
          images.forEach((image, index) => { image.ocr = result[index]; });
        }
        const drafts = organize(body.notes, images, segments);
        return tx(db, () => {
          projectFor(db, body.project_id);
          persistRecord(db, id, body.project_id, body.title, body.notes, images, segments, drafts, request.principal.user_id);
          return viewRecord(db, findRecord(db, id));
        });
      } catch (error) {
        if (folder) removeNewFolder(folder);
        throw error;
      }
    });
    field.get<{ Params: { id: string } }>(base + '/records/:id', async request =>
      viewRecord(db, findRecord(db, readId(request.params.id))));
    field.get<{ Params: { id: string; number: string } }>(base + '/records/:id/screenshots/:number', async (request, reply) => {
      const id = readId(request.params.id);
      const row = findRecord(db, id);
      const screenshot = json<Image[]>(row.screenshots)[numeric(request.params.number) - 1] ?? fail(404, '截图不存在');
      return reply.headers(protectedBytes).type(screenshot.content_type).send(loadImage(attachments, id, screenshot));
    });
    field.get<{ Params: { id: string; segment: string } }>(base + '/records/:id/transcript/:segment', async request => {
      const id = readId(request.params.id);
      const row = db.prepare('SELECT transcript FROM field_timelines WHERE record_id=?').get(id);
      const segment = row && json<Segment[]>(row.transcript).find(item => item.id === request.params.segment);
      return segment ?? fail(404, '转写片段不存在');
    });
    field.get<{ Params: { id: string } }>(base + '/records/:id/targets', async request =>
      targets(db, Number(findRecord(db, readId(request.params.id)).project_id)));
    field.post<{ Params: { id: string } }>(base + '/candidates/:id/decision', async request =>
      decide(db, attachments, numeric(request.params.id), request.principal, decisionInput.parse(request.body)));
    field.post<{ Params: { id: string } }>(base + '/analysis/:id/implement', async request =>
      implement(db, attachments, numeric(request.params.id), request.principal, implementationInput.parse(request.body)));
    registerFieldMedia(field, db, attachments, processor, persistRecord);
  });
}
