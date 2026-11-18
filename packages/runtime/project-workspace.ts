import { createHash } from 'node:crypto';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, sep } from 'node:path';
import { fixtureWorkspaceSnapshot, gitExecutable, runWorkspaceCommand, workspaceGit } from './fixture-workspace.ts';

export type ProjectBaseline = string | Record<string, string>;
export type ProjectRepository = { path: string; base_branch: string };
export type FileReadEvidence = { source: 'host-filesystem-read'; path: string; sha256: string; size: number };
export class WorkspacePolicyError extends Error {}

const sha = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const key = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;

function contained(parent: string, child: string) {
  const path = relative(parent, child);
  return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function parts(input: unknown): string[] {
  if (typeof input !== 'string' || !input || input.length > 1024 || isAbsolute(input)) throw new Error('工作区相对路径无效');
  const items = input.replaceAll('\\', '/').split('/');
  const forbidden = /^(?:\.|\.\.|\.git|\.env(?:\..*)?|\.aws|\.ssh|\.codex|\.agents|credentials|id_rsa|id_ed25519|con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
  if (items.some(item => !item || /[\x00-\x1f:<>|"?*]/.test(item) || /[ .]$/.test(item) || forbidden.test(item)
      || /\.(?:pem|key|pfx|p12)$/i.test(item) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])\./i.test(item))) throw new Error('路径包含受限文件名');
  return items;
}

async function safePath(root: string, names: string[], allowMissing = false) {
  let path = root;
  for (const part of names) {
    path = join(path, part);
    const info = await lstat(path).catch(error => {
      if (allowMissing && error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (!info) continue;
    if (info.isSymbolicLink() || relative(path, await realpath(path)) || (info.isFile() && info.nlink !== 1)) {
      throw new Error('工作区含链接、重解析路径或硬链接');
    }
  }
  return path;
}

export async function prepareProjectWorkspace(destination: string, configuredRoot: string, baseBranch: string,
  repositories: ProjectRepository[], options: { committedAnalysis: boolean; signal?: AbortSignal }): Promise<ProjectBaseline> {
  const source = await realpath(configuredRoot);
  if (!isAbsolute(configuredRoot) || contained(source, destination) || contained(destination, source)) throw new WorkspacePolicyError('项目与工作区必须独立');
  const executable = await gitExecutable();
  const entries = repositories.length ? repositories : [{ path: '.', base_branch: baseBranch }];
  if (entries.length > 20) throw new Error('仓库数量超出限制');
  const result: Record<string, string> = Object.create(null);
  const plans: { path: string; source: string; target: string; commit: string }[] = [];
  for (const entry of entries) {
    options.signal?.throwIfAborted();
    const names = repositories.length ? parts(entry.path) : [];
    const path = names.length ? names.join('/') : '.';
    const origin = await safePath(source, names);
    if (plans.some(plan => contained(origin, plan.source) || contained(plan.source, origin))) throw new Error('仓库路径重复或嵌套');
    const target = join(destination, ...names);
    const git = (...args: string[]) => workspaceGit(destination, executable, ['-C', origin, ...args], options.signal);
    const gitDir = join(origin, '.git');
    if (!(await lstat(gitDir).catch(() => undefined))?.isDirectory() || relative(gitDir, await realpath(gitDir))) {
      throw new WorkspacePolicyError('只支持独立本地 Git 仓库；共享目录请由 Python 承载');
    }
    const alternate = await lstat(join(gitDir, 'objects', 'info', 'alternates')).catch(error => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (alternate || relative(origin, await realpath((await git('rev-parse', '--show-toplevel')).trim()))) throw new Error('项目配置须定位独立仓库根');
    if (!options.committedAnalysis && (await git('status', '--porcelain', '--untracked-files=all')).trim()) {
      throw new WorkspacePolicyError('源仓库有未提交修改，修复未派发');
    }
    if (!entry.base_branch || entry.base_branch.startsWith('-') || /[\x00-\x1f]/.test(entry.base_branch)) throw new Error('基线分支无效');
    const commit = (await git('rev-parse', '--verify', `refs/heads/${entry.base_branch}^{commit}`)).trim();
    if (!sha.test(commit)) throw new Error('基线不是固定提交');
    const tree = (await git('ls-tree', '-rz', commit)).split('\0').filter(Boolean);
    for (const object of tree) {
      if (!/^100(?:644|755) /.test(object)) throw new Error('基线含链接或子模块');
      const name = object.indexOf('\t');
      if (name < 0) throw new Error('Git 基线目录无效');
      // Sensitive files stay unreadable to the Host tools even when tracked in the repository.
      const filename = object.slice(name + 1);
      if (filename.split('/').some(part => !part || part === '.' || part === '..' || /[\\:\x00-\x1f]/.test(part))) throw new Error('Git 基线包含不安全路径');
    }
    plans.push({ path, source: origin, target, commit });
  }
  for (const plan of plans) {
    options.signal?.throwIfAborted();
    if (plan.path !== '.') await mkdir(plan.target, { recursive: true });
    await workspaceGit(destination, executable, ['clone', '--quiet', '--no-hardlinks', '--no-checkout', '--', plan.source, plan.target], options.signal);
    await workspaceGit(plan.target, executable, ['checkout', '--quiet', '--detach', plan.commit, '--'], options.signal);
    await workspaceGit(plan.target, executable, ['remote', 'remove', 'origin'], options.signal);
    result[plan.path] = plan.commit;
  }
  return repositories.length ? result : result['.'];
}

async function readRegular(root: string, path: unknown, limit: number) {
  const names = parts(path);
  const absolute = await safePath(root, names);
  const before = await lstat(absolute);
  if (!before.isFile() || before.nlink !== 1) throw new Error('文件不是独立普通文件');
  const f = await open(absolute, 'r');
  try {
    const info = await f.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > limit || before.ino !== info.ino || before.dev !== info.dev) {
      throw new Error('文件类型或大小超出范围');
    }
    const buffer = Buffer.alloc(info.size + 1);
    const { bytesRead } = await f.read(buffer, 0, buffer.length, 0);
    const after = await lstat(await safePath(root, names));
    if (bytesRead !== info.size || info.mtimeMs !== after.mtimeMs || info.size !== after.size || info.ino !== after.ino || info.dev !== after.dev) {
      throw new Error('读取时文件发生变化');
    }
    return { path: names.join('/'), bytes: buffer.subarray(0, bytesRead) };
  } finally { await f.close(); }
}

export async function readWorkspaceText(root: string, path: unknown): Promise<{ text: string; evidence: FileReadEvidence }> {
  const { path: name, bytes } = await readRegular(root, path, 32_768);
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (!text.trim() || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) throw new Error('没有可验证的文本内容');
  return { text, evidence: { source: 'host-filesystem-read', path: name, size: bytes.length, sha256: digest(bytes) } };
}

export async function projectWorkspaceSnapshot(root: string, baseline: ProjectBaseline, allowedPaths?: string[], signal?: AbortSignal) {
  const entries = typeof baseline === 'string' ? [['.', baseline]] as const : Object.entries(baseline).sort(([a], [b]) => a.localeCompare(b));
  if (!entries.length || entries.length > 20) throw new Error('缺少仓库基线');
  const allowed = allowedPaths?.map(path => path === '.' ? '.' : key(parts(path).join('/')));
  const repositories = [];
  const executable = await gitExecutable();
  let budget = 8 * 1024 * 1024;
  for (const [path, commit] of entries) {
    signal?.throwIfAborted();
    const repo = path === '.' ? root : await safePath(root, parts(path));
    const gitDir = join(repo, '.git');
    if (!(await lstat(gitDir)).isDirectory() || relative(gitDir, await realpath(gitDir))) throw new Error('工作区 Git 元数据超出范围');
    if ((await workspaceGit(repo, executable, ['rev-parse', '--verify', 'HEAD'], signal)).trim() !== commit) throw new Error('执行工作区 HEAD 已改变');
    const index = (await workspaceGit(repo, executable, ['ls-files', '-v', '-z'], signal)).split('\0').filter(Boolean);
    if (index.some(entry => !entry.startsWith('H '))) throw new Error('Git 索引包含跳过检查的文件');
    const snapshot = await fixtureWorkspaceSnapshot(repo, commit, signal);
    budget -= Buffer.byteLength(snapshot.diff);
    if (budget < 0 || snapshot.changed.length + snapshot.untracked.length > 500) throw new Error('差异或文件数量超出证据预算');
    const prefix = path === '.' ? '' : `${path}/`;
    for (const file of [...snapshot.changed, ...snapshot.untracked]) {
      signal?.throwIfAborted();
      const names = parts(prefix + file);
      const candidate = key(names.join('/'));
      if (allowed && !allowed.some(scope => scope === '.' || candidate === scope || candidate.startsWith(`${scope}/`))) throw new Error('差异超出项目允许路径');
      await safePath(root, names, true);
    }
    const untracked = [];
    for (const file of snapshot.untracked) {
      signal?.throwIfAborted();
      const blob = await readRegular(repo, file, 256 * 1024);
      budget -= blob.bytes.length;
      if (budget < 0) throw new Error('新文件超出证据预算');
      untracked.push({ path: blob.path, sha256: digest(blob.bytes) });
    }
    repositories.push({ path, snapshot, untracked });
  }
  return { repositories, sha256: digest(JSON.stringify(repositories)) };
}

export async function projectVerificationCommand(root: string, configured: string) {
  const argv: unknown = JSON.parse(configured);
  if (!Array.isArray(argv) || argv.length < 1 || argv.length > 30 || argv.some(value => typeof value !== 'string' || !value || value.length > 2048)
      || !isAbsolute(argv[0])) throw new Error('项目验证需要管理员配置绝对程序路径的 JSON 参数数组');
  const executable = await realpath(argv[0]);
  if (contained(root, executable) || (process.platform === 'win32' && extname(executable).toLowerCase() !== '.exe')) throw new Error('项目验证程序必须是工作区外的本机可执行文件');
  if (!(await lstat(executable)).isFile()) throw new Error('项目验证程序不可用');
  return { executable, args: argv.slice(1) as string[] };
}

export async function runProjectVerification(root: string, configured: string, signal?: AbortSignal) {
  const { executable, args } = await projectVerificationCommand(root, configured);
  const output = await runWorkspaceCommand(executable, args, root, {}, signal, 30_000);
  return { source: 'host-command', command: '管理员配置的项目验证', cwd: root, exit_code: 0,
    command_sha256: digest(configured), stdout_sha256: digest(output) };
}
