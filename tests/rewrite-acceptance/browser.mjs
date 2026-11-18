import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const [action, work, deps, url, taskId, proof, executablePath] = process.argv.slice(2);
const requireWeb = createRequire(join(deps, '..', 'package.json'));
if (action === 'build') {
  const {build} = await import(pathToFileURL(join(deps,'vite/dist/node/index.js')));
  const react = requireWeb('@vitejs/plugin-react');
  await build({configFile:false, root:resolve(import.meta.dirname,'../../apps/web'),
    plugins:[react()], cacheDir:join(work,'vite-cache'), logLevel:'warn',
    resolve:{alias:{react:join(deps,'react'),'react-dom':join(deps,'react-dom')}},
    build:{outDir:join(work,'web'),emptyOutDir:false}});
} else {
  const {chromium} = requireWeb('playwright');
  const browser = await chromium.launch({...(executablePath ? {executablePath} : {channel:'msedge'}),headless:true,
    args:['--disable-background-networking','--disable-component-update']});
  const context = await browser.newContext({locale:'zh-CN',viewport:{width:1440,height:1000},
    reducedMotion:'reduce',serviceWorkers:'block'});
  const page = await context.newPage();
  page.setDefaultTimeout(12000);
  const errors = [], badResponses = [], writes = [];
  await context.route('**/*', route => new URL(route.request().url()).origin === url
    ? route.continue() : route.abort());
  page.on('pageerror', err => errors.push(err.message));
  page.on('response', response => {
    const path = new URL(response.url()).pathname;
    if (response.status() >= 400) badResponses.push([path,response.status()]);
    if (response.request().method() === 'POST') writes.push([path,response.status()]);
  });
  try {
    await page.goto(url);
    await page.getByLabel('访问令牌').fill('fixture-admin');
    await page.getByRole('button',{name:'登录',exact:true}).last().click();
    const event = page.locator(`button[data-event-key="group:${taskId}"]`);
    await event.click();
    await page.getByRole('tab',{name:/回复/}).click();
    const check = page.getByText('记录渠道核实结果',{exact:true});
    await check.click();
    const submit = page.getByRole('button',{name:'提交发送对账'});
    assert(await submit.isDisabled());
    await page.getByLabel('外部核验结果').selectOption('succeeded');
    assert(await submit.isDisabled());
    await page.getByLabel('核验证据').fill(proof);
    await page.screenshot({path:join(work,'01-unknown.png')});
    const response = page.waitForResponse(r => r.url().endsWith('/reconcile') && r.request().method()==='POST');
    await submit.click();
    const confirmed = await response;
    assert.equal(confirmed.status(),200);
    assert.equal((await confirmed.json()).write_status,'succeeded');
    await page.getByText('对账结果已记录。',{exact:true}).waitFor();
    await page.reload();
    await event.click();
    await page.getByRole('tab',{name:/回复/}).click();
    await page.getByText('已回复',{exact:true}).first().waitFor();
    assert.equal(await page.getByText('记录渠道核实结果',{exact:true}).count(),0);
    await page.screenshot({path:join(work,'02-after-reload.png')});
    assert.deepEqual(errors,[]);
    assert(writes.every(([path])=>path.endsWith('/login') || path.endsWith('/reconcile')));
  } catch (error) {
    await page.screenshot({path:join(work,'ui-failure.png')}).catch(()=>{});
    await writeFile(join(work,'ui-failure.txt'),await page.locator('body').innerText().catch(()=>''));
    throw error;
  } finally {
    await writeFile(join(work,'browser.json'),JSON.stringify({browser:browser.version(),viewport:page.viewportSize(),
      pageErrors:errors,httpErrors:badResponses,writes},null,2));
    await browser.close();
  }
}
