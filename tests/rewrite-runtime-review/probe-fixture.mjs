// Substituted only in a disposable copy. The candidate transport stays byte-identical.
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';

const mode = readFileSync('mode', 'utf8');
const argumentsText = process.argv.slice(2).join(' ');
const forbidden = ['OPENAI_API_KEY', 'CODEX_API_KEY', 'SUPERAGENT_API_TOKEN', 'REDMINE_API_KEY',
  'DATABASE_URL', 'DINGTALK_APP_SECRET', 'CODEX_HOME'];
const inherited = forbidden.filter(key => Object.hasOwn(process.env, key));
const isolatedEnvironment = inherited.length === 0 && process.env.USERPROFILE === process.cwd()
  && process.env.TEMP === process.cwd() && process.env.TMP === process.cwd();
writeFileSync('observed.json', JSON.stringify({
  parent: process.pid,
  inherited, isolatedEnvironment,
  markerInArgv: argumentsText.includes('synthetic-review-marker'),
}));
if (mode.startsWith('tree-mixed-')) {
  const { python, script } = JSON.parse(readFileSync('helpers.json', 'utf8'));
  const helper = spawn(python, ['-I', '-B', script, 'bridge', process.cwd()],
    { stdio: 'ignore', windowsHide: true });
  helper.unref();
} else if (mode.startsWith('tree-')) {
  const leaf = spawn(process.execPath, ['--input-type=module', '-e', `
    import { existsSync, writeFileSync } from 'node:fs';
    import { setTimeout as wait } from 'node:timers/promises';
    writeFileSync('leaf.pid', String(process.pid));
    const deadline = Date.now() + 20000;
    while (!existsSync('stop') && Date.now() < deadline) await wait(25);
  `], { stdio: 'ignore', windowsHide: true });
  leaf.unref();
}

function respond(id, result) {
  return new Promise((resolve, reject) => process.stdout.write(JSON.stringify({ id, result }) + '\n',
    error => error ? reject(error) : resolve()));
}

for await (const line of createInterface({ input: process.stdin })) {
  const { id, method } = JSON.parse(line);
  if (method === 'initialize') await respond(id, { fixture: true, pid: process.pid, isolatedEnvironment });
  if (method === 'thread/start') {
    appendFileSync('threads-created', 'created\n');
    await respond(id, { thread: mode === 'thread-uncertain' ? {} : { id: 'thread-review' } });
  }
  if (method === 'turn/start') {
    appendFileSync('received', 'accepted\n');
    if (mode === 'eof') break;
    if (mode === 'timeout') continue;
    await respond(id, { turn: { id: 'turn-review' } });
    console.error('synthetic-review-marker');
    console.log(JSON.stringify({ method: 'turn/completed', params: { threadId: 'thread-review',
      turn: { id: 'turn-review', status: 'completed' } } }));
  }
}
if (mode.endsWith('-force')) {
  const deadline = Date.now() + 6000;
  while (!existsSync('stop') && Date.now() < deadline) await delay(25);
}
