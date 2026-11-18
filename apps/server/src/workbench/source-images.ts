import { randomUUID } from 'node:crypto';
import { lstatSync, readdirSync, realpathSync, unlinkSync } from 'node:fs';
import { open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { directory, inspectAttachment, MiB } from '../../../../packages/channels/resources.ts';
import type { AssessmentImage, DingTalkSourceImage } from './runtime.ts';

const perImageLimit = 10 * MiB;
const totalLimit = 20 * MiB;
const imageCountLimit = 4;
const extensions = new Map([['image/png', 'png'], ['image/jpeg', 'jpg'], ['image/gif', 'gif'], ['image/webp', 'webp']]);
const stagedName = /^source-[1-9][0-9]*-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.(?:png|jpg|gif|webp)$/;

export function sourceImagesWithinBudget(images: readonly DingTalkSourceImage[]): boolean {
  return images.length <= imageCountLimit && images.reduce((total, image) => total + image.bytes.length, 0) <= totalLimit;
}

export function verifySourceImages(images: readonly DingTalkSourceImage[]) {
  if (!Array.isArray(images) || images.length > imageCountLimit
    || images.some(image => !image || !Buffer.isBuffer(image.bytes) || !extensions.has(image.contentType))
    || !sourceImagesWithinBudget(images)) return [];
  const checked = new Map<string, { image: DingTalkSourceImage; evidence: { bytes: number; content_type: string; sha256: string } }>();
  try {
    for (const image of images) {
      if (!image.bytes.length || image.bytes.length > perImageLimit) return [];
      const bytes = Buffer.from(image.bytes);
      const info = inspectAttachment('source.' + extensions.get(image.contentType), bytes, image.contentType, perImageLimit);
      checked.set(info.sha256, { image: { bytes, contentType: info.content_type },
        evidence: { bytes: info.size, content_type: info.content_type, sha256: info.sha256 } });
    }
  } catch { return []; }
  return [...checked.values()];
}

/** Stage only validated bytes in the model client's own workspace for one turn. */
export async function stageAssessmentImages(cwd: string, images: readonly AssessmentImage[]) {
  const paths: string[] = [];
  const clear = async () => { await Promise.all(paths.map(async path => {
    try { await unlink(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  })); };
  if (!sourceImagesWithinBudget(images)) throw new Error('研判图片超过限制');
  try {
    const root = await directory(cwd);
    for (const image of images) {
      const ext = extensions.get(image.contentType);
      if (!ext || !Number.isSafeInteger(image.eventId) || image.eventId < 1) throw new Error('研判图片归属无效');
      const name = 'source-' + image.eventId + '-' + randomUUID() + '.' + ext;
      inspectAttachment(name, image.bytes, image.contentType, perImageLimit);
      const path = join(root, name);
      const output = await open(path, 'wx', 0o600);
      paths.push(path);
      try { await output.writeFile(image.bytes); } finally { await output.close(); }
    }
    return { paths, clear };
  } catch (error) {
    await clear();
    throw error;
  }
}

/** The controller only cleans generated files from its known interrupted comparison runs. */
export function clearInterruptedAssessmentImages(stateRoot: string, ids: readonly string[]): void {
  if (!ids.length) return;
  const parent = join(realpathSync(stateRoot), 'workbench-model');
  function isOwnedDirectory(path: string) {
    const stat = lstatSync(path, { throwIfNoEntry: false });
    return stat?.isDirectory() && !stat.isSymbolicLink() && realpathSync(path) === path;
  }
  if (!isOwnedDirectory(parent)) return;
  for (const id of ids) {
    if (!/^comparison-[0-9a-f]{32}$/.test(id)) continue;
    const path = join(parent, id);
    if (!isOwnedDirectory(path)) continue;
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (entry.isFile() && stagedName.test(entry.name)) unlinkSync(join(path, entry.name));
    }
  }
}
