import { createHash } from 'node:crypto';
import { lstat, opendir, realpath } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { delimiter, isAbsolute, join, parse, relative, sep } from 'node:path';
import { readWorkspaceText, resolveInspectionPath } from './project-workspace.ts';
import type { FileReadEvidence } from './project-workspace.ts';

export interface ReferencePolicy { env: NodeJS.ProcessEnv; fixtureRoot?: string }
export interface PinnedReference { root: string; sha256: string }
export interface ReadOnlyEvidence extends FileReadEvidence { reference?: string; root_sha256?: string; project_id?: number; lines?: number[] }

const pathSchema = { type: 'string', description: '仓库相对路径，或本轮列出的 @refs/<别名>/相对路径' };
export const readOnlyTools = [
  { name: 'list_files', description: '列出允许范围内的文件', properties: { path: pathSchema }, required: ['path'] },
  { name: 'read_file', description: '读取允许范围内的 UTF-8 文件', properties: { path: pathSchema,
    start_line: { type: 'integer', minimum: 1 }, max_lines: { type: 'integer', minimum: 1, maximum: 200 } }, required: ['path'] },
  { name: 'search_text', description: '查找允许范围内的固定字符串', properties: { path: pathSchema, query: { type: 'string' } }, required: ['path', 'query'] },
].map(({ name, description, properties, required }) => ({ type: 'function', name, description,
  inputSchema: { type: 'object', properties, required, additionalProperties: false } }));
export const readOnlyToolNames = new Set(readOnlyTools.map(tool => tool.name));

function contains(root: string, child: string) {
  const suffix = relative(root, child);
  return suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
}

export async function pinReferenceRoot(path: string, policy: ReferencePolicy): Promise<PinnedReference> {
  const anchor = parse(path).root;
  if (!isAbsolute(path) || /^[\\/]{2}/.test(path) || relative(anchor, path) === '') throw new Error('需要明确的本机资料目录');
  const home = await realpath(policy.env.USERPROFILE || policy.env.HOME || homedir()).catch(() => homedir());
  const appData = join(home, 'AppData');
  const protectedDirs = [policy.env.SystemRoot || policy.env.SYSTEMROOT || join(anchor, 'Windows'),
    ...['ProgramData', 'Program Files', 'Program Files (x86)'].map(name => join(anchor, name))];
  let disposable = false;
  if (policy.env.SUPERAGENT_DRIVER === 'fixture' && policy.fixtureRoot) {
    const temporary = await realpath(tmpdir());
    const state = await realpath(policy.fixtureRoot);
    disposable = temporary !== state && contains(temporary, state) && contains(state, path);
  }
  if (contains(path, home) || contains(path, appData) || (!disposable && contains(appData, path))
      || protectedDirs.some(root => contains(path, root) || contains(root, path))) {
    throw new Error('不允许读取系统或账号目录');
  }
  const allowed = (policy.env.SUPERAGENT_ALLOWED_REPO_ROOTS ?? '').split(delimiter).filter(value => value.trim());
  const constraints = [];
  for (const candidate of allowed) {
    if (!isAbsolute(candidate)) continue;
    const canonicalAllowed = await realpath(candidate).catch(() => undefined);
    if (canonicalAllowed) constraints.push(canonicalAllowed);
  }
  if (allowed.length && !constraints.some(approved => contains(approved, path))) throw new Error('超出管理员目录范围');
  const root = await resolveInspectionPath(anchor, relative(anchor, path));
  const canonical = await realpath(root);
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink() || relative(root, canonical)) throw new Error('资料目录包含链接或已变化');
  if (allowed.length && !constraints.some(approved => contains(approved, canonical))) throw new Error('超出管理员目录范围');
  return { root: canonical, sha256: createHash('sha256').update(JSON.stringify([canonical, info.dev, info.ino])).digest('hex') };
}

const filePrefix = (alias: string | undefined, path: string) => alias ? `@refs/${alias}/${path}` : path;

export async function inspectReadOnly(root: string, tool: string, args: Record<string, unknown>, options: {
  signal: AbortSignal; reference?: { alias: string; pin: PinnedReference; policy: ReferencePolicy; projectId?: number };
}) {
  const { signal, reference } = options;
  const path = args.path ?? '.';
  if (typeof path !== 'string' || path.includes('\\') || !readOnlyToolNames.has(tool)) throw new Error('只读工具或路径无效');
  const allowed = tool === 'read_file' ? ['path', 'start_line', 'max_lines'] : tool === 'search_text' ? ['path', 'query'] : ['path'];
  if (Object.keys(args).some(key => !allowed.includes(key))) throw new Error('只读工具参数超出范围');
  async function verifyRoot() {
    signal.throwIfAborted();
    if (reference && (await pinReferenceRoot(root, reference.policy)).sha256 !== reference.pin.sha256) throw new Error('资料根目录已变化');
  }
  const evidence: ReadOnlyEvidence[] = [];
  const rows: { path: string; line?: number; text?: string; size?: number }[] = [];
  let used = 0;
  let readBudget = 8_388_608;
  let truncated = false;
  function add(row: { path: string; line?: number; text?: string; size?: number }) {
    const size = Buffer.byteLength(JSON.stringify(row));
    if (used + size > 20_000) { truncated = true; return false; }
    rows.push(row);
    used += size;
    return true;
  }
  async function read(name: string) {
    await verifyRoot();
    const content = await readWorkspaceText(root, name, readBudget);
    readBudget -= content.evidence.size;
    return content;
  }
  function cite(observation: FileReadEvidence) {
    const name = filePrefix(reference?.alias, observation.path);
    const lines = rows.filter(row => row.path === name && row.line !== undefined).map(row => row.line!);
    evidence.push({ ...observation, path: name, lines,
      ...(reference ? { reference: reference.alias, root_sha256: reference.pin.sha256, project_id: reference.projectId } : {}) });
  }

  await verifyRoot();
  const target = await resolveInspectionPath(root, path);
  const info = await lstat(target);
  if (tool === 'read_file') {
    const start = args.start_line ?? 1, count = args.max_lines ?? 100;
    if (typeof start !== 'number' || !Number.isSafeInteger(start) || start < 1 || typeof count !== 'number'
        || !Number.isInteger(count) || count < 1 || count > 200) throw new Error('行范围无效');
    const result = await read(path);
    const lines = result.text.split(/\r?\n/);
    for (let index = start - 1; index < Math.min(start - 1 + count, lines.length); index++) {
      if (lines[index].length > 2000) truncated = true;
      if (!add({ path: filePrefix(reference?.alias, result.evidence.path), line: index + 1, text: lines[index].slice(0, 2000) })) break;
    }
    if (rows.some(row => row.text?.trim())) cite(result.evidence);
    truncated ||= start - 1 + count < lines.length;
  } else {
    const query = args.query;
    if (tool === 'search_text' && (typeof query !== 'string' || !query.length || query.length > 256 || /[\r\n]/.test(query))) throw new Error('搜索词无效');
    const started = performance.now();
    let visited = 0, enumerated = 0;
    async function walk(name: string, depth: number): Promise<void> {
      if (++visited > 500 || depth > 12 || performance.now() - started > 2000 || evidence.length >= 24) { truncated = true; return; }
      await verifyRoot();
      const full = await resolveInspectionPath(root, name);
      const stat = await lstat(full);
      if (stat.isDirectory()) {
        for await (const item of await opendir(full)) {
          if (++enumerated > 500 || performance.now() - started > 2000) { truncated = true; break; }
          signal.throwIfAborted();
          const child = name === '.' ? item.name : `${name}/${item.name}`;
          if (!await resolveInspectionPath(root, child).catch(() => undefined)) continue;
          await walk(child, depth + 1);
          if (truncated) break;
        }
      } else if (stat.isFile() && stat.nlink === 1) {
        const visible = filePrefix(reference?.alias, name);
        if (tool === 'list_files') { add({ path: visible, size: stat.size }); return; }
        const content = await read(name).catch(error => {
          signal.throwIfAborted();
          if (depth === 0) throw error;
          return undefined;
        });
        if (!content) return;
        const before = rows.length;
        for (const [line, text] of content.text.split(/\r?\n/).entries()) {
          if (text.includes(String(query)) && !add({ path: visible, line: line + 1, text: text.slice(0, 2000) })) break;
        }
        if (rows.length > before) cite(content.evidence);
      }
    }
    if (tool === 'list_files' && !info.isDirectory()) throw new Error('列出文件需要目录');
    await walk(path, 0);
  }
  await verifyRoot();
  return { text: JSON.stringify({ [tool === 'list_files' ? 'files' : tool === 'search_text' ? 'matches' : 'lines']: rows, truncated }), evidence };
}
