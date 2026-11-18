import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: { alias: { '@superagent/windows-job': fileURLToPath(new URL('./packages/windows-job/index.mjs',import.meta.url)) } },
  test: { include: ['apps/server/**/*.test.ts', 'tests/rewrite-acceptance/**/*.test.ts'] }
});
