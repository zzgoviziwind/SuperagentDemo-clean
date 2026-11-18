import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, parse, sep } from 'node:path';
import { fail } from '../auth.js';
import { fieldId, imageLimit, imageMime, type OcrLine } from './contracts.js';

export const suffixes = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' } as const;
export const mediaTypes = { '.mp4': 'video/mp4', '.webm': 'video/webm', '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4' } as const;

export type Image = { filename: string; local_path: string; size: number; sha256: string;
  content_type: keyof typeof suffixes; at_ms?: number; ocr?: OcrLine[] };
export type MediaMetadata = { filename: string; suffix: keyof typeof mediaTypes; size: number; content_type: string;
  duration_ms?: number; video?: boolean };

export function checkedFilename(value: string) {
  if (!value || value.length > 180 || /[\u0000-\u001f/\\:<>"|?*]|[. ]$/.test(value) ||
      /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(value.split('.')[0].trimEnd())) {
    fail(422, '文件名称不合法');
  }
  return value;
}

const pngMagic = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const jpegMagic = Buffer.from([255, 216, 255]);
function checkImage(bytes: Buffer, mime: keyof typeof suffixes) {
  const valid = mime === 'image/png' ? bytes.subarray(0, pngMagic.length).equals(pngMagic)
    : mime === 'image/jpeg' ? bytes.subarray(0, jpegMagic.length).equals(jpegMagic)
    : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  if (!valid) fail(422, '截图格式或内容不匹配');
}

export function decodeImage(encoded: string) {
  const bytes = Buffer.from(encoded, 'base64');
  if (!bytes.length || bytes.length > imageLimit || bytes.toString('base64') !== encoded) {
    fail(422, '截图编码无效或超过 2 MB');
  }
  return bytes;
}

export function sha256(bytes: Buffer) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function attachmentRoot(root: string, env: NodeJS.ProcessEnv) {
  const selected = env.SUPERAGENT_ATTACHMENTS_ROOT || join(root, 'attachments');
  if (!isAbsolute(selected)) throw new Error('现场附件目录必须是绝对路径');
  return resolve(selected);
}

function plainPath(path: string, allowMissing = false) {
  const volume = parse(path).root;
  let current = volume;
  for (const name of path.slice(volume.length).split(sep).filter(Boolean)) {
    current = join(current, name);
    const stat = lstatSync(current, { throwIfNoEntry: false });
    if (!stat && allowMissing) return;
    if (!stat || stat.isSymbolicLink()) throw new Error('Invalid managed attachment path');
  }
}

export function newFolder(root: string, kind: 'field' | 'field-media', id: string) {
  const base = join(root, kind);
  plainPath(base, true);
  mkdirSync(base, { recursive: true });
  const folder = join(base, id);
  plainPath(base);
  mkdirSync(folder);
  return folder;
}

export function removeNewFolder(folder: string) {
  plainPath(folder);
  rmSync(folder, { recursive: true, force: true });
}

export function frameFolder(source: string, attempt: string) {
  const parent = dirname(source);
  plainPath(parent);
  const folder = join(parent, fieldId.parse(attempt));
  mkdirSync(folder);
  return folder;
}

export function extractedImage(folder: string, filename: string, at_ms: number): Image {
  if (!/^frame-[1-5]\.jpg$/.test(filename)) throw new Error('Unrecognized extracted frame');
  const path = join(folder, filename);
  plainPath(path);
  const file = statSync(path);
  if (!file.isFile() || file.size > 10 * 1024 * 1024) throw new Error('Invalid extracted frame size');
  const bytes = readFileSync(path);
  checkImage(bytes, 'image/jpeg');
  return { filename, local_path: path, size: bytes.length, sha256: sha256(bytes), content_type: 'image/jpeg', at_ms };
}

export function writeImage(folder: string, name: string, number: number, mime: keyof typeof suffixes, bytes: Buffer,
  at_ms?: number, ocr?: OcrLine[], prefix = ''): Image {
  checkedFilename(name);
  if (bytes.length > imageLimit) fail(422, '截图超过 2 MB');
  checkImage(bytes, mime);
  const path = join(folder, `${prefix}${number}.${suffixes[mime]}`);
  writeFileSync(path, bytes, { flag: 'wx' });
  return { filename: name, local_path: path, content_type: mime, size: bytes.length, sha256: sha256(bytes),
    ...(at_ms === undefined ? {} : { at_ms }), ...(ocr ? { ocr } : {}) };
}

export function imageView(image: Image, id: number) {
  return { id, filename: image.filename, ...(image.at_ms === undefined ? {} : { at_ms: image.at_ms }) };
}

function readManagedImage(root: string, expectedId: string | undefined, image: Image) {
  try {
    const normalized = image.local_path.replaceAll('\\', '/');
    const parts = normalized.split('/');
    const index = parts.findIndex((part, offset) => (part === 'field' || part === 'field-media')
      && fieldId.safeParse(parts[offset + 1]).success && (!expectedId || parts[offset + 1] === expectedId));
    if (index < 0) throw new Error('Unknown legacy attachment layout');
    const tail = parts.slice(index + 2);
    // Original extracted frames have one attempt UUID as their parent.
    if (!tail.length || tail.length > 2 || tail.some(part => !/^[a-z0-9][a-z0-9_.-]*$/i.test(part))) {
      throw new Error('Invalid managed attachment name');
    }
    const path = join(root, ...parts.slice(index, index + 2), ...tail);
    plainPath(path);
    const stat = statSync(path);
    if (!stat.isFile() || stat.size !== image.size || stat.size > 10 * 1024 * 1024) throw new Error('Wrong file size');
    const bytes = readFileSync(path);
    if (sha256(bytes) !== image.sha256) throw new Error('Wrong checksum');
    checkImage(bytes, imageMime.parse(image.content_type));
    return { path, bytes };
  } catch {
    return fail(404, '截图不可用');
  }
}

export function loadImage(root: string, id: string, image: Image) {
  return readManagedImage(root, id, image).bytes;
}

export function attachmentForTask(root: string, image: Image, recordId?: string) {
  const { path } = readManagedImage(root, recordId, image);
  return JSON.stringify({ ...image, local_path: path });
}

export function mediaSource(root: string, id: string, media: MediaMetadata) {
  try {
    if (!Object.hasOwn(mediaTypes, media.suffix)) throw new Error('Unknown media type');
    const path = join(root, 'field-media', id, `source${media.suffix}`);
    plainPath(path);
    const stat = statSync(path);
    if (!stat.isFile() || stat.size !== media.size) throw new Error('Wrong file size');
    return path;
  } catch {
    return fail(404, '原音视频不可用');
  }
}
