import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import { openStorage, type Storage } from '../../../../packages/storage/src/index.ts';
import { registerAuth } from '../auth.js';
import { registerProjects } from '../projects.js';
import { utc } from '../sql.js';
import { sha256 } from './files.js';
import { persistRecord, registerField } from './index.js';
import { registerFieldMedia } from './media.js';

const base = '/api/v1/field-intake';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO5+1ZYAAAAASUVORK5CYII=', 'base64');
const screenshot = { filename: '模拟.png', mime: 'image/png', base64: png.toString('base64') };
const admin = { authorization: 'Bearer synthetic-admin' };
const env = { SUPERAGENT_API_TOKEN: 'synthetic-admin',
  SUPERAGENT_USERS_JSON: '[{"user_id":"viewer","role":"viewer","token":"synthetic-viewer"}]' };

describe('Field Intake with the production SQLite schema', () => {
  let root: string;
  let app: FastifyInstance;
  let store: Storage;
  let project: number;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'sa-field-'));
    store = openStorage(join(root, 'field.sqlite'), { stateRoot: root });
    app = Fastify({ bodyLimit: 1024 });
    app.setErrorHandler((error, _request, reply) => {
      const failure = error as { statusCode?: number; message?: string };
      reply.code(error instanceof ZodError ? 422 : failure.statusCode ?? 500).send({ detail: failure.message });
    });
    registerAuth(app, env);
    registerProjects(app, store.db, env);
    registerField(app, store, root, env);
    const created = await app.inject({ method: 'POST', url: '/api/v1/projects', headers: admin,
      payload: { name: '合成医院项目', repo_path: root } });
    expect(created.statusCode).toBe(200);
    project = created.json().id;
  });

  afterEach(async () => {
    await app.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  function api(path: string) { return app.inject({ url: base + path, headers: admin }); }
  function post(path: string, payload: object) {
    return app.inject({ method: 'POST', url: base + path, headers: admin, payload });
  }
  async function record(notes = 'Bug：模拟现象。[截图1]\n需求：请评估。') {
    const response = await post('/records', { project_id: project, title: '现场合成记录', notes, screenshots: [screenshot] });
    expect(response.statusCode).toBe(200);
    return response.json();
  }

  it('imports timestamped evidence, serves verified screenshots and identifies missing optional media', async () => {
    const response = await post('/records', { project_id: project, title: '合成时间轴', screenshots: [screenshot], timeline: {
      version: 1, transcript: [{ text: '较晚发言', start_ms: 400, end_ms: 700 }, { text: '较早发言', start_ms: 100, end_ms: 350 }],
      keyframes: [{ filename: screenshot.filename, at_ms: 350, ocr: [{ text: '截图原文', box: [0, 0, 2, 2] }] }],
    } });
    expect(response.statusCode).toBe(200);
    const row = response.json();
    expect(row).toMatchObject({ timeline_imported: true, organizer: 'local_evidence',
      screenshots: [{ id: 1, filename: screenshot.filename, at_ms: 350 }] });
    expect(row.candidates[0].draft.evidence).toMatchObject([{ id: 'S1:1', text: '截图原文', candidate_segments: ['T1'] }]);
    expect(row.candidates[1].draft.evidence[0]).toMatchObject({ id: 'T1', text: '较早发言' });
    expect((await api(`/records/${row.id}/transcript/T2`)).json().text).toBe('较晚发言');
    const image = await api(`/records/${row.id}/screenshots/1`);
    expect(image.headers['content-type']).toBe('image/png');
    expect(image.rawPayload).toEqual(png);
    expect((await app.inject({ url: base + '/records', headers: { authorization: 'Bearer synthetic-viewer' } })).statusCode).toBe(403);
    expect((await api('/media-jobs')).json()).toMatchObject({ ready: false, reason: expect.stringContaining('未配置') });
    expect((await post('/media-jobs', {})).statusCode).toBe(409);
    expect((await post('/records', { project_id: project, title: '错误截图', screenshots: [{ ...screenshot, filename: '../evil.png' }] })).statusCode).toBe(422);
  });

  it('migrates legacy attachment locations, verifies bytes, and supports original media ranges', async () => {
    const id = randomUUID();
    const rootImage = join(root, 'attachments', 'field', id);
    mkdirSync(rootImage, { recursive: true });
    writeFileSync(join(rootImage, '1.png'), png);
    store.db.prepare('INSERT INTO field_records VALUES(?,?,?,?,?,?,?)').run(id, project, '旧现场', '旧笔记', JSON.stringify([{
      filename: '旧图.png', local_path: `Z:/old-profile/attachments/field/${id}/1.png`, content_type: 'image/png',
      size: png.length, sha256: sha256(png),
    }]), 'admin', utc());
    const mediaFolder = join(root, 'attachments', 'field-media', id);
    mkdirSync(mediaFolder, { recursive: true });
    writeFileSync(join(mediaFolder, 'source.wav'), '0123456789');
    store.db.prepare(`INSERT INTO field_media_jobs(id,project_id,title,owner_id,state,phase,media,screenshots,created_at)
      VALUES(?,?,?,?,'ready','ready',?,'[]',?)`).run(id, project, '旧现场', 'admin', JSON.stringify({
      filename: '原始语音.wav', suffix: '.wav', size: 10, content_type: 'audio/wav', duration_ms: 50, video: false,
    }), utc());
    expect((await api('/records')).json()[0]).toMatchObject({ id, title: '旧现场' });
    expect((await api(`/records/${id}`)).body).not.toContain('Z:/old-profile');
    expect((await api(`/records/${id}/screenshots/1`)).rawPayload).toEqual(png);
    const range = await app.inject({ url: base + `/records/${id}/media`, headers: { ...admin, range: 'bytes=2-5' } });
    expect(range.statusCode).toBe(206);
    expect(range.headers['content-range']).toBe('bytes 2-5/10');
    expect(range.body).toBe('2345');
    expect((await app.inject({ url: base + `/records/${id}/media`, headers: { ...admin, range: 'bytes=11-' } })).statusCode).toBe(416);
    writeFileSync(join(rootImage, '1.png'), Buffer.alloc(png.length));
    expect((await api(`/records/${id}/screenshots/1`)).statusCode).toBe(404);
  });

  it('records one review decision, protects task versions and approves implementation only with verified analysis', async () => {
    const item = await record();
    const create = { action: 'create', title: '模拟分析', detail: '检查合成资料', kind: 'bug' };
    const decisionPath = `/candidates/${item.candidates[0].id}/decision`;
    const [one, two] = await Promise.all([post(decisionPath, create), post(decisionPath, create)]);
    expect(one.statusCode).toBe(200);
    expect(two.json()).toEqual(one.json());
    const task = one.json().decision.task_id;
    expect(store.db.prepare('SELECT kind,source FROM tasks WHERE id=?').get(task)).toEqual({ kind: 'analysis', source: 'field' });
    expect((await post(decisionPath, { action: 'dismiss' })).statusCode).toBe(409);
    const linkPath = `/candidates/${item.candidates[1].id}/decision`;
    const link = { action: 'link', title: '补充', detail: '额外合成证据', kind: 'requirement', task_id: task };
    expect((await post(linkPath, { ...link, expected_state_version: 0 })).statusCode).toBe(409);
    expect((await post(linkPath, { ...link, expected_state_version: 1 })).statusCode).toBe(200);
    const implement = { expected_state_version: 2, scope: '修改合成测试范围', acceptance_criteria: '确认合成条件' };
    const implementPath = `/analysis/${task}/implement`;
    expect((await post(implementPath, implement)).statusCode).toBe(409);
    store.db.prepare("UPDATE tasks SET status='review_ready' WHERE id=?").run(task);
    const add = store.db.prepare('INSERT INTO artifacts(task_id,revision,kind,content,attempt_id,created_at) VALUES(?,2,?,?,?,?)');
    add.run(task, 'summary', '已核对的合成分析', 'evidence-a', utc());
    const proof = JSON.stringify({ has_changes: false, analysis_read_evidence: { evidence_calls: 1 } });
    add.run(task, 'verification', proof, 'evidence-b', utc());
    expect((await post(implementPath, implement)).statusCode).toBe(409);
    add.run(task, 'verification', proof, 'evidence-a', utc());
    const approved = await post(implementPath, implement);
    expect(approved.statusCode).toBe(200);
    expect((await post(implementPath, implement)).json()).toEqual(approved.json());
    expect((await post(implementPath, { ...implement, scope: '越过原批准范围' })).statusCode).toBe(409);
    expect(store.db.prepare('SELECT kind,goal FROM tasks WHERE id=?').get(approved.json().task_id)).toEqual({ kind: 'repair', goal: implement.scope });
  });

  it('accepts multipart audio and video when the optional processor is ready and stops at candidate review', async () => {
    const media = Fastify();
    registerAuth(media, env);
    const probe = {
      media: true, mediaReason: '', ocr: false,
      probe: async () => {}, close: () => {},
      readScreenshots: async () => [],
      transcribe: async () => ({ duration: 9500, video: true, segments: [{ start_ms: 1000, end_ms: 2500,
        speaker: '', text: '合成发言内容' }] }),
      frames: async (_path: string, folder: string, moments: number[]) => {
        writeFileSync(join(folder, 'frame-1.jpg'), Buffer.from([255, 216, 255, 224]));
        return [{ filename: 'frame-1.jpg', at_ms: moments[0] }];
      },
    };
    registerFieldMedia(media, store.db, join(root, 'attachments'), probe, persistRecord);
    try {
      const form = new FormData();
      form.set('details', JSON.stringify({ project_id: project, title: '合成录屏' }));
      form.set('media', new File([Buffer.from('0000ftypisom')], 'sample.mp4', { type: 'video/mp4' }));
      const request = new Request('http://127.0.0.1:55555', { method: 'POST', body: form });
      const payload = Buffer.from(await request.arrayBuffer());
      const submitted = await media.inject({ method: 'POST', url: base + '/media-jobs', payload, headers: {
        ...admin, 'content-type': request.headers.get('content-type')!, 'content-length': String(payload.length),
      } });
      expect(submitted.statusCode).toBe(202);
      const { id } = submitted.json();
      await vi.waitFor(() => {
        expect(store.db.prepare('SELECT state FROM field_media_jobs WHERE id=?').get(id)?.state).toBe('ready');
      }, { timeout: 4000, interval: 25 });
      const result = (await api(`/records/${id}`)).json();
      expect(result.media).toMatchObject({ video: true, duration_ms: 9500 });
      expect(result.screenshots[0]).toMatchObject({ filename: 'frame-1.jpg', at_ms: 1750 });
      expect(result.candidates).toHaveLength(2);
      expect(store.db.prepare('SELECT count(*) AS count FROM tasks').get()?.count).toBe(0);
    } finally {
      await media.close();
    }
  }, 8000);
});
