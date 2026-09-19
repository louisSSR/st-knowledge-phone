import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import { verifyCollection } from './verify-collection.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.KNOWLEDGE_PHONE_PLAYWRIGHT || 'playwright');
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const directory = path.resolve(process.argv[2] || 'packs/wikipedia-zh-starter');
const acceptance = await verifyCollection(directory);
assert.equal(acceptance.status, 'passed', 'collection must pass offline acceptance first');
const report = JSON.parse(await readFile(path.join(directory, 'report.json'), 'utf8'));
const primaryQuery = report.articles[0].requestedTitles[0];
const offlineQuery = report.articles[Math.floor(report.articles.length / 2)].requestedTitles[0];
const evidence = path.join(root, 'evidence');
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({ headless: true, ...(process.env.KNOWLEDGE_PHONE_CHROME ? { executablePath: process.env.KNOWLEDGE_PHONE_CHROME } : {}) });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
const base = process.env.KNOWLEDGE_PHONE_PREVIEW || 'http://127.0.0.1:4179';
const requests = [], errors = [], checks = [];
page.on('pageerror', error => errors.push(String(error)));
page.on('request', request => requests.push(request.url()));
const done = value => { checks.push(value); console.log(`PASS ${value}`); };
const ready = () => page.locator('.content[aria-busy="false"]').waitFor();
async function nav(name) { await page.getByRole('navigation', { name: '终端导航' }).getByRole('button', { name, exact: true }).click(); await ready(); }
async function search(query) { await nav('搜索'); await page.getByRole('searchbox').fill(query); await page.getByRole('button', { name: '开始搜索' }).click(); await ready(); }
async function date(value) {
  await nav('设置');
  await page.locator('select[name="mode"]').selectOption('custom');
  await page.locator('input[name="customDate"]').fill(value);
  await page.locator('input[name="strictTimeline"]').check();
  await page.getByRole('button', { name: '保存设置' }).click();
  await page.getByText('设置已保存。', { exact: true }).waitFor();
}
try {
  await page.goto(base);
  await page.getByRole('button', { name: '打开掌上知库' }).click(); await ready();
  await nav('知库');
  for (const pack of report.packs) {
    await page.getByLabel('选择 JSON 知识资料包').setInputFiles(path.join(directory, pack.file)); await ready();
  }
  assert.equal(await page.locator('.pack').count(), report.packs.length);
  done('collected packs imported through UI into real IndexedDB');
  const modernDate = report.articles.map(item => item.retrievedAt.slice(0, 10)).sort().at(-1);
  await date(modernDate);
  for (const article of report.articles) {
    await search(article.requestedTitles[0]);
    assert.ok(await page.locator('.result-card').count(), article.title);
    await page.getByRole('button', { name: `阅读：${article.title}`, exact: true }).click();
    await page.locator('.reader-body').waitFor();
    const content = await page.locator('.reader-body').innerText();
    assert.ok(content.length > 200);
    assert.ok(content.includes('CC BY-SA 4.0') && content.includes(article.historyUrl));
    assert.equal(await page.getByRole('link', { name: '查看原始来源（打开外部网页）' }).getAttribute('href'), article.sourceUrl);
  }
  done(`${report.articles.length} original-title searches and readers retain source/license`);
  await search(primaryQuery);
  await page.locator('.result-open').first().click(); await page.locator('.reader-body').waitFor();
  await page.getByRole('button', { name: '收藏这一页', exact: true }).click();
  await page.getByRole('button', { name: '已收藏', exact: true }).waitFor();
  await page.screenshot({ path: path.join(evidence, 'corpus-reader.png') });
  await date('2008-07-18');
  await search(primaryQuery);
  assert.equal(await page.locator('.result-card').count(), 0);
  assert.equal(await page.locator('.suggestions').count(), 0);
  await nav('收藏'); assert.equal(await page.locator('.result-card').count(), 0);
  done('2008 hides current snapshots from results, suggestions and bookmarks');
  await date(modernDate);
  await page.reload();
  await page.getByRole('button', { name: '打开掌上知库' }).click(); await ready();
  await nav('知库'); assert.equal(await page.locator('.pack').count(), report.packs.length);
  await nav('收藏'); assert.equal(await page.locator('.result-card').count(), 1);
  done('refresh preserves installed collection and bookmark');
  await search(primaryQuery);
  const count = requests.length;
  await context.setOffline(true);
  await search(offlineQuery);
  assert.ok(await page.locator('.result-card').count());
  await page.locator('.result-open').first().click(); await page.locator('.reader-body').waitFor();
  assert.match(await page.locator('.reader-body').innerText(), /CC BY-SA 4.0/);
  assert.equal(requests.length, count);
  done('offline Worker search and reading make no network requests');
  await page.setViewportSize({ width: 320, height: 568 });
  assert.ok(await page.locator('.phone').evaluate(el => el.scrollWidth <= el.clientWidth));
  assert.ok(await page.locator('.reader-body').evaluate(el => el.scrollWidth <= el.clientWidth));
  await page.screenshot({ path: path.join(evidence, 'corpus-mobile.png') });
  done('320px reader has no horizontal overflow');
  assert.ok(requests.every(url => new URL(url).origin === new URL(base).origin));
  assert.deepEqual(errors, []);
  done('no external requests or page errors');
} finally {
  await writeFile(path.join(evidence, 'corpus-browser-smoke.json'), JSON.stringify({ checks, errors, requests, host: 'independent-preview', capturedAt: new Date().toISOString() }, null, 2));
  await browser.close();
}
