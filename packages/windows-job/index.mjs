import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const helper = fileURLToPath(new URL('./bin/windows-job-x64.exe', import.meta.url));

export async function spawnOwned(executable, args, { cwd, env }) {
  if (!isAbsolute(executable) || !isAbsolute(cwd) || !env || typeof env !== 'object') {
    throw new TypeError('Expected an absolute executable and working directory and an explicit environment');
  }
  if (process.platform !== 'win32') {
    const child = spawn(executable, args, { cwd, env, shell: false, stdio: 'pipe' });
    await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('spawn', resolve);
    });
    return { child, pid: child.pid, terminate: () => { child.kill(); } };
  }
  const child = spawn(helper, [executable, ...args], {
    cwd, env, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'],
  });
  const readiness = child.stdio[3];
  const control = child.stdio[4];
  return new Promise((resolve, reject) => {
    let active = false;
    let stopping = false;
    let header = '';
    const timer = setTimeout(() => fail(new Error('Windows Job startup timed out')), 10000);
    function fail(error) {
      clearTimeout(timer);
      // The kernel closes the last Job handle even if startup failed partway.
      if (!active && child.pid && child.exitCode === null) child.kill();
      reject(error);
    }
    function terminate() {
      if (stopping || child.exitCode !== null) return;
      stopping = true;
      // One byte also wakes the supervisor on duplex pipes that retain their read end.
      if (!control.destroyed) control.end(Buffer.from([1]));
    }
    child.once('error', fail);
    child.once('close', () => {
      if (!active) fail(new Error('Windows Job supervisor stopped before readiness'));
    });
    control.on('error', () => {
      if (!active) fail(new Error('Windows Job control pipe unavailable'));
      else control.destroy();
    });
    readiness.on('error', () => {
      if (!active) fail(new Error('Windows Job readiness pipe unavailable'));
    });
    readiness.on('data', (chunk) => {
      if (active) return;
      header += chunk.toString('ascii');
      if (header.length > 128) return fail(new Error('Invalid Windows Job readiness frame'));
      if (!header.endsWith('\n')) return;
      const ready = /^READY ([1-9][0-9]{0,9})\n$/.exec(header);
      if (!ready) {
        const reason = /^ERROR ([a-z_]+) ([0-9]+)\n$/.exec(header);
        return fail(new Error(reason ? `Windows Job ${reason[1]} failed (${reason[2]})` : 'Invalid Windows Job readiness frame'));
      }
      active = true;
      clearTimeout(timer);
      resolve({ child, pid: Number(ready[1]), terminate });
    });
  });
}
