import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.KNOWLEDGE_PHONE_PLAYWRIGHT || 'playwright');
const file = path.resolve(process.argv[2] || 'evidence/zim/wikibooks_zh_all_nopic_2026-07.zim');
const host = process.argv.includes('--host');
const base = process.env.KNOWLEDGE_PHONE_PREVIEW || (host ? 'http://127.0.0.1:8000' : 'http://127.0.0.1:4179');
const evidence = path.resolve('evidence/zim');
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({ headless: true, ...(process.env.KNOWLEDGE_PHONE_CHROME ? { executablePath: process.env.KNOWLEDGE_PHONE_CHROME } : {}) });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
page.setDefaultTimeout(25_000);
const errors = [], requests = [], blocked = [], checks = [];
const backgroundRequests = [];
const hostSaveStacks = [];
const cdp = await context.newCDPSession(page);
await cdp.send('Network.enable');
cdp.on('Network.requestWillBeSent', event => {
  if (new URL(event.request.url).pathname !== '/api/settings/save') return;
  const frames = []; let stack = event.initiator.stack;
  while (stack) { frames.push(...stack.callFrames.map(item => ({ functionName: item.functionName, url: item.url }))); stack = stack.parent; }
  hostSaveStacks.push(frames);
});
let baseline = 0;
page.on('pageerror', error => errors.push(String(error)));
page.on('request', request => requests.push(request.url()));
await page.route('**/api/**', route => {
  if (/\/generate(?:\/|$)|\/generate-stream/.test(new URL(route.request().url()).pathname)) { blocked.push(route.request().url()); return route.abort(); }
  return route.continue();
});
const done = name => { checks.push(name); console.log(`PASS ${name}`); };
const ready = () => page.locator('.content[aria-busy="false"]').waitFor({ timeout: 60_000 });
const nav = async name => { await page.getByRole('navigation', { name: '终端导航' }).getByRole('button', { name, exact: true }).click(); await ready(); };
const search = async query => { await nav('搜索'); await page.getByRole('searchbox').fill(query); await page.getByRole('button', { name: '开始搜索' }).click(); await ready(); };
const attach = async () => { await nav('知库'); await page.getByLabel('选择本地 ZIM 知识库').setInputFiles(file); await ready(); await page.getByText('已连接 · 本地文件', { exact: true }).waitFor(); };
const frame = () => page.frameLocator('.archive-reader iframe');
const open = async title => { await page.getByRole('button', { name: `阅读：${title}`, exact: true }).click(); await ready(); await frame().locator('body').waitFor(); };
try {
  await page.goto(base);
  await page.getByRole('button', { name: '打开掌上知库', exact: true }).waitFor({ timeout: 35_000 });
  if (host) {
    const tutorial = page.locator('.acu-tutorial-close');
    if (await tutorial.isVisible()) await tutorial.click();
    await page.waitForFunction(() => !document.querySelector('dialog[open]'), {}, { timeout: 45_000 });
    if (await tutorial.waitFor({ state: 'visible', timeout: 5000 }).then(() => true, () => false)) await tutorial.click();
    await page.locator('#send_textarea').fill('/go 知库验收 B 20260920'); await page.locator('#send_but').click();
    await page.locator('#chat .mes_text').filter({ hasText: '2026-09-20' }).first().waitFor();
  }
  baseline = errors.length;
  await page.getByRole('button', { name: '打开掌上知库', exact: true }).click(); await ready();
  await page.getByRole('button', { name: '离线资料', exact: true }).click(); await ready();
  await attach();
  assert.match(await page.getByText('已连接 · 本地文件', { exact: true }).locator('..').innerText(), /8,302 篇文章/);
  done('official 94.40 MiB / 8,302 article archive opens through real UI');
  if (!host) {
    await search('扑克'); assert.equal(await page.locator('.result-card').count(), 0);
    assert.match(await page.locator('.notice').innerText(), /时间/); done('2008 strict world hides the 2026 archive');
  }
  await nav('设置'); await page.locator('select[name="mode"]').selectOption('custom');
  await page.locator('input[name="customDate"]').fill('2026-09-20');
  await page.getByRole('button', { name: '保存设置', exact: true }).click(); await ready();
  await search('斗地主'); assert.equal(await page.locator('.result-card').count(), 0);
  done('Chinese split-character false hit does not recommend unrelated European history');
  await search('扑克'); assert.equal(await page.locator('.result-card h3').first().innerText(), '扑克');
  done('exact source title ranks before related articles');
  await open('扑克');
  assert.match(await frame().locator('body').innerText(), /术语表/);
  await frame().getByRole('link', { name: '术语表', exact: true }).click(); await ready();
  await frame().locator('body').getByText('Ante（前注）', { exact: false }).first().waitFor();
  const original = await frame().locator('body').innerText();
  assert.match(original, /Creative Commons Attribution-Share Alike 4.0/); assert.ok(original.length > 400);
  assert.equal(await page.locator('.archive-reader iframe').getAttribute('sandbox'), 'allow-same-origin');
  assert.equal(await frame().locator('script,form,object,embed').count(), 0);
  done('poker original links to source glossary; terms, attribution and script-free sandbox are preserved');
  await page.getByRole('button', { name: '收藏这一页', exact: true }).click(); await ready();
  await nav('收藏'); assert.equal(await page.locator('.result-card').count(), 1);
  done('archive path bookmark is stored per chat');
  await search('化学方程式'); await open('初中化学/化学方程式');
  assert.match(await frame().locator('body').innerText(), /质量守恒/);
  assert.ok(await frame().locator('h2').count() > 0);
  await page.screenshot({ path: path.join(evidence, host ? 'host-original.png' : 'preview-original.png') });
  done('second subject opens real structured source, not a generated summary');
  await page.setViewportSize({ width: 390, height: 844 });
  const phone = await page.locator('.phone').boundingBox();
  assert.ok(phone && phone.x >= -1 && phone.width <= 392);
  await page.screenshot({ path: path.join(evidence, host ? 'host-mobile.png' : 'preview-mobile.png') });
  done('390px viewport keeps the phone inside the screen');
  const before = requests.length;
  await context.setOffline(true);
  await search('扑克'); await open('扑克');
  await frame().getByRole('link', { name: '术语表', exact: true }).click(); await ready();
  await frame().locator('body').getByText('Ante（前注）', { exact: false }).first().waitFor();
  const newHTTP = requests.slice(before).filter(url => /^https?:/.test(url));
  for (const url of newHTTP) {
    const parsed = new URL(url);
    const stack = hostSaveStacks.at(-1) || [];
    const hostSave = host && parsed.origin === new URL(base).origin && parsed.pathname === '/api/settings/save'
      && stack.some(item => /\/script\.js(?:$|\?)/.test(item.url)) && !stack.some(item => item.url.includes('st-knowledge-phone'));
    assert.ok(hostSave, `Unexpected HTTP request during offline reading: ${url}; stack=${JSON.stringify(stack)}`);
    backgroundRequests.push({ path: parsed.pathname, source: 'SillyTavern core settings save, outside extension', stack });
  }
  done('offline indexed search, original reading and glossary navigation make no HTTP requests');
  await context.setOffline(false);
  await page.setViewportSize({ width: 1440, height: 1000 });
  if (!host) {
    await page.reload(); await page.getByRole('button', { name: '打开掌上知库', exact: true }).click(); await ready();
    await nav('知库'); await page.getByText('未连接', { exact: true }).waitFor();
    await nav('收藏'); assert.equal(await page.locator('.result-card').count(), 1);
    await page.locator('.result-open').first().click(); await ready(); assert.match(await page.locator('.notice').innerText(), /重新选择|尚未连接/);
    await attach(); await nav('收藏'); await page.locator('.result-open').first().click(); await ready();
    await frame().locator('body').getByText('Ante（前注）', { exact: false }).first().waitFor();
    done('reload honestly requires reconnect; stored bookmark recovers with the same archive');
    await page.getByRole('button', { name: '关闭掌上知库', exact: true }).click();
    await page.locator('#preview-chat').selectOption('demo-empty');
    await page.getByRole('button', { name: '打开掌上知库', exact: true }).click(); await ready();
    await nav('收藏'); assert.equal(await page.locator('.result-card').count(), 0);
    done('switching chats does not leak archive bookmarks');
  }
  assert.equal(blocked.length, 0); assert.deepEqual(errors.slice(baseline), []);
  await writeFile(path.join(evidence, host ? 'host-acceptance.json' : 'preview-acceptance.json'), JSON.stringify({ capturedAt: new Date().toISOString(), status: 'passed', base, checks,
    baselineErrors: errors.slice(0, baseline), newErrors: errors.slice(baseline), modelCalls: blocked.length, backgroundRequests,
    limitations: ['No 14 GB library test', 'Mobile viewport emulation, not a physical mobile device', 'Isolated browser profile; archive selection is not transferred to other browsers'] }, null, 2));
  console.log(`PASS ${checks.length} ZIM UI checks`);
} catch (error) {
  await page.screenshot({ path: path.join(evidence, host ? 'host-failure.png' : 'preview-failure.png') }).catch(() => {});
  console.error('UI state:', (await page.locator('.phone').innerText().catch(() => '')).slice(-5000));
  throw error;
} finally { await browser.close(); }
