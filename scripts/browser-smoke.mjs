import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.KNOWLEDGE_PHONE_PLAYWRIGHT || 'playwright');
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const evidence = path.join(root, 'evidence');
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({ headless: true, ...(process.env.KNOWLEDGE_PHONE_CHROME ? { executablePath: process.env.KNOWLEDGE_PHONE_CHROME } : {}) });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const errors = [], requests = [], checks = [];
page.on('pageerror', error => errors.push(String(error)));
page.on('request', request => requests.push(request.url()));
const base = process.env.KNOWLEDGE_PHONE_PREVIEW || 'http://127.0.0.1:4179';
const done = name => { checks.push(name); console.log(`PASS ${name}`); };
async function ready() { await page.locator('.content[aria-busy="false"]').waitFor(); }
async function nav(label) { await page.getByRole('navigation', { name: '终端导航' }).getByRole('button', { name: label, exact: true }).click(); await ready(); }
async function search(query) { await nav('搜索'); await page.getByRole('searchbox', { name: '搜索离线知识库' }).fill(query); await page.getByRole('button', { name: '开始搜索' }).click(); await ready(); }
async function insideViewport(locator, label) {
  const bounds = await locator.boundingBox();
  const viewport = page.viewportSize();
  assert.ok(bounds && bounds.width > 0 && bounds.height > 0 && bounds.x >= -1 && bounds.y >= -1
    && bounds.x + bounds.width <= viewport.width + 1 && bounds.y + bounds.height <= viewport.height + 1,
  `${label} must stay inside ${JSON.stringify(viewport)}: ${JSON.stringify(bounds)}`);
}
try {
  await page.goto(base);
  await page.getByRole('button', { name: '打开掌上知库' }).click(); await ready();
  await page.getByText('2008 / 07 / 18', { exact: true }).waitFor();
  const homeNodes = await page.locator('.phone').evaluate(node => node.querySelectorAll('*').length);
  assert.ok(homeNodes < 150, `Home DOM: ${homeNodes}`);
  await page.screenshot({ path: path.join(evidence, 'desktop-home.png') }); done(`desktop home / ${homeNodes} DOM nodes`);
  await nav('知库');
  await page.getByRole('button', { name: '安装原创演示包' }).click(); await ready();
  await page.getByRole('button', { name: '演示包已安装' }).waitFor(); done('pack install in real IndexedDB');
  await search(process.env.KNOWLEDGE_PHONE_TEST_QUERY || '扑克牌怎么玩');
  assert.equal(await page.locator('.result-card').count(), 6);
  await page.screenshot({ path: path.join(evidence, 'desktop-search.png') }); done('broad poker query returns six game choices');
  const firstTitle = await page.locator('.result-card h3').first().innerText();
  await page.getByRole('button', { name: `阅读：${firstTitle}`, exact: true }).click();
  await page.locator('.reader-body').waitFor(); assert.ok((await page.locator('.reader-body').innerText()).length > 30);
  await page.screenshot({ path: path.join(evidence, 'desktop-reader.png') }); done('lazy reader with provenance');
  await page.getByRole('button', { name: '收藏这一页', exact: true }).click();
  await page.getByRole('button', { name: '已收藏', exact: true }).waitFor();
  await nav('收藏'); assert.equal(await page.locator('.result-card').count(), 1); done('bookmark reader and list');
  await nav('历史'); assert.ok(await page.locator('.history-item').count() > 0); done('manual search history');
  await page.getByRole('button', { name: '关闭掌上知库' }).click();
  assert.equal(await page.locator('[role="dialog"]').count(), 0);
  await page.selectOption('#preview-chat', 'demo-2025');
  await page.getByRole('button', { name: '打开掌上知库' }).click(); await ready();
  await nav('历史'); assert.equal(await page.locator('.history-item').count(), 0);
  await nav('收藏'); assert.equal(await page.locator('.result-card').count(), 0); done('chat history and bookmark isolation');
  await search('2025'); assert.ok(await page.locator('.result-card').count() > 0); done('future knowledge visible in future world');
  await page.getByRole('button', { name: '关闭掌上知库' }).click();
  await page.selectOption('#preview-chat', 'demo-2008');
  await page.getByRole('button', { name: '打开掌上知库' }).click(); await ready();
  await search('2025'); assert.equal(await page.locator('.result-card').count(), 0);
  assert.equal(await page.locator('.suggestions').count(), 0); done('2008 excludes future results and suggestions');
  await search('秋装'); assert.ok(await page.locator('.result-card').count() > 0); done('fashion shortcut matches local period material');
  await nav('设置'); await page.locator('select[name="theme"]').selectOption('no-game-no-life');
  await page.locator('select[name="mode"]').selectOption('custom'); await page.locator('input[name="customDate"]').fill('2013-01-01');
  await page.getByRole('button', { name: '保存设置' }).click();
  await page.getByText('设置已保存。', { exact: true }).waitFor();
  await page.getByRole('button', { name: '掌上知库，返回首页' }).click();
  await page.getByText('2013 / 01 / 01', { exact: true }).waitFor(); done('manual date and theme settings');
  await nav('设置'); await page.locator('select[name="mode"]').selectOption('story');
  await page.locator('select[name="theme"]').selectOption('midnight'); await page.getByRole('button', { name: '保存设置' }).click();
  await page.getByText('设置已保存。', { exact: true }).waitFor();
  await page.reload(); await page.getByRole('button', { name: '打开掌上知库' }).click(); await ready();
  await nav('收藏'); assert.equal(await page.locator('.result-card').count(), 1);
  await nav('知库'); await page.getByRole('button', { name: '演示包已安装' }).waitFor(); done('refresh preserves packs and bookmarks');
  await page.getByLabel('选择 JSON 知识资料包').setInputFiles(path.join(root, 'packs/original-demo.pack.json')); await ready();
  await page.getByText('同 ID 知识包已安装，请先卸载', { exact: true }).waitFor();
  assert.equal(await page.locator('.pack').count(), 1); done('duplicate install is rejected atomically');
  await page.getByLabel('选择 JSON 知识资料包').setInputFiles({ name: 'invalid.pack.json', mimeType: 'application/json', buffer: Buffer.from('{"schemaVersion":99}') }); await ready();
  assert.equal(await page.locator('.pack').count(), 1); done('invalid pack leaves library intact');
  await search('扑克牌'); const requestCount = requests.length;
  await context.setOffline(true);
  await page.getByRole('searchbox', { name: '搜索离线知识库' }).fill('德州扑克');
  await page.getByRole('button', { name: '开始搜索' }).click(); await ready();
  assert.equal(await page.locator('.result-card').count(), 1);
  await page.locator('.result-open').first().click(); await page.locator('.reader-body').waitFor();
  assert.equal(requests.length, requestCount); done('offline search and reader send no network requests');
  await context.setOffline(false);
  await page.getByRole('button', { name: '掌上知库，返回首页' }).click();
  // Real ST applies a transform to html, which can have zero layout height on narrow screens.
  // Checking only horizontal overflow missed a dialog centered above the visible viewport.
  await page.addStyleTag({ content: 'html{transform:translateZ(0);perspective:1000px;height:0}body{height:100dvh;margin:0}' });
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }, { width: 320, height: 568 }]) {
    await page.setViewportSize(viewport);
    await insideViewport(page.locator('.phone'), 'phone');
    await insideViewport(page.locator('.topbar'), 'header');
    await insideViewport(page.getByRole('button', { name: '关闭掌上知库' }), 'close button');
    await insideViewport(page.locator('.bottom-nav'), 'navigation');
    const backdrop = await page.locator('.backdrop').boundingBox();
    assert.equal(backdrop.height, viewport.height);
    assert.equal(backdrop.width, viewport.width);
  }
  done('transformed zero-height host keeps dialog, header and close button in viewport');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.locator('.phone').evaluate(el => el.scrollWidth <= el.clientWidth));
  await page.screenshot({ path: path.join(evidence, 'mobile-home.png') });
  await page.setViewportSize({ width: 320, height: 568 });
  assert.ok(await page.locator('.phone').evaluate(el => el.scrollWidth <= el.clientWidth));
  await nav('设置'); assert.ok(await page.locator('.content').evaluate(el => el.scrollWidth <= el.clientWidth)); done('390px and 320px mobile layouts fit');
  await page.keyboard.press('Escape'); await page.getByRole('button', { name: '打开掌上知库' }).waitFor();
  await insideViewport(page.getByRole('button', { name: '打开掌上知库' }), 'launcher on transformed host');
  await page.locator('#preview-chat').click();
  await page.keyboard.press('Escape');
  done('closed transformed-host launcher remains reachable and lets host clicks through');
  await page.getByRole('button', { name: '打开掌上知库' }).click(); await ready(); done('Escape close and reopen');
  await nav('知库'); await page.getByRole('button', { name: '移除', exact: true }).click();
  await page.getByRole('button', { name: '确认移除', exact: true }).click(); await ready();
  assert.equal(await page.locator('.pack').count(), 0);
  await search('扑克牌'); assert.equal(await page.locator('.result-card').count(), 0);
  await nav('收藏'); assert.equal(await page.locator('.result-card').count(), 0); done('uninstall clears search and hides stale bookmarks');
  assert.ok(requests.every(url => new URL(url).origin === new URL(base).origin)); done('no external requests');
} finally {
  await writeFile(path.join(evidence, 'browser-smoke.json'), JSON.stringify({ checks, errors, requests, host: 'independent-preview', capturedAt: new Date().toISOString() }, null, 2));
  await browser.close();
}
assert.deepEqual(errors, []);
