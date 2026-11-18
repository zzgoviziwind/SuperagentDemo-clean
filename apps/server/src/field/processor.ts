import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { fail } from '../auth.js';
import { ocrLine, timeline, timestamp, type OcrLine } from './contracts.js';

const runFile = promisify(execFile);
const mediaResult = z.object({ duration_ms: timestamp.min(1).max(2_700_000), video: z.boolean(), segments: z.unknown() });
const frames = z.array(z.object({ filename: z.string().regex(/^frame-[1-5]\.jpg$/), at_ms: timestamp })).max(5);

function localFile(path?: string) {
  try { return Boolean(path && isAbsolute(path) && statSync(path, { throwIfNoEntry: false })?.isFile()); }
  catch { return false; }
}

export function fieldProcessor(env: NodeJS.ProcessEnv, root: string) {
  const python = env.SUPERAGENT_FIELD_PYTHON;
  const ocrModels = env.SUPERAGENT_FIELD_OCR_MODELS;
  const whisperModel = env.SUPERAGENT_FIELD_WHISPER_MODEL;
  const helpers = join(dirname(resolve(process.argv[1] || 'main.js')), 'field-helpers');
  const ocrScript = join(helpers, 'field_ocr.py');
  const mediaScript = join(helpers, 'field_media_worker.py');
  const home = join(root, 'field-helper-home');
  const controller = new AbortController();
  let ocr = false;
  let media = false;
  let mediaReason = '后台语音识别模型尚未配置。可直接导入已有转写时间轴。';

  function run(args: string[], timeout: number) {
    const allowed = Object.fromEntries(['SystemRoot', 'WINDIR', 'SystemDrive', 'ComSpec'].flatMap(name =>
      env[name] ? [[name, env[name]]] : []));
    mkdirSync(home, { recursive: true });
    return runFile(python!, ['-I', '-B', ...args], {
      cwd: home, windowsHide: true, signal: controller.signal, timeout, maxBuffer: 2 * 1024 * 1024,
      env: { ...allowed, HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home,
        TEMP: home, TMP: home, HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' },
    });
  }

  async function probe() {
    if (!python && !ocrModels && !whisperModel) return;
    if (!localFile(python)) {
      mediaReason = '请配置本机 Python 可执行文件（SUPERAGENT_FIELD_PYTHON）。';
      return;
    }
    if (ocrModels && isAbsolute(ocrModels) && localFile(ocrScript) &&
        ['chi_sim', 'eng'].every(model => localFile(join(ocrModels, 'tessdata', `${model}.traineddata`)))) {
      try { await run(['-c', 'import PIL, tesserocr'], 15_000); ocr = true; } catch { /* Manual screenshot review remains available. */ }
    }
    if (!whisperModel || !isAbsolute(whisperModel) ||
        !['model.bin', 'config.json', 'tokenizer.json'].every(name => localFile(join(whisperModel, name)))) return;
    if (!existsSync(mediaScript)) {
      mediaReason = '安装包缺少固定的现场媒体处理脚本。';
      return;
    }
    try {
      await run(['-c', 'import av, numpy, faster_whisper'], 15_000);
      media = true;
      mediaReason = '';
    } catch {
      mediaReason = '本机 Python 缺少可用的 PyAV、numpy 或 faster-whisper 依赖。';
    }
  }

  return {
    get ocr() { return ocr; },
    get media() { return media; },
    get mediaReason() { return mediaReason; },
    probe,
    close: () => controller.abort(),
    async readScreenshots(paths: string[]): Promise<OcrLine[][]> {
      try {
        const { stdout } = await run([ocrScript, '--models', ocrModels!, '--engine', 'tesseract', ...paths], 70_000);
        const rows = z.array(z.array(ocrLine)).length(paths.length).parse(JSON.parse(stdout));
        return rows.map(group => group.slice(0, 40));
      } catch {
        return fail(503, '本机截图识别失败，请核对 Python、OCR 模型及截图格式');
      }
    },
    async transcribe(source: string) {
      const { stdout } = await run([mediaScript, 'transcribe', source, whisperModel!], 15 * 60_000);
      const output = mediaResult.parse(JSON.parse(stdout));
      const parsed = timeline.parse({ version: 1, transcript: output.segments });
      if (parsed.transcript.some(row => row.end_ms > output.duration_ms)) throw new Error('Transcription exceeds the source clock');
      return { duration: output.duration_ms, video: output.video, segments: parsed.transcript };
    },
    async frames(source: string, folder: string, moments: number[]) {
      const { stdout } = await run([mediaScript, 'frames', source, folder, ...moments.map(String)], 90_000);
      const found = frames.parse(JSON.parse(stdout));
      if (found.length > moments.length || new Set(found.map(row => row.filename)).size !== found.length) {
        throw new Error('Invalid extracted frame list');
      }
      return found;
    },
  };
}

export type FieldProcessor = ReturnType<typeof fieldProcessor>;
