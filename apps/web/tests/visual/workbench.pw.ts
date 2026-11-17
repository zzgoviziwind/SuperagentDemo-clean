import { test, expect, type Page, type TestInfo } from "@playwright/test";

const errors = new WeakMap<Page, string[]>();

async function capture(page: Page, info: TestInfo, name: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.mouse.move(0, 0);
  const geometry = await page.evaluate(() => ({
    viewport: { width: innerWidth, height: innerHeight },
    documentWidth: document.documentElement.scrollWidth,
    canvas: getComputedStyle(document.body).backgroundColor,
    font: getComputedStyle(document.body).fontFamily,
    accent: getComputedStyle(document.documentElement).getPropertyValue("--accent").trim(),
  }));
  await info.attach(`${name}-geometry`, { body: JSON.stringify(geometry, null, 2), contentType: "application/json" });
  expect.soft(geometry.documentWidth, `${name}: no page-level horizontal overflow`).toBeLessThanOrEqual(geometry.viewport.width + 1);
  const modalOpen = await page.locator("dialog:modal").count();
  await page.screenshot({ path: info.outputPath(`${name}.png`), fullPage: modalOpen === 0, animations: "disabled" });
  await info.attach(name, { path: info.outputPath(`${name}.png`), contentType: "image/png" });
}

test.beforeEach(async ({ page }, info) => {
  const failures: string[] = [];
  errors.set(page, failures);
  page.on("pageerror", error => failures.push(error.message));
  page.on("response", response => {
    if (response.url().includes("/api/") && response.status() >= 400) {
      failures.push(`HTTP ${response.status()} ${response.url()}`);
    }
  });
  await page.route("**/api/**", async route => {
    if (!["GET", "HEAD", "OPTIONS"].includes(route.request().method())) {
      failures.push(`Unexpected write: ${route.request().method()} ${route.request().url()}`);
      await route.abort();
      return;
    }
    await route.continue();
  });
  await page.goto("/");
  await expect(page.getByText("独立预览 · 自动执行已关闭", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "事件中心", exact: true })).toHaveAttribute("aria-current", "page");
  const settings = await page.request.get("/api/v1/settings");
  expect(settings.ok()).toBeTruthy();
  const state = await settings.json();
  expect(state.service_mode).toBe("preview");
  for (const key of ["scheduler_enabled", "router_agent_enabled", "semantic_routing_enabled", "watchdog_enabled", "external_delivery_enabled"]) {
    expect(state[key], key).toBe(false);
  }
  await info.attach("environment", {
    body: JSON.stringify({ url: page.url(), browser: page.context().browser()?.version(), viewport: page.viewportSize(), fixture: "deploy/preview.py", executionDisabled: true }, null, 2),
    contentType: "application/json",
  });
});

test.afterEach(async ({ page }) => {
  expect(errors.get(page) ?? [], "no page errors, failed APIs or UI writes").toEqual([]);
});

test("event list, detail, return and empty search", async ({ page }, info) => {
  await page.route("**/api/v1/projects", async route => {
    if (route.request().method() !== "GET") return route.fallback();
    const response = await route.fetch();
    const projects = await response.json();
    await route.fulfill({ response, json: [...projects, { ...projects[0], id: 99999, name: "备用项目（模拟）", enabled: true }] });
  });
  await page.route(/\/api\/v1\/tasks\/\d+$/, async route => {
    if (route.request().method() !== "GET") return route.fallback();
    const response = await route.fetch();
    const detail = await response.json();
    await route.fulfill({ response, json: { ...detail, task: { ...detail.task, kind: "reply" } } });
  });
  await page.reload();
  const events = page.locator(".event-choice");
  await expect(events.first()).toBeVisible();
  await capture(page, info, "01-event-list");
  await events.filter({ hasText: "#1001" }).first().click();
  await expect(page.locator(".event-detail").getByRole("heading", { level: 2 }).first()).toContainText("#1001");
  await expect(page.getByRole("button", { name: "结束事件", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "恢复", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "由我接着做", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "改为只读分析", exact: true })).toBeVisible();
  await capture(page, info, "02-event-detail");
  const rebind = page.getByRole("button", { name: "更改所属项目", exact: true });
  await rebind.click();
  const projectDialog = page.getByRole("dialog", { name: "更改所属项目" });
  await expect(projectDialog.getByLabel("目标项目")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(projectDialog).toHaveCount(0);
  await expect(rebind).toBeFocused();
  await page.getByRole("button", { name: "结束事件", exact: true }).click();
  const closeDialog = page.getByRole("dialog", { name: "结束此事件？" });
  await expect(closeDialog.getByRole("button", { name: "返回" })).toBeFocused();
  await capture(page, info, "02b-event-close-confirm");
  await page.keyboard.press("Escape");
  await expect(closeDialog).toHaveCount(0);
  await expect(page.getByRole("button", { name: "结束事件", exact: true })).toBeFocused();
  if (info.project.name === "narrow") {
    await page.getByRole("button", { name: "返回事件列表", exact: true }).click();
    await expect(page.getByRole("searchbox", { name: "搜索事件或消息内容" })).toBeVisible();
  }
  const search = page.getByRole("searchbox", { name: "搜索事件或消息内容" });
  await search.fill("no-match-design-workflow-987654321");
  await expect(events).toHaveCount(0);
  await capture(page, info, "03-empty-search");
  await search.fill("");
  await expect(events.first()).toBeVisible();
});

test("navigation and native project drawer keyboard behavior", async ({ page }, info) => {
  const nav = page.getByRole("navigation", { name: "主导航" });
  await nav.getByRole("button", { name: "项目设置", exact: true }).click();
  await expect(page.getByRole("heading", { name: "已绑定项目", exact: true })).toBeVisible();
  await capture(page, info, "04-projects");
  const add = page.getByRole("button", { name: "＋ 添加项目", exact: true });
  await add.click();
  const drawer = page.getByRole("dialog", { name: "绑定项目", exact: true });
  await expect(drawer).toBeVisible();
  expect(await drawer.evaluate(dialog => dialog.matches(":modal"))).toBe(true);
  for (let index = 0; index < 4; index += 1) {
    await page.keyboard.press("Tab");
    expect(await drawer.evaluate(dialog => dialog.contains(document.activeElement))).toBe(true);
  }
  await capture(page, info, "05-project-drawer");
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);
  await expect(add).toBeFocused();
  await nav.getByRole("button", { name: "管理设置", exact: true }).click();
  await expect(page.locator(".settings-layout")).toBeVisible();
  await expect(page.getByRole("button", { name: "正在检查…", exact: true })).toHaveCount(0, { timeout: 45_000 });
  await expect(page.getByRole("button", { name: "保存消息与交付方式", exact: true })).toBeEnabled();
  await page.getByLabel("交付方式").selectOption("auto_send");
  await expect(page.getByLabel("自动回复有效期（从来信起，分钟）")).toBeVisible();
  await expect(page.getByLabel("模型回复规则（可选）")).toBeVisible();
  await page.getByLabel("交付方式").scrollIntoViewIfNeeded();
  await capture(page, info, "06-settings");
  await nav.getByRole("button", { name: "Worker 工作台", exact: true }).click();
  await expect(page.locator(".session-workbench")).toBeVisible();
  await capture(page, info, "07-worker");
});

test("stage model settings and prompt preview", async ({ page }, info) => {
  await page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: "管理设置", exact: true }).click();
  await page.getByText("模型与推理强度", { exact: true }).click();
  const routing = page.getByRole("group", { name: "事件分流", exact: true });
  const model = routing.getByRole("combobox", { name: "Codex 模型" });
  await expect(model).toHaveValue("");
  await model.selectOption("gpt-6.1-terra");
  await expect(model).toHaveValue("gpt-6.1-terra");
  await expect(routing.getByLabel("推理强度")).toHaveValue("");
  await routing.getByLabel("推理强度").selectOption("low");
  await page.locator(".codex-profiles").screenshot({ path: info.outputPath("model-settings.png"), animations: "disabled" });
  await model.selectOption({ label: "手动输入…" });
  await model.focus();
  await page.keyboard.press("Tab");
  await expect(routing.getByLabel("推理强度")).toBeFocused();
  await page.keyboard.press("Tab");
  const custom = routing.getByRole("textbox", { name: "自定义模型名称" });
  await expect(custom).toBeFocused();
  expect(await custom.evaluate((input: HTMLInputElement) => input.validity.valueMissing)).toBe(true);
  await custom.fill("custom-preview-model");
  await routing.screenshot({ path: info.outputPath("model-settings-custom.png"), animations: "disabled" });
  await model.selectOption({ label: "沿用全局" });
  await expect(model).toHaveValue("");
  await expect(custom).toHaveCount(0);
  const open = routing.getByRole("button", { name: "查看提示词" });
  await open.click();
  const preview = page.getByRole("dialog", { name: "事件分流 · 提示词" });
  const secondPrompt = preview.getByRole("heading", { name: "项目归属与关联研判指令" });
  await expect(secondPrompt).toBeVisible();
  await expect(preview.getByText(/同一发送人和时间接近不能单独作为依据/)).toBeVisible();
  expect(await preview.evaluate((dialog) => dialog.scrollWidth)).toBeLessThanOrEqual((await page.viewportSize())!.width);
  await capture(page, info, "model-prompt");
  await secondPrompt.scrollIntoViewIfNeeded();
  await expect(secondPrompt).toBeInViewport();
  await page.keyboard.press("Escape");
  await expect(preview).toHaveCount(0);
  await expect(open).toBeFocused();
  await expect(routing.getByLabel("推理强度")).toHaveValue("low");
});
