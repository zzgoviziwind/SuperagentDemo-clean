import { build } from 'esbuild';
import { copyFile, cp, mkdir } from 'node:fs/promises';

await build({
  entryPoints: ['apps/server/src/main.ts'],
  outfile: 'apps/server/dist/main.js',
  platform: 'node',
  target: 'node24',
  format: 'esm',
  bundle: true,
  external: ['fastify','@fastify/static','zod','@larksuiteoapi/node-sdk'],
  alias: { '@superagent/windows-job': './packages/windows-job/index.mjs' },
});
await cp('packages/runtime/fixtures','apps/server/dist/fixtures',{recursive:true});
await mkdir('apps/server/dist/bin', { recursive: true });
await copyFile('packages/windows-job/bin/windows-job-x64.exe', 'apps/server/dist/bin/windows-job-x64.exe');
