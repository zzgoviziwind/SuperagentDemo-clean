import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const screenshot = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO5+1ZYAAAAASUVORK5CYII=', 'base64');

test('organizes simulated field materials and reviews both intake actions', async ({ page }, info) => {
  const config = await page.request.get('/api/v1/settings');
  expect(config.ok()).toBeTruthy();
  expect(await config.json()).toMatchObject({ service_mode: 'preview', scheduler_enabled: false, external_delivery_enabled: false });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/**', route => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (request.method() === 'GET' || (request.method() === 'POST' &&
      (/^\/api\/v1\/field-intake\/(records|candidates\/\d+\/decision)$/.test(pathname)))) return route.continue();
    errors.push(`意外写入 ${pathname}`);
    return route.abort();
  });
  await page.goto('/');
  await page.getByRole('button', { name: '现场记录', exact: true }).click();
  await page.getByLabel('医院项目').selectOption({ label: '产品验收演示 · 模拟数据' });
  await page.getByLabel('记录名称').fill(`模拟现场检查 ${info.project.name}`);
  await page.getByRole('button', { name: '填入模拟笔记' }).click();
  await page.getByLabel('截图', { exact: true }).setInputFiles({ name: '模拟预览.png', mimeType: 'image/png', buffer: screenshot });
  await page.getByRole('button', { name: '整理候选事项' }).click();
  await expect(page.getByText('2 条待审核')).toBeVisible();
  await expect(page.getByRole('link', { name: '截图 1 · 模拟预览.png' })).toBeVisible();
  await page.screenshot({ path: info.outputPath('field-review.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(info.project.use.viewport!.width + 1);
  await page.getByRole('button', { name: '确认并创建事件' }).first().click();
  await expect(page.getByText('已创建只读事件')).toBeVisible();
  const created = (await page.getByRole('button', { name: /^查看事件 #/ }).textContent())!.match(/\d+$/)![0];
  await page.getByLabel('处理方式').selectOption('link');
  await page.getByLabel('同项目只读事件').selectOption(created);
  await page.getByRole('button', { name: '确认并关联' }).click();
  await expect(page.getByText('已关联只读事件')).toBeVisible();
  await page.getByRole('button', { name: `查看事件 #${created}` }).first().click();
  await expect(page.getByRole('heading', { name: '事件中心', exact: true }).first()).toBeVisible();
  await page.getByRole('tab', { name: '消息 (2)' }).click();
  const image = page.getByRole('link', { name: '截图 1 · 模拟预览.png' });
  await expect(image).toBeVisible();
  expect((await page.request.get((await image.getAttribute('href'))!)).headers()['content-type']).toBe('image/png');
  await page.screenshot({ path: info.outputPath('field-event.png'), fullPage: true });
  expect(errors).toEqual([]);
});

test('reviews grounded candidates from the real organizer acceptance', async ({ page }, info) => {
  const resultPath = process.env.SUPERAGENT_FIELD_VISUAL_RESULT;
  test.skip(!resultPath, 'Requires the saved result of the opt-in live organizer acceptance');
  const record = JSON.parse(readFileSync(resultPath!, 'utf8'));
  await page.route('**/api/v1/field-intake/**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    expect(route.request().method()).toBe('GET');
    if (pathname.endsWith('/organizer')) return route.fulfill({ json: { mode: 'local_ocr_codex' } });
    if (pathname.endsWith('/media-jobs')) return route.fulfill({ json: { ready: false, jobs: [] } });
    if (pathname.endsWith('/records')) return route.fulfill({ json: [{ id: record.id, title: record.title }] });
    if (pathname.endsWith('/targets')) return route.fulfill({ json: [] });
    return route.fulfill({ json: record });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '现场记录', exact: true }).click();
  await page.getByLabel('最近记录').selectOption(record.id);
  await expect(page.getByText('3 条待审核')).toBeVisible();
  const preview = page.getByRole('form', { name: /科室小结/ });
  const exportReview = page.getByRole('form', { name: /审核时间/ });
  const sync = page.getByRole('form', { name: /504/ });
  for (const candidate of [preview, exportReview, sync]) await candidate.getByText(/^证据（/).click();
  await expect(preview.getByRole('link', { name: /截图 2/ }).first()).toBeVisible();
  await expect(exportReview.getByText('笔记第 2 行')).toBeVisible();
  await expect(sync.getByRole('link', { name: /截图 4/ }).first()).toBeVisible();
  await exportReview.getByText(/^证据（/).click();
  await sync.getByText(/^证据（/).click();
  await page.screenshot({ path: info.outputPath('field-real-evidence.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(info.project.use.viewport!.width + 1);
});

test('imports a timeline and opens every cited original segment and image', async ({ page, context }, info) => {
  const directory = process.env.SUPERAGENT_FIELD_TIMELINE_VISUAL_DIR;
  const images = process.env.SUPERAGENT_FIELD_TIMELINE_IMAGES;
  test.skip(!directory || !images, 'Requires the fictional assets and the actual import acceptance result');
  const record = JSON.parse(readFileSync(path.join(directory!, 'candidates.json'), 'utf8'));
  const manifest = path.join(directory!, 'timeline.json');
  const timeline = JSON.parse(readFileSync(manifest, 'utf8'));
  await context.route('**/api/v1/field-intake/**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (route.request().method() === 'POST') {
      expect(pathname).toBe('/api/v1/field-intake/records');
      const submitted = route.request().postDataJSON();
      expect(submitted.timeline).toEqual(timeline);
      expect(submitted.screenshots.map((image: { filename: string }) => image.filename))
        .toEqual(timeline.keyframes.map((frame: { filename: string }) => frame.filename));
      return route.fulfill({ json: record });
    }
    if (pathname.endsWith('/organizer')) return route.fulfill({ json: { mode: 'local_ocr_codex' } });
    if (pathname.endsWith('/media-jobs')) return route.fulfill({ json: { ready: false, jobs: [] } });
    if (pathname.endsWith('/records') || pathname.endsWith('/targets')) return route.fulfill({ json: [] });
    const segment = pathname.match(/\/transcript\/T(\d+)$/)?.[1];
    if (segment) return route.fulfill({ json: { id: `T${segment}`, ...timeline.transcript[Number(segment) - 1] } });
    const screenshot = pathname.match(/\/screenshots\/(\d+)$/)?.[1];
    if (screenshot) return route.fulfill({ contentType: 'image/png',
      path: path.join(images!, record.screenshots[Number(screenshot) - 1].filename) });
    return route.abort();
  });
  await page.goto('/');
  await page.getByRole('button', { name: '现场记录', exact: true }).click();
  await page.getByLabel('医院项目').selectOption({ label: '产品验收演示 · 模拟数据' });
  await page.getByLabel('记录名称').fill('脱敏交流时间轴');
  await page.getByLabel('时间轴文件（选填）').setInputFiles(manifest);
  await page.getByLabel('截图', { exact: true }).setInputFiles(timeline.keyframes.map((frame: { filename: string }) => path.join(images!, frame.filename)));
  await page.getByRole('button', { name: '整理候选事项' }).click();
  await expect(page.getByText('3 条待审核 · 时间轴导入')).toBeVisible();
  for (const { draft } of record.candidates) {
    const candidate = page.getByRole('form', { name: draft.title });
    await candidate.getByText(/^证据（/).click();
    const trigger = candidate.getByRole('button', { name: /^查看转写/ }).first();
    await trigger.click();
    const dialog = page.getByRole('dialog', { name: '原始转写片段' });
    await expect(dialog.getByText(draft.evidence.find((ref: { id: string }) => ref.id.startsWith('T')).text)).toBeVisible();
    if (draft === record.candidates[0].draft) await page.screenshot({ path: info.outputPath('field-timeline-segment.png') });
    await page.keyboard.press('Escape');
    await expect(trigger).toBeFocused();
    const original = candidate.getByRole('link', { name: /^截图/ }).first();
    const opened = context.waitForEvent('page');
    await original.click();
    const imagePage = await opened;
    await expect(imagePage.locator('img')).toBeVisible();
    await imagePage.close();
  }
  await page.getByRole('heading', { name: '审核候选事项' }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('field-timeline-review.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(info.project.use.viewport!.width + 1);
});

test('uploads a recording and seeks the player to cited speech', async ({ page, context }, info) => {
  const directory = process.env.SUPERAGENT_FIELD_MEDIA_VISUAL_DIR;
  const recording = process.env.SUPERAGENT_FIELD_MEDIA_VIDEO;
  test.skip(!directory || !recording, 'Requires opt-in live media acceptance artifacts');
  const record = JSON.parse(readFileSync(path.join(directory!, 'record.json'), 'utf8'));
  const source = readFileSync(recording!);
  let uploaded = false;
  const job = { id: record.id, title: record.title, state: 'ready', phase: 'ready' };
  await context.route('**/api/v1/field-intake/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/media-jobs')) {
      if (route.request().method() === 'POST') {
        expect(route.request().postData()).toContain('filename="meeting.mp4"');
        expect(route.request().postData()).toContain('"screenshot_times":[19000]');
        uploaded = true;
        return route.fulfill({ status: 202, json: { ...job, state: 'queued', phase: 'queued' } });
      }
      return route.fulfill({ json: { ready: true, jobs: uploaded ? [job] : [] } });
    }
    if (url.pathname.endsWith('/organizer')) return route.fulfill({ json: { mode: 'local_ocr_codex' } });
    if (url.pathname.endsWith('/records') || url.pathname.endsWith('/targets')) return route.fulfill({ json: [] });
    if (url.pathname.endsWith('/media')) {
      const range = route.request().headers().range?.match(/^bytes=(\d+)-(\d*)$/);
      if (!range) return route.fulfill({ contentType: 'video/mp4', body: source });
      const begin = Number(range[1]);
      const end = range[2] ? Math.min(Number(range[2]), source.length - 1) : source.length - 1;
      return route.fulfill({ status: 206, contentType: 'video/mp4', body: source.subarray(begin, end + 1),
        headers: { 'Content-Range': `bytes ${begin}-${end}/${source.length}`, 'Accept-Ranges': 'bytes' } });
    }
    const segment = url.pathname.match(/\/transcript\/(T\d+)$/)?.[1];
    if (segment) return route.fulfill({ json: record.candidates.flatMap((item: any) => item.draft.evidence)
      .find((ref: any) => ref.id === segment) });
    return route.fulfill({ json: record });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '现场记录', exact: true }).click();
  await page.getByLabel('医院项目').selectOption({ label: '产品验收演示 · 模拟数据' });
  await page.getByLabel('记录名称').fill(record.title);
  await page.getByLabel('音视频（选填）').setInputFiles(recording!);
  await page.getByLabel('截图', { exact: true }).setInputFiles({ name: 'export.png', mimeType: 'image/png', buffer: screenshot });
  await page.getByLabel('export.png · 距原文件开头秒数').fill('19');
  await page.getByRole('button', { name: '提交后台处理' }).click();
  await page.getByRole('button', { name: '审核候选事项', exact: true }).click();
  const requirement = record.candidates.find((item: any) => item.draft.kind === 'requirement').draft;
  const candidate = page.getByRole('form', { name: requirement.title });
  await candidate.getByText(/^证据（/).click();
  await candidate.getByRole('button', { name: /^查看转写/ }).first().click();
  const segment = requirement.evidence.find((ref: any) => ref.start_ms !== undefined);
  expect(segment.start_ms).toBeGreaterThan(0);
  const player = page.getByRole('dialog').locator('video');
  await expect.poll(() => player.evaluate((node: HTMLVideoElement) => node.readyState >= 2 && !node.seeking)).toBe(true);
  await expect.poll(() => player.evaluate((node: HTMLVideoElement) => node.currentTime)).toBeCloseTo(segment.start_ms / 1000, 1);
  await expect(page.getByRole('dialog').getByText(segment.text)).toBeVisible();
  await page.screenshot({ path: info.outputPath('field-media-playback.png') });
  await player.evaluate((node: HTMLVideoElement, end: number) => {
    node.muted = true;
    node.currentTime = end - 0.4;
    return node.play();
  }, segment.end_ms / 1000);
  await expect.poll(() => player.evaluate((node: HTMLVideoElement) => node.paused)).toBe(true);
  await page.keyboard.press('Escape');
  await expect(candidate.getByRole('link', { name: /^截图/ }).first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(info.project.use.viewport!.width + 1);
});
