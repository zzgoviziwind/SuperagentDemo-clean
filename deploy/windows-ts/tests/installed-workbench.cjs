const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");

const [origin, evidence, modules, option] = process.argv.slice(2);
const { chromium } = require(path.join(modules, "playwright"));
const views = [
  ["desktop", 1440, 1000],
  ["tablet", 1024, 900],
  ["narrow", 390, 844],
];

async function checkView(browser, [name, width, height]) {
  const context = await browser.newContext({ viewport: { width, height }, locale: "zh-CN", reducedMotion: "reduce" });
  const page = await context.newPage();
  const errors = [];
  const api = new Map();
  const blocked = [];

  try {
    await context.route("**/*", route => {
      const request = route.request();
      const url = new URL(request.url());
      const fieldWrite = option === "--field" && request.method() === "POST" &&
        /^\/api\/v1\/field-intake\/(records|candidates\/\d+\/decision)$/.test(url.pathname);
      if (url.origin === origin && (request.method() === "GET" || fieldWrite)) return route.continue();
      blocked.push({ method: request.method(), url: request.url() });
      return route.abort();
    });
    page.on("pageerror", error => errors.push(error.message));
    page.on("response", response => {
      const resource = new URL(response.url()).pathname;
      if (resource.startsWith("/api/") || resource === "/health") api.set(resource, response.status());
    });
    const screenshot = async label => {
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth) <= width + 1, `Horizontal overflow: ${label}`);
      await page.screenshot({ path: path.join(evidence, `${name}-${label}.png`), fullPage: true });
    };
    const navigate = label => page.getByRole("button", { name: label, exact: true }).click({ timeout: 12000 });
    const initial = await page.goto(origin);
    assert.equal(initial.status(), 200);
    const identity = await context.request.get(`${origin}/api/v1/auth/me`);
    assert.equal(identity.status(), 200);
    assert.equal((await identity.json()).role, "admin");
    await page.getByRole("heading", { name: "事件中心", exact: true }).first().waitFor({ timeout: 12000 });
    await screenshot("events");

    await navigate("现场记录");
    await page.getByRole("heading", { name: "录入现场材料" }).waitFor({ timeout: 12000 });
    if (option === "--field") {
      const projects = await context.request.get(`${origin}/api/v1/projects`);
      assert.equal(projects.status(), 200);
      const [project] = await projects.json();
      await page.getByLabel("医院项目").selectOption(String(project.id));
      await page.getByLabel("记录名称").fill(`安装验证 ${name}`);
      await page.getByLabel("现场笔记").fill("Bug：合成环境报告预览需排查");
      await page.getByLabel("时间轴文件（选填）").setInputFiles({ name: "timeline.json", mimeType: "application/json",
        buffer: Buffer.from(JSON.stringify({ version: 1,
          transcript: [{ start_ms: 1000, end_ms: 1300, text: "合成时间轴原始转写" }], keyframes: [] })) });
      const disabled = await page.getByLabel("音视频（选填）").isDisabled();
      assert.equal(disabled, true);
      await page.getByRole("button", { name: "整理候选事项" }).click();
      await page.getByText(/2 条待审核 · 时间轴导入/).waitFor();
      const transcript = page.getByRole("form", { name: "合成时间轴原始转写" });
      await transcript.getByText(/^证据（/).click();
      const opener = transcript.getByRole("button", { name: /^查看转写/ });
      await opener.click();
      const dialog = page.getByRole("dialog", { name: "原始转写片段" });
      await dialog.getByText("合成时间轴原始转写").waitFor();
      await screenshot("transcript");
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "hidden" });
      assert.equal(await opener.evaluate(element => element === document.activeElement), true);
      await page.getByRole("button", { name: "确认并创建事件" }).first().click();
      await page.getByText("已创建只读事件").waitFor();
      const label = await page.getByRole("button", { name: /^查看事件 #/ }).textContent();
      const id = label.match(/\d+$/)?.[0];
      const task = await context.request.get(`${origin}/api/v1/tasks/${id}`);
      assert.equal(task.status(), 200);
      assert.equal((await task.json()).task.kind, "analysis");
    }
    await screenshot("field-area");

    await navigate("项目设置");
    const trigger = page.getByRole("button", { name: /添加项目/ });
    await trigger.click({ timeout: 12000 });
    const drawer = page.getByRole("dialog", { name: "绑定项目" });
    await drawer.waitFor();
    await page.keyboard.press("Tab");
    assert.equal(await drawer.evaluate(element => element.contains(document.activeElement)), true);
    await screenshot("project-drawer");
    await page.keyboard.press("Escape");
    await drawer.waitFor({ state: "hidden" });
    assert.equal(await trigger.evaluate(element => element === document.activeElement), true);

    await navigate("Worker 工作台");
    await screenshot("workers");
    assert.deepEqual(errors, []);
    assert.deepEqual(blocked, []);
    return { viewport: name, api: Object.fromEntries(api), errors, blocked };
  } finally {
    await context.close();
  }
}

async function main() {
  const browser = await chromium.launch({ channel: "msedge" });
  const result = { browser: browser.version(), origin, views: [] };
  try {
    if (option === "--field") {
      const context = await browser.newContext();
      try {
        const project = await context.request.post(`${origin}/api/v1/projects`, { data: { name: "合成医院项目", repo_path: evidence } });
        assert.equal(project.status(), 200);
      } finally { await context.close(); }
    }
    for (const view of views) {
      try {
        result.views.push(await checkView(browser, view));
      } catch (error) {
        result.views.push({ viewport: view[0], failure: error.message });
      }
    }
  } finally {
    await browser.close();
    await fs.writeFile(path.join(evidence, "browser-results.json"), JSON.stringify(result, null, 2));
  }
  console.log(JSON.stringify(result));
  if (result.views.some(view => view.failure)) process.exitCode = 1;
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
