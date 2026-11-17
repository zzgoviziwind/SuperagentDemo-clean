import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { mkdirSync } from "node:fs";

const webRoot = fileURLToPath(new URL("../../", import.meta.url));
const repoRoot = path.resolve(webRoot, "../..");
const python = path.join(repoRoot, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const runId = process.env.SUPERAGENT_VISUAL_RUN_ID ?? new Date().toISOString().replace(/[:.]/g, "-");
process.env.SUPERAGENT_VISUAL_RUN_ID = runId;
const evidenceRoot = path.join(repoRoot, ".test-tmp/design-workflow-visual", runId);
mkdirSync(evidenceRoot, { recursive: true });
console.log(`Visual evidence: ${evidenceRoot}`);

export default defineConfig({
  testDir: ".",
  testMatch: "**/*.pw.ts",
  outputDir: path.join(evidenceRoot, "results"),
  preserveOutput: "always",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [
    ["list"],
    ["html", { outputFolder: path.join(evidenceRoot, "report"), open: "never" }],
  ],
  use: {
    baseURL: "http://127.0.0.1:5177",
    channel: "msedge",
    locale: "zh-CN",
    reducedMotion: "reduce",
    trace: "on",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "desktop", use: { viewport: { width: 1440, height: 1000 } } },
    { name: "tablet", use: { viewport: { width: 1024, height: 900 } } },
    { name: "narrow", use: { viewport: { width: 390, height: 844 }, hasTouch: true } },
  ],
  webServer: [
    {
      command: `"${python}" deploy/preview.py --state .test-tmp/design-workflow-preview --port 8877`,
      cwd: repoRoot,
      url: "http://127.0.0.1:8877/health",
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: "node tests/visual/serve.mjs",
      cwd: webRoot,
      url: "http://127.0.0.1:5177",
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
