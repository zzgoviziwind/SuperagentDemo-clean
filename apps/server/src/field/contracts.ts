import { z } from 'zod';
import { fail } from '../auth.js';

export const imageLimit = 2 * 1024 * 1024;
export const mediaLimit = 150 * 1024 * 1024;
export const positive = z.int().positive();
export const fieldId = z.uuid();
export const timestamp = z.int().min(0).max(86_400_000);
export const imageMime = z.enum(['image/png', 'image/jpeg', 'image/webp']);
export const title = z.string().trim().min(1).max(200);
const kind = z.enum(['bug', 'requirement', 'question']);

export const transcriptSegment = z.strictObject({
  start_ms: timestamp,
  end_ms: timestamp,
  speaker: z.string().trim().max(80).default(''),
  text: z.string().trim().min(1).max(2000),
}).refine(row => row.end_ms > row.start_ms);

const point = z.int().nonnegative();
export const ocrLine = z.strictObject({
  text: z.string().trim().min(1).max(500),
  box: z.tuple([point, point, point, point]).nullish(),
  confidence: z.number().min(0).max(1).nullish(),
}).refine(row => !row.box || (row.box[0] < row.box[2] && row.box[1] < row.box[3]));

export const timeline = z.strictObject({
  version: z.literal(1),
  transcript: z.array(transcriptSegment).min(1).max(300),
  keyframes: z.array(z.strictObject({
    filename: z.string().trim().min(1).max(180),
    at_ms: timestamp,
    ocr: z.array(ocrLine).max(40),
  })).max(5).default([]),
}).refine(input => input.transcript.reduce((sum, row) => sum + row.text.length, 0) <= 30_000 &&
  new Set(input.keyframes.map(frame => frame.filename.toLowerCase())).size === input.keyframes.length);

export const recordInput = z.object({
  project_id: positive,
  title,
  notes: z.string().max(10_000).transform(value => value.trim()).default(''),
  screenshots: z.array(z.object({
    filename: z.string(),
    mime: imageMime,
    base64: z.string().max(4 * Math.ceil(imageLimit / 3)),
  })).max(5).default([]),
  timeline: timeline.nullish(),
});

export const decisionInput = z.object({
  action: z.enum(['create', 'link', 'dismiss']),
  title: z.string().max(200).default(''),
  detail: z.string().max(2500).default(''),
  kind: kind.default('question'),
  task_id: positive.nullish().transform(value => value ?? null),
  expected_state_version: z.int().nonnegative().nullish().transform(value => value ?? null),
});
export const implementationInput = z.object({
  expected_state_version: z.int().nonnegative(),
  scope: z.string().min(1).max(4000),
  acceptance_criteria: z.string().min(1).max(4000),
});

export type OcrLine = z.infer<typeof ocrLine>;
export type Segment = z.infer<typeof transcriptSegment> & { id: string };
export type Evidence = {
  id: string;
  text: string;
  note_line?: number;
  screenshot?: number;
  at_ms?: number;
  nearby?: Pick<Segment, 'id' | 'start_ms' | 'end_ms'>[];
  candidate_segments?: string[];
  start_ms?: number;
  end_ms?: number;
  speaker?: string;
} & Partial<OcrLine>;
export type Draft = {
  kind: z.infer<typeof kind>;
  title: string;
  detail: string;
  quote?: string;
  note_line?: number | null;
  screenshots: number[];
  evidence?: Evidence[];
  organizer?: string;
};

export function orderedSegments(rows: z.infer<typeof transcriptSegment>[]): Segment[] {
  return rows.toSorted((a, b) => a.start_ms - b.start_ms || a.end_ms - b.end_ms)
    .map((segment, index) => ({ ...segment, id: `T${index + 1}` }));
}

export function organize(notes: string, frames: { at_ms?: number; ocr?: OcrLine[] }[], segments: Segment[]): Draft[] {
  const evidenceMode = segments.length > 0 || frames.some(frame => frame.at_ms !== undefined || frame.ocr?.length);
  const used = new Set<number>();
  const drafts: Draft[] = [];
  for (const [index, line] of notes.split(/\r\n|\n|\r/).entries()) {
    const match = /^\s*(?:[-*]\s*)?(?:(Bug|缺陷|需求|疑问)\s*[:：]\s*)?(.+?)\s*$/i.exec(line);
    if (!match || !line.trim()) continue;
    const [, label, body] = match;
    const references = new Set(Array.from(body.matchAll(/\[截图([1-5])\]/g), hit => Number(hit[1]))
      .filter(id => id <= frames.length));
    for (const id of references) used.add(id);
    const detail = body.replace(/\[截图[1-5]\]/g, '').trim() || '请核对所附截图。';
    drafts.push({
      kind: label === '需求' ? 'requirement' : label && /^(bug|缺陷)$/i.test(label) ? 'bug' : 'question',
      title: detail.slice(0, 200), detail: detail.slice(0, 2500), note_line: index + 1, quote: line,
      screenshots: [...references].sort(), ...(evidenceMode ? { organizer: 'local_evidence' } : {}),
    });
  }
  for (const [index, frame] of frames.entries()) {
    const id = index + 1;
    if (used.has(id) && !frame.ocr?.length && frame.at_ms === undefined) continue;
    if (!evidenceMode) {
      drafts.push({ kind: 'question', title: `核对截图 ${id}`, detail: '请填写截图中的现象和期望。',
        note_line: null, quote: '', screenshots: [id] });
      continue;
    }
    const at = frame.at_ms;
    const nearby: NonNullable<Evidence['nearby']> = [];
    if (at !== undefined && segments.length) {
      const distances = segments.map(row => Math.max(row.start_ms - at, at - row.end_ms, 0));
      const nearest = Math.min(...distances);
      if (nearest <= 5000) segments.forEach(({ id, start_ms, end_ms }, number) => {
        if (distances[number] === nearest) nearby.push({ id, start_ms, end_ms });
      });
    }
    const references = frame.ocr?.length
      ? frame.ocr.map((line, number) => ({ ...line, id: `S${id}:${number + 1}` }))
      : [{ id: `S${id}`, text: '请核对所附截图。' }];
    const evidence = references.map(row => ({ ...row, screenshot: id,
      ...(at === undefined ? {} : { at_ms: at, nearby, candidate_segments: nearby.map(item => item.id) }) }));
    drafts.push({ kind: 'question', title: `核对截图 ${id}`, detail: evidence.map(row => row.text).join('\n').slice(0, 2500),
      screenshots: [id], evidence, organizer: 'local_evidence' });
  }
  if (drafts.length > 50 || (drafts.length === 50 && segments.length)) fail(422, '请将材料拆分为最多 50 条候选事项');
  const remaining = 50 - drafts.length;
  const groupSize = Math.max(1, Math.ceil(segments.length / Math.max(1, remaining)));
  for (let start = 0; start < segments.length; start += groupSize) {
    const evidence = segments.slice(start, start + groupSize);
    const detail = evidence.map(segment => segment.text).join('\n');
    drafts.push({ kind: 'question', title: detail.slice(0, 200), detail: detail.slice(0, 2500),
      screenshots: [], evidence, organizer: 'local_evidence' });
  }
  if (!drafts.length) fail(422, '请提供现场笔记、截图或带时间的转写');
  return drafts;
}
