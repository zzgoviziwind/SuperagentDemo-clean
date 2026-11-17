import { test, expect, type Page, type TestInfo } from '@playwright/test';

async function capture(page: Page, info: TestInfo, name: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: info.outputPath(`${name}.png`), fullPage: true, animations: 'disabled' });
  await info.attach(name, { path: info.outputPath(`${name}.png`), contentType: 'image/png' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual((page.viewportSize()?.width ?? 0) + 1);
}

test('Redmine changes without notes show titles and open the original issue', async ({ page }, info) => {
  const issueUrl = 'https://redmine.example.invalid/redmine/issues/12345';
  await page.context().route(issueUrl, route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<h1>模拟 Redmine 工单 #12345</h1>' }));
  await page.route('**/api/v1/events/*/trace', route => route.fulfill({
    json: { event: { id: Number(new URL(route.request().url()).pathname.split('/').at(-2)) } },
  }));
  await page.route('**/api/v1/event-groups/index?*', async route => {
    const response = await route.fetch();
    const body = await response.json();
    const item = body.items.find((row: any) => !row.group && row.messages[0]?.source === 'redmine');
    if (item) {
      const original = item.messages[0];
      item.messages = ['status_id', 'assigned_to_id'].map((name, index) => ({
        ...original,
        id: original.id + index + 1000,
        event_type: 'issue.changed',
        content: index ? '  ' : '',
        data: { issue_id: '12345', actor_id: '158', metadata: {
          redmine_endpoint: 'https://redmine.example.invalid/redmine/', details: [{ property: 'attr', name }],
        } },
      }));
    }
    await route.fulfill({ response, json: body });
  });
  await page.goto('/');
  await expect(page.getByText('独立预览 · 自动执行已关闭', { exact: true })).toBeVisible();
  const card = page.locator('.event-choice').filter({ hasText: '2 条消息 · Redmine' });
  await expect(card).toBeVisible();
  await capture(page, info, '13-redmine-no-notes');
  const title = 'Redmine #12345 · 状态变更、指派变更';
  await expect(card.getByText(title, { exact: true })).toBeVisible();
  await card.click();
  await expect(page.getByRole('heading', { name: '消息 · 2 条消息' })).toBeVisible();
  await capture(page, info, '14-redmine-message-links');
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible({ timeout: 2000 });
  const links = page.getByRole('link', { name: '工单 #12345', exact: true });
  await expect(links).toHaveCount(2);
  for (const link of await links.all()) await expect(link).toHaveAttribute('href', issueUrl);
  const popupPromise = page.waitForEvent('popup');
  await links.first().click();
  const popup = await popupPromise;
  await expect(popup.getByRole('heading', { name: '模拟 Redmine 工单 #12345' })).toBeVisible();
  await expect(popup).toHaveURL(issueUrl);
});

test('event conditions stay visible when collapsed and empty results recover without API writes', async ({ page }, info) => {
  const writes: string[] = [];
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/**', async route => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(route.request().method())) {
      writes.push(route.request().url());
      return route.abort();
    }
    return route.continue();
  });
  await page.goto('/');
  await expect(page.getByText('独立预览 · 自动执行已关闭', { exact: true })).toBeVisible();
  await expect(page.locator('.event-choice').first()).toBeVisible();
  await page.getByRole('button', { name: /^筛选/ }).click();
  await page.getByRole('combobox', { name: '来源', exact: true }).selectOption('redmine');
  await expect(page.locator('.event-choice')).toHaveCount(1);
  await page.getByRole('button', { name: /^筛选/ }).click();
  await expect(page.getByRole('combobox', { name: '来源', exact: true })).toBeHidden();
  await expect(page.getByLabel('当前筛选条件')).toContainText('Redmine');
  await capture(page, info, '08-collapsed-conditions');
  await page.getByRole('searchbox').fill('event-center-no-match-20261116');
  await expect(page.getByText('暂无匹配事件。', { exact: true })).toBeVisible();
  await capture(page, info, '09-empty-recovery');
  await page.getByRole('button', { name: '查看全部事件', exact: true }).click();
  await expect(page.getByRole('searchbox')).toBeFocused();
  await expect(page.getByRole('searchbox')).toHaveValue('');
  await expect(page.getByLabel('当前筛选条件')).toHaveCount(0);
  await expect(page.locator('.event-choice')).toHaveCount(2);
  if (info.project.name === 'narrow') {
    for (const button of await page.getByRole('group', { name: '按状态筛选事件' }).getByRole('button').all()) {
      expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
  }
  await capture(page, info, '10-restored-list');
  expect(writes).toEqual([]);
  expect(errors).toEqual([]);
});

test('long titles and message identifiers stay within the event panels', async ({ page }, info) => {
  const title = `长标题验收-${'EventIdentifier'.repeat(18)}-结束`;
  const content = `消息编号：https://example.invalid/${'message-identifier-'.repeat(20)}`;
  await page.route('**/api/v1/event-groups/index?*', async route => {
    const response = await route.fetch();
    const body = await response.json();
    const item = body.items.find((row: any) => row.group);
    item.group.title = title;
    item.messages[item.messages.length - 1].content = content;
    await route.fulfill({ response, json: body });
  });
  await page.route('**/api/v1/tasks/*', async route => {
    const response = await route.fetch();
    const body = await response.json();
    if (body.task) body.task.title = title;
    await route.fulfill({ response, json: body });
  });
  await page.goto('/');
  const option = page.locator('.event-choice').filter({ hasText: '长标题验收-' });
  await expect(option).toBeVisible();
  await capture(page, info, '11-long-title-list');
  await option.click();
  await expect(page.locator('.event-detail h2').first()).toHaveText(title);
  const panel = page.locator('.event-detail');
  expect(await panel.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  await capture(page, info, '12-long-title-detail');
});
