import { randomUUID } from 'node:crypto';
import { createReadStream, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { fail } from '../auth.js';
import { tx, utc, type Row } from '../sql.js';
import { fieldId, imageLimit, imageMime, mediaLimit, orderedSegments, organize, positive, timestamp, title, type Segment } from './contracts.js';
import { json, projectFor } from './decisions.js';
import { checkedFilename, extractedImage, frameFolder, mediaSource, mediaTypes, newFolder, removeNewFolder, writeImage,
  type Image, type MediaMetadata } from './files.js';
import type { persistRecord } from './index.js';
import type { FieldProcessor } from './processor.js';

const base = '/api/v1/field-intake';
const uploadLimit = mediaLimit + 5 * imageLimit + 65536;
const uploadDetails = z.object({ project_id: positive, title, screenshot_times: z.array(timestamp).max(5).default([]) });
const jobColumns = 'id,title,state,phase,error,created_at';

function matchMedia(ext: string, bytes: Buffer) {
  if (ext === '.mp4' || ext === '.m4a') return bytes.toString('ascii', 4, 8) === 'ftyp';
  if (ext === '.webm') return bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  if (ext === '.wav') return bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WAVE';
  return bytes.toString('ascii', 0, 3) === 'ID3' || (bytes.length >= 2 && bytes[0] === 255 && (bytes[1] & 224) === 224);
}

function serveMedia(reply: FastifyReply, path: string, media: MediaMetadata, header?: string) {
  const mime = media.suffix === '.mp4' && media.video === false ? 'audio/mp4' : mediaTypes[media.suffix];
  const name = encodeURIComponent(checkedFilename(media.filename)).replace(/['()*]/g, char =>
    '%' + char.charCodeAt(0).toString(16).toUpperCase());
  reply.headers({ 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff', 'Content-Disposition': `inline; filename*=UTF-8''${name}` }).type(mime);
  if (!header) return reply.header('Content-Length', media.size).send(createReadStream(path));
  const range = /^bytes=(\d*)-(\d*)$/.exec(header);
  const invalid = () => reply.code(416).header('Content-Range', `bytes */${media.size}`).send();
  if (!range || (!range[1] && !range[2])) return invalid();
  const start = range[1] ? Number(range[1]) : Math.max(0, media.size - Number(range[2]));
  const end = range[1] && range[2] ? Math.min(media.size - 1, Number(range[2])) : media.size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || (range[2] && !Number.isSafeInteger(Number(range[2])))) {
    return invalid();
  }
  return reply.code(206).header('Content-Range', `bytes ${start}-${end}/${media.size}`)
    .header('Content-Length', end - start + 1).send(createReadStream(path, { start, end }));
}

function frameMoments(segments: Segment[], images: Image[]) {
  const covered = images.flatMap(row => row.at_ms === undefined ? [] : [row.at_ms]);
  const selected: number[] = [];
  for (const row of segments) {
    if (images.length + selected.length >= 5) break;
    if (covered.some(at => Math.max(row.start_ms - at, at - row.end_ms, 0) <= 5000)) continue;
    const moment = Math.floor((row.start_ms + row.end_ms) / 2);
    selected.push(moment);
    covered.push(moment);
  }
  return selected;
}

export function registerFieldMedia(app: FastifyInstance, db: DatabaseSync, root: string, processor: FieldProcessor,
  save: typeof persistRecord) {
  let active: Promise<void> | undefined;
  let closing = false;
  let timer: NodeJS.Timeout | undefined;
  const markFailed = db.prepare(`UPDATE field_media_jobs SET state='failed',phase='failed',deadline=NULL,error=?
    WHERE id=? AND state='running' AND attempt=?`);

  async function process(job: Row, token: string) {
    const id = String(job.id);
    let extracted: string | undefined;
    try {
      const media = json<MediaMetadata>(job.media);
      const images = json<Image[]>(job.screenshots);
      const source = mediaSource(root, id, media);
      const result = await processor.transcribe(source);
      if (closing) throw new Error('Server is closing');
      if (images.some(row => (row.at_ms ?? 0) > result.duration)) {
        markFailed.run('有截图时间超出原音视频时长', id, token);
        return;
      }
      const segments = orderedSegments(result.segments);
      const moments = result.video ? frameMoments(segments, images) : [];
      if (moments.length) {
        db.prepare("UPDATE field_media_jobs SET phase='extracting' WHERE id=? AND state='running' AND attempt=?").run(id, token);
        extracted = frameFolder(source, token);
        const frames = await processor.frames(source, extracted, moments);
        if (closing || frames.some(frame => frame.at_ms > result.duration)) throw new Error('Frame timeline mismatch');
        images.push(...frames.map(frame => extractedImage(extracted!, frame.filename, frame.at_ms)));
      }
      const drafts = organize('', images, segments);
      tx(db, () => {
        projectFor(db, Number(job.project_id));
        const finished = db.prepare(`UPDATE field_media_jobs SET state='ready',phase='ready',deadline=NULL,media=?
          WHERE id=? AND state='running' AND attempt=?`).run(JSON.stringify({ ...media, duration_ms: result.duration, video: result.video }), id, token);
        if (finished.changes !== 1) return;
        save(db, id, Number(job.project_id), String(job.title), '', images, segments, drafts, String(job.owner_id));
      });
    } catch {
      if (extracted) {
        try { removeNewFolder(extracted); } catch { app.log.error('Failed to remove incomplete local field media frames'); }
      }
      markFailed.run(closing ? '服务停止，处理已中断，请人工重试'
        : '本机音视频处理失败，请核对依赖、原文件内容和长度，必要时分段后重试', id, token);
    }
  }

  function poll() {
    if (!processor.media || closing || active) return;
    const attempt = randomUUID();
    const job = db.prepare(`UPDATE field_media_jobs SET state='running',phase='transcribing',attempt=?,deadline=?,error=NULL
      WHERE id=(SELECT id FROM field_media_jobs WHERE state='queued' ORDER BY created_at,id LIMIT 1) AND state='queued' RETURNING *`)
      .get(attempt, Date.now() / 1000 + 1200);
    if (job) active = process(job, attempt).catch(() => {
      app.log.error('Failed to update a local field media job');
    }).finally(() => { active = undefined; });
  }

  app.addHook('onReady', async () => {
    db.prepare(`UPDATE field_media_jobs SET state='failed',phase='failed',deadline=NULL,error=?
      WHERE state='running'`).run('上次处理已中断，请人工重试');
    await processor.probe();
    if (processor.media) {
      timer = setInterval(() => {
        try { poll(); } catch { app.log.error('Failed to poll local field media jobs'); }
      }, 2000);
      timer.unref();
    }
  });
  app.addHook('preClose', async () => {
    closing = true;
    clearInterval(timer);
    processor.close();
    await active;
  });
  app.get(base + '/media-jobs', async () => ({
    ready: processor.media, ...(processor.media ? {} : { reason: processor.mediaReason }),
    jobs: db.prepare(`SELECT ${jobColumns} FROM field_media_jobs ORDER BY created_at DESC,id DESC LIMIT 30`).all(),
  }));
  app.get<{ Params: { id: string } }>(base + '/records/:id/media', async (request, reply) => {
    const id = fieldId.parse(request.params.id);
    const row = db.prepare("SELECT media FROM field_media_jobs WHERE id=? AND state='ready'").get(id) ?? fail(404, '原音视频不可用');
    const metadata = json<MediaMetadata>(row.media);
    return serveMedia(reply, mediaSource(root, id, metadata), metadata, request.headers.range);
  });
  app.post<{ Params: { id: string } }>(base + '/media-jobs/:id/retry', async (request, reply) => {
    if (!processor.media) fail(409, processor.mediaReason);
    const id = fieldId.parse(request.params.id);
    const job = db.prepare(`UPDATE field_media_jobs SET state='queued',phase='queued',attempt=NULL,deadline=NULL,error=NULL
      WHERE id=? AND state='failed' RETURNING ${jobColumns}`).get(id);
    if (!job) fail(409, '仅可重试已失败的任务');
    return reply.code(202).send(job);
  });

  // Node's built-in multipart parser keeps the uploaded form in memory. Limit
  // ingress both by Content-Length and to one authorized upload in flight.
  let uploading: string | undefined;
  app.addContentTypeParser('multipart/form-data', { parseAs: 'buffer', bodyLimit: uploadLimit },
    (_request, body, callback) => callback(null, body));
  app.post(base + '/media-jobs', {
    bodyLimit: uploadLimit,
    onRequest: async request => {
      if (!processor.media) fail(409, processor.mediaReason);
      const length = Number(request.headers['content-length']);
      if (!Number.isSafeInteger(length) || length <= 0) fail(411, '上传须提供请求大小');
      if (length > uploadLimit) fail(413, '音视频或截图超过上传大小限制');
      if (uploading !== undefined) fail(429, '已有现场音视频在上传，请稍后重试');
      uploading = request.id;
      request.raw.once('aborted', () => { if (uploading === request.id) uploading = undefined; });
    },
    onResponse: async request => { if (uploading === request.id) uploading = undefined; },
  }, async (request, reply) => {
    if (!Buffer.isBuffer(request.body)) fail(422, '请使用音视频上传表单');
    let form: FormData;
    try {
      form = await new Response(new Uint8Array(request.body), { headers: { 'content-type': request.headers['content-type']! } }).formData();
    } catch {
      return fail(422, '上传表单无效');
    }
    const details = form.getAll('details');
    const sources = form.getAll('media');
    const screenshots = form.getAll('screenshots');
    if (details.length !== 1 || typeof details[0] !== 'string' || details[0].length > 8192 || sources.length !== 1 ||
      !(sources[0] instanceof File) || Array.from(form.keys()).some(key => !['media', 'details', 'screenshots'].includes(key))) {
      fail(422, '请提供标题、一个音视频文件以及每张截图的时间点');
    }
    let parsed: unknown;
    try { parsed = JSON.parse(details[0]); } catch { fail(422, '音视频上传信息无效'); }
    const body = uploadDetails.parse(parsed);
    const media = sources[0];
    if (screenshots.length !== body.screenshot_times.length || !media.size || media.size > mediaLimit) fail(422, '音视频或截图信息无效');
    const filename = checkedFilename(media.name);
    const suffix = extname(filename).toLowerCase() as keyof typeof mediaTypes;
    const prefix = Buffer.from(await media.slice(0, 32).arrayBuffer());
    if (!Object.hasOwn(mediaTypes, suffix) || !matchMedia(suffix, prefix)) fail(422, '音视频格式无效，请使用 MP4、WebM、WAV、MP3 或 M4A');
    projectFor(db, body.project_id);
    const id = randomUUID();
    const folder = newFolder(root, 'field-media', id);
    try {
      writeFileSync(join(folder, `source${suffix}`), Buffer.from(await media.arrayBuffer()), { flag: 'wx' });
      const images: Image[] = [];
      for (const [index, screenshot] of screenshots.entries()) {
        if (!(screenshot instanceof File) || !screenshot.size || screenshot.size > imageLimit) fail(422, '截图格式或大小无效');
        images.push(writeImage(folder, screenshot.name, index + 1, imageMime.parse(screenshot.type),
          Buffer.from(await screenshot.arrayBuffer()), body.screenshot_times[index], undefined, 'uploaded-'));
      }
      const job = tx(db, () => {
        projectFor(db, body.project_id);
        return db.prepare(`INSERT INTO field_media_jobs(id,project_id,title,owner_id,state,phase,media,screenshots,created_at)
          VALUES(?,?,?,?,'queued','queued',?,?,?) RETURNING ${jobColumns}`).get(id, body.project_id, body.title,
          request.principal.user_id, JSON.stringify({ filename, suffix, size: media.size, content_type: mediaTypes[suffix] }), JSON.stringify(images), utc());
      });
      return reply.code(202).send(job);
    } catch (error) {
      removeNewFolder(folder);
      throw error;
    }
  });
}
