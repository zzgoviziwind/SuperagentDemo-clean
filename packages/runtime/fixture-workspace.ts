import { createHash } from 'node:crypto';
import { lstat, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { delimiter, isAbsolute, join, relative } from 'node:path';
import { spawnOwned } from '@superagent/windows-job';
import { analysisFile, offlineEnvironment, repairAfter, repairBefore, repairFile } from './fixtures/environment.ts';

export type FixtureWorkspaceKind = 'repair' | 'analysis';

const analysisContent = '这是只用于离线 Host 实际读取校验的合成样例。\n';
const limit = 256 * 1024;

export class FixtureProcessUnknown extends Error {}

export async function gitExecutable() {
  const name = process.platform === 'win32' ? 'git.exe' : 'git';
  for (const directory of (process.env.PATH ?? process.env.Path ?? '').split(delimiter).filter(isAbsolute)) {
    const candidate = await realpath(join(directory, name)).catch(() => undefined);
    if (candidate && (await stat(candidate).catch(() => undefined))?.isFile()) return candidate;
  }
  throw new Error('未找到用于临时工作区的 Git');
}

export async function runWorkspaceCommand(executable: string, args: readonly string[], cwd: string,
  configuration: NodeJS.ProcessEnv = {}, signal?: AbortSignal, timeoutMs = 5_000, maxOutput = limit) {
  signal?.throwIfAborted();
  const { child, terminate } = await spawnOwned(executable, args, { cwd, env: { ...offlineEnvironment(cwd), ...configuration } });
  const output: Buffer[] = [];
  let size = 0;
  let cancelled = false;
  let closeBound: ReturnType<typeof setTimeout> | undefined;
  let markUnconfirmed!: () => void;
  const unconfirmed = new Promise<null>(resolve => { markUnconfirmed = () => resolve(null); });
  const closed = new Promise<number | null>(resolve => {
    child.once('close', resolve);
    child.once('error', () => resolve(null));
  });
  function stop() {
    if (cancelled) return;
    cancelled = true;
    try { terminate(); } catch { markUnconfirmed(); }
    closeBound = setTimeout(markUnconfirmed, 3_000);
  }
  child.stdout.on('data', (bytes: Buffer) => {
    size += bytes.length;
    if (size > maxOutput) stop();
    else output.push(bytes);
  });
  child.stderr.resume();
  child.stdin.on('error', () => {});
  child.stdin.end();
  const deadline = setTimeout(stop, timeoutMs);
  if (signal?.aborted) stop();
  else signal?.addEventListener('abort', stop, { once: true });
  try {
    const status = await Promise.race([closed, unconfirmed]);
    if (status === null || (process.platform === 'win32' && status === 125)) throw new FixtureProcessUnknown('工作区验证进程树退出未确认');
    if (status !== 0 || cancelled) throw new Error('临时工作区的只读探测或预置验证未通过');
    return Buffer.concat(output).toString('utf8');
  } finally {
    signal?.removeEventListener('abort', stop);
    clearTimeout(deadline);
    clearTimeout(closeBound);
  }
}

export function workspaceGit(cwd: string, executable: string, args: readonly string[], signal?: AbortSignal) {
  const nullFile = process.platform === 'win32' ? 'NUL' : '/dev/null';
  return runWorkspaceCommand(executable, ['-c', 'core.autocrlf=false', '-c', 'core.quotePath=false', '-c', 'core.fsmonitor=false',
    '-c', `core.hooksPath=${nullFile}`, '-c', 'protocol.allow=never', '-c', 'protocol.file.allow=always', ...args], cwd, {
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: nullFile, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0',
  }, signal, 15_000, 8 * 1024 * 1024);
}

export async function prepareFixtureWorkspace(cwd: string, kind: FixtureWorkspaceKind, signal?: AbortSignal) {
  const executable = await gitExecutable();
  const file = kind === 'repair' ? repairFile : analysisFile;
  await writeFile(join(cwd, file), kind === 'repair' ? repairBefore : analysisContent, { flag: 'wx' });
  await workspaceGit(cwd, executable, ['init', '--quiet', '--template='], signal);
  await workspaceGit(cwd, executable, ['add', '--', file], signal);
  return (await workspaceGit(cwd, executable, ['write-tree'], signal)).trim();
}

export async function fixtureWorkspaceSnapshot(cwd: string, baseSha: string, signal?: AbortSignal) {
  if (!/^[a-f0-9]{40,64}$/.test(baseSha)) throw new Error('临时工作区基线无效');
  const directory = join(cwd, '.git');
  if (!(await lstat(directory)).isDirectory() || relative(directory, await realpath(directory)) !== '') {
    throw new Error('临时 Git 元数据指向了其他目录');
  }
  const executable = await gitExecutable();
  const reads = await Promise.allSettled([
    workspaceGit(cwd, executable, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--binary', '--full-index', baseSha, '--'], signal),
    workspaceGit(cwd, executable, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', '-z', baseSha, '--'], signal),
    workspaceGit(cwd, executable, ['ls-files', '--others', '-z'], signal),
  ]);
  for (const result of reads) if (result.status === 'rejected' && result.reason instanceof FixtureProcessUnknown) throw result.reason;
  const [patch, names, untracked] = reads.map(result => { if (result.status === 'rejected') throw result.reason; return result.value; });
  const changed = names.split('\0').filter(Boolean);
  const extra = untracked.split('\0').filter(Boolean);
  return { base_sha: baseSha, changed, untracked: extra, diff: patch,
    sha256: createHash('sha256').update(JSON.stringify([baseSha, changed, extra, patch])).digest('hex') };
}

async function readPlain(cwd: string, file: string) {
  const filename = join(cwd, file);
  const info = await lstat(filename);
  if (!info.isFile() || info.nlink !== 1 || info.size > 32_768 || relative(filename, await realpath(filename)) !== '') {
    throw new Error('临时工作区文件未通过路径或大小约束');
  }
  return readFile(filename);
}

export async function fixtureAnalysisRead(cwd: string, requestedPath: unknown) {
  if (requestedPath !== analysisFile) throw new Error('请求超出只读样例文件范围');
  const bytes = await readPlain(cwd, analysisFile);
  return { text: bytes.toString('utf8'), evidence: { source: 'host-filesystem-read', path: analysisFile,
    size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } };
}

export async function verifyFixtureRepair(cwd: string, snapshot: Awaited<ReturnType<typeof fixtureWorkspaceSnapshot>>, signal?: AbortSignal) {
  if (snapshot.changed.length !== 1 || snapshot.changed[0] !== repairFile || snapshot.untracked.length || !snapshot.diff) {
    throw new Error('修复差异超出固定样例文件');
  }
  await readPlain(cwd, repairFile);
  await runWorkspaceCommand(process.execPath, ['-e', `const assert=require('node:assert/strict'); const fs=require('node:fs');
    assert.equal(fs.readFileSync(${JSON.stringify(repairFile)},'utf8'),${JSON.stringify(repairAfter)});`], cwd, {}, signal);
  return { source: 'host-command', command: '固定样例内容校验（Node assert）', cwd, exit_code: 0 };
}
