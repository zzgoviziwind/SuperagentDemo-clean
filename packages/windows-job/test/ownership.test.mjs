import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { spawnOwned } from '../index.mjs';

async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), 'Job 验收 '));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return { cwd, env: { SystemRoot: process.env.SystemRoot, TEMP: cwd, TMP: cwd, USERPROFILE: cwd } };
}

function bytes(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', chunk => chunks.push(chunk));
    stream.once('end', () => resolve(Buffer.concat(chunks)));
    stream.once('error', reject);
  });
}

test('pid, Unicode argv, binary stdio and exit status survive the supervisor', async t => {
  const options = await fixture(t);
  const args = ['', '中文 空格', 'trailing space \\', 'quote"inside', 'slash\\"quote', 'literal*?'];
  const program = `
    process.stderr.write(JSON.stringify({ pid: process.pid, args: process.argv.slice(1) }));
    process.stdin.pipe(process.stdout);
    process.exitCode = 37;
  `;
  const owned = await spawnOwned(process.execPath, ['-e', program, '--', ...args], options);
  t.after(owned.terminate);
  const completed = once(owned.child, 'close');
  const output = bytes(owned.child.stdout);
  const diagnostic = bytes(owned.child.stderr);
  const payload = Buffer.from([0, 10, 13, 255, 7, 26]);
  owned.child.stdin.end(payload);
  assert.deepEqual(await completed, [37, null]);
  assert.deepEqual(await output, payload);
  assert.deepEqual(JSON.parse((await diagnostic).toString()), { pid: owned.pid, args });
  if (process.platform === 'win32') assert.notEqual(owned.pid, owned.child.pid);
});

test('repeated termination closes a waiting child before its natural deadline', async t => {
  const options = await fixture(t);
  const owned = await spawnOwned(process.execPath, ['-e', 'setTimeout(() => {}, 12000)'], options);
  const completed = once(owned.child, 'close');
  owned.terminate();
  owned.terminate();
  const [code, signal] = await completed;
  assert.ok(code !== 0 || signal !== null);
});

test('a failed native launch rejects before returning a peer', { skip: process.platform !== 'win32' }, async t => {
  const options = await fixture(t);
  await assert.rejects(spawnOwned(join(options.cwd, 'absent.exe'), [], options), /suspended_launch failed/);
});

test('without an ownership pipe no target instructions run', { skip: process.platform !== 'win32' }, async t => {
  const options = await fixture(t);
  const missingControl = spawn(fileURLToPath(new URL('../bin/windows-job-x64.exe', import.meta.url)), [
    process.execPath, '-e', "require('node:fs').writeFileSync('started','yes')",
  ], { ...options, stdio: ['pipe', 'pipe', 'pipe', 'pipe'], windowsHide: true });
  const [code] = await once(missingControl, 'close');
  assert.notEqual(code, 0);
  assert.equal(existsSync(join(options.cwd, 'started')), false);
});

test('losing the supervisor closes its Job while the host stays alive', { skip: process.platform !== 'win32', timeout: 5000 }, async t => {
  const options = await fixture(t);
  const owned = await spawnOwned(process.execPath, ['-e', 'setTimeout(() => {}, 12000)'], options);
  assert.doesNotThrow(() => process.kill(owned.pid, 0));
  const closed = once(owned.child, 'close');
  owned.child.kill();
  await closed;
  const deadline = Date.now() + 2000;
  for (;;) {
    try {
      process.kill(owned.pid, 0);
    } catch (error) {
      assert.equal(error.code, 'ESRCH');
      break;
    }
    assert.ok(Date.now() < deadline, 'peer survived loss of its Job handle');
    await delay(10);
  }
});
