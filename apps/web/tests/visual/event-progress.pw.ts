import { test, expect } from '@playwright/test';

test('shows the current verification block and opens the evidence and supplement', async ({ page }, info) => {
  const time = '2026-11-17T07:05:05Z';
  await page.route('**/api/v1/tasks/*', async route => {
    if (!/\/tasks\/\d+$/.test(new URL(route.request().url()).pathname)) return route.continue();
    const response = await route.fetch();
    const body = await response.json();
    if (!body.task) return route.fulfill({ response });
    const task = { ...body.task, status: 'waiting_input', kind: 'analysis', updated_at: time,
      last_error: '只读分析存在工作区变更、访问拒绝或未解决错误，需人工处理' };
    return route.fulfill({ response, json: { ...body, task, artifacts: [
      ...body.artifacts,
      { id: 90003, kind: 'verification', revision: task.revision, created_at: time,
        content: JSON.stringify({ assessment: { suggested_status: 'waiting_input' },
          analysis_read_evidence: { denied_access: true } }) },
    ], events: [
      ...body.events,
      { id: 90001, event_type: 'run_started', source: 'runtime', created_at: time,
        data: { revision: task.revision, control_version: task.control_version } },
      { id: 90002, event_type: 'verification_incomplete', source: 'runtime', created_at: time,
        data: { reasons: ['analysis_evidence_missing'] } },
    ] } });
  });
  await page.route('**/api/**', route => ['GET', 'HEAD', 'OPTIONS'].includes(route.request().method())
    ? route.fallback() : route.abort());
  await page.goto('/');
  await expect(page.getByText('独立预览 · 自动执行已关闭', { exact: true })).toBeVisible();
  await page.locator('.event-choice').filter({ hasText: '模拟验收任务' }).first().click();
  const progress = page.getByRole('region', { name: '执行进度' });
  await expect(progress.getByRole('heading', { name: '只读分析已停在结果核验' })).toBeVisible();
  await expect(progress.getByText('核验受阻', { exact: true })).toBeVisible();
  await expect(progress).toContainText('缺少有效的只读分析依据');
  await expect(progress).toContainText('读取权限被拒绝');
  await expect(progress.getByRole('button', { name: '恢复', exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('execution-progress.png'), animations: 'disabled' });
  await progress.getByRole('button', { name: '查看核验记录' }).click();
  await expect(page.locator('[data-event-verification] > summary')).toBeFocused();
  await expect(page.locator('[data-event-verification]')).toHaveAttribute('open', '');
  await progress.getByRole('button', { name: '补充信息' }).click();
  await expect(page.getByRole('textbox', { name: '要求内容' })).toBeFocused();
  await page.screenshot({ path: info.outputPath('supplement-focus.png'), animations: 'disabled' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
});
