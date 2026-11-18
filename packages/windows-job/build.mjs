import { mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
mkdirSync(new URL('./bin/', import.meta.url), { recursive: true });
const cc = process.env.WINDOWS_JOB_CC || 'x86_64-w64-mingw32-gcc';
const result = spawnSync(cc, [
  '-std=c11', '-Os', '-static', '-municode', '-Wall', '-Wextra', '-Werror',
  '-s', '-Wl,--no-insert-timestamp,--dynamicbase,--nxcompat,--high-entropy-va',
  '-o', 'bin/windows-job-x64.exe', 'src/windows-job.c',
], { cwd: root, stdio: 'inherit', shell: false });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
