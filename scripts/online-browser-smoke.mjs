import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.KNOWLEDGE_PHONE_PLAYWRIGHT || 'playwright');
const host = process.argv.includes('--host');
const base = process.env.KNOWLEDGE_PHONE_PREVIEW || (host ? 'http://127.0.0.1:8000' : 'http://127.0.0.1:4179');
const evidence = path.resolve('evidence/online');
const proxy = process.env.KNOWLEDGE_PHONE_PROXY;
const marker = 'KP_PRIVATE_CHAT_MARKER_20260920';
const errors = [], requests = [], blocked = [], checks = [], timings = [], backgroundRequests = [];
let baseline = 0;
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({ headless: true,
  ...(process.env.KNOWLEDGE_PHONE_CHROME ? { executablePath: process.env.KNOWLEDGE_PHONE_CHROME } : {}) });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 },
  ...(proxy ? { proxy: { server: proxy, bypass: 'localhost,127.0.0.1' } } : {}) });
const page = await context.newPage();
page.setDefaultTimeout(25_000);
page.on('pageerror', error => errors.push(String(error)));
page.on('request', request => requests.push({ url: request.url(), method: request.method(), body: request.postData() ?? '' }));
await context.route('**/api/**', route => {
  if (/\/generate(?:\/|$)|\/generate-stream/.test(new URL(route.request().url()).pathname)) {
    blocked.push(route.request().url());
    return route.abort();
  }
  return route.continue();
});
// Give the disposable preview conversation a unique private marker. This modifies only
// a response in this test browser, never a source file or a real user's conversation.
if (!host) await page.route('**/dist/preview.js', async route => {
  const response = await route.fetch();
  const original = await response.text();
  assert.ok(original.includes('话题：扑克牌、秋装'), 'preview fixture must contain the known test conversation');
  await route.fulfill({ response, body: original.replace('话题：扑克牌、秋装', `话题：扑克牌、秋装\\n${marker}`) });
});
const done = name => { checks.push(name); console.log(`PASS ${name}`); };
const ready = () => page.locator('.content[aria-busy="false"]').waitFor({ timeout: 30_000 });
const nav = async name => {
  await page.getByRole('navigation', { name: '终端导航' }).getByRole('button', { name, exact: true }).click();
  await ready();
};
const frame = () => page.frameLocator('.archive-reader iframe');
const search = async query => {
  if (!await page.getByRole('searchbox', { name: '搜索中文维基百科' }).count()) {
    await page.getByRole('button', { name: '掌上知库，返回首页', exact: true }).click();
    await ready();
  }
  await page.getByRole('searchbox', { name: '搜索中文维基百科' }).fill(query);
  const started = Date.now();
  await page.getByRole('button', { name: '开始搜索', exact: true }).click();
  await ready();
  timings.push({ query, milliseconds: Date.now() - started });
};
const open = async title => {
  await page.getByRole('button', { name: `阅读：${title}`, exact: true }).click();
  await ready();
  await frame().locator('body').waitFor();
};
const apiRequests = list => list.filter(request => new URL(request.url).origin === 'https://zh.wikipedia.org'
  && new URL(request.url).pathname === '/w/api.php');

async function enterHost() {
  const tutorial = page.locator('.acu-tutorial-close');
  if (await tutorial.isVisible()) await tutorial.click();
  await page.waitForFunction(() => !document.querySelector('dialog[open]'), {}, { timeout: 45_000 });
  if (await tutorial.waitFor({ state: 'visible', timeout: 5000 }).then(() => true, () => false)) await tutorial.click();
  await page.locator('#send_textarea').fill('/go 知库验收 B 20260920');
  await page.locator('#send_but').click();
  await page.locator('#chat .mes_text').filter({ hasText: '2026-09-20' }).first().waitFor();
}

function validateApiPrivacy() {
  const calls = apiRequests(requests);
  assert.ok(calls.length > 0, 'real official API calls must have occurred');
  const allowed = new Set(['action', 'list', 'srsearch', 'srlimit', 'srprop', 'srinfo', 'titles', 'redirects',
    'converttitles', 'prop', 'page', 'format', 'formatversion', 'origin']);
  for (const request of calls) {
    const url = new URL(request.url);
    assert.equal(request.method, 'GET');
    assert.equal(request.body, '');
    assert.equal(url.searchParams.get('origin'), '*');
    for (const key of url.searchParams.keys()) assert.ok(allowed.has(key), `unexpected outbound parameter ${key}`);
    const decoded = decodeURIComponent(url.search);
    for (const privateText of [marker, '知库验收 B 20260920', '2008-07-18', '2026-09-20', '涩谷']) {
      assert.ok(!decoded.includes(privateText), `private context appeared in an API request: ${privateText}`);
    }
  }
  return calls.map(request => ({ endpoint: new URL(request.url).pathname, parameters: Object.fromEntries(new URL(request.url).searchParams) }));
}

async function readCachedOffline(title) {
  await nav('知库');
  const before = requests.length;
  await page.getByRole('button', { name: `阅读缓存：${title}`, exact: true }).click();
  await ready();
  await frame().locator('body').waitFor();
  assert.ok((await frame().locator('body').innerText()).length > 300);
  assert.match(await page.locator('.reader').innerText(), /缓存/);
  assert.equal(apiRequests(requests.slice(before)).length, 0, 'cache reader must not attempt an API request');
  for (const request of requests.slice(before).filter(item => /^https?:/.test(item.url))) {
    const url = new URL(request.url);
    assert.ok(host && url.origin === new URL(base).origin && url.pathname === '/api/settings/save',
      `unexpected HTTP during offline cached reading: ${request.url}`);
    backgroundRequests.push({ path: url.pathname, source: 'SillyTavern settings save during dedicated test, separate from article API' });
  }
}

try {
  await page.goto(base);
  await page.getByRole('button', { name: '打开掌上知库', exact: true }).waitFor({ timeout: 35_000 });
  if (host) await enterHost();
  baseline = errors.length;
  await page.getByRole('button', { name: '打开掌上知库', exact: true }).click();
  await ready();
  assert.ok(await page.getByRole('searchbox', { name: '搜索中文维基百科' }).isVisible());
  const beforeSearch = apiRequests(requests).length;
  assert.equal(beforeSearch, 0, 'opening the phone must not upload context or automatically search');
  await search('斗地主');
  assert.equal(await page.locator('.result-card h3').first().innerText(), '鬥地主');
  assert.match(await page.locator('.result-card').first().innerText(), /精确/);
  assert.ok(await page.locator('.result-card').count() <= 12);
  done('fresh installation searches official sources without installing or selecting a library');

  await open('鬥地主');
  const body = await frame().locator('body').innerText();
  assert.match(body, /農民|农民/);
  assert.match(body, /底牌|叫牌/);
  assert.ok(body.length > 2000, 'reader must contain original article, not a short summary');
  assert.ok(await frame().locator('table').count() > 0);
  assert.equal(await page.locator('.archive-reader iframe').getAttribute('sandbox'), 'allow-same-origin');
  assert.equal(await frame().locator('script,form,object,embed,iframe').count(), 0);
  assert.ok(!(await page.locator('.archive-reader iframe').getAttribute('sandbox')).includes('allow-scripts'));
  await page.getByRole('button', { name: '收藏这一页', exact: true }).click();
  await ready();
  done('original rule definitions, tables and a script-free reader remain intact and can be bookmarked');

  const source = page.locator('.source-note a[href*="oldid="]').first();
  const sourceUrl = await source.getAttribute('href');
  assert.equal(new URL(sourceUrl).origin, 'https://zh.wikipedia.org');
  assert.ok(Number(new URL(sourceUrl).searchParams.get('oldid')) > 0);
  assert.equal(await source.getAttribute('target'), '_blank');
  const popupPromise = page.waitForEvent('popup');
  await source.click();
  const popup = await popupPromise;
  await popup.waitForURL(url => url.origin === 'https://zh.wikipedia.org' && url.searchParams.has('oldid'));
  await popup.close();
  done('source attribution opens the exact Wikimedia revision in a separate page');

  const cardsLink = frame().getByRole('link', { name: /^(?:撲克牌|扑克牌)$/ }).first();
  assert.ok(await cardsLink.count(), 'source must contain a real semantic link to playing cards');
  await cardsLink.click();
  await ready();
  await page.locator('[data-reader-title]').filter({ hasText: /撲克牌|扑克牌/ }).waitFor();
  await frame().locator('body').waitFor();
  assert.match(await frame().locator('body').innerText(), /花色/);
  done('clicking a real source term opens the related original article inside the phone');

  for (const query of ['光合作用', '相对论']) {
    await search(query);
    assert.equal(await page.locator('.result-card h3').first().innerText(), query);
    await open(query);
    assert.ok((await frame().locator('body').innerText()).length > 1000);
  }
  done('card-game, biology and physics terms each reach substantive original articles');
  await page.screenshot({ path: path.join(evidence, host ? 'host-original.png' : 'preview-original.png') });

  await nav('收藏');
  assert.equal(await page.getByRole('button', { name: '阅读：鬥地主', exact: true }).count(), 1);
  await page.setViewportSize({ width: 390, height: 844 });
  const phone = await page.locator('.phone').boundingBox();
  assert.ok(phone && phone.x >= -1 && phone.width <= 392);
  await page.screenshot({ path: path.join(evidence, host ? 'host-mobile.png' : 'preview-mobile.png') });
  done('bookmark remains available and the 390px phone layout stays inside the viewport');

  await context.setOffline(true);
  await readCachedOffline('鬥地主');
  done('library cache opens the previously read original while offline without an HTTP request');
  await search('斗地主');
  assert.match(await page.locator('.notice').innerText(), /联网查询失败/);
  assert.match(await page.locator('.notice').innerText(), /缓存.*不是实时|不是实时.*缓存/);
  assert.equal(await page.locator('.result-card h3').first().innerText(), '鬥地主');
  assert.match(await page.locator('.result-card').first().innerText(), /已读缓存/);
  await open('鬥地主');
  assert.match(await frame().locator('body').innerText(), /農民|农民/);
  done('offline online-search failure is disclosed and returned cached material is not labelled live');
  await context.setOffline(false);

  if (!host) {
    await page.reload();
    await page.getByRole('button', { name: '打开掌上知库', exact: true }).click();
    await ready();
    await context.setOffline(true);
    await readCachedOffline('鬥地主');
    await context.setOffline(false);
    done('read article cache survives a page reload and remains independently readable offline');
  }
  const api = validateApiPrivacy();
  assert.equal(blocked.length, 0);
  assert.deepEqual(host ? errors.slice(baseline) : errors, []);
  done('only bounded official query/article parameters leave the phone; no chat context or model calls');
  const receipt = { capturedAt: new Date().toISOString(), status: 'passed', base, proxy: proxy ?? 'browser default',
    checks, timings, officialApiRequests: api, baselineErrors: host ? errors.slice(0, baseline) : [],
    newErrors: host ? errors.slice(baseline) : errors, modelCalls: blocked.length, backgroundRequests,
    limitations: ['One Wikimedia source; not general web search', 'Modern reference, not historical revision verification',
      'Mobile viewport emulation, not a physical mobile device', 'Offline coverage is limited to previously read cached articles'] };
  await writeFile(path.join(evidence, host ? 'host-acceptance.json' : 'preview-acceptance.json'), JSON.stringify(receipt, null, 2));
  console.log(`PASS ${checks.length} online-source UI checks`);
} catch (error) {
  await page.screenshot({ path: path.join(evidence, host ? 'host-failure.png' : 'preview-failure.png') }).catch(() => {});
  await writeFile(path.join(evidence, host ? 'host-failure.json' : 'preview-failure.json'), JSON.stringify({ capturedAt: new Date().toISOString(),
    base, error: String(error), checks, timings, baselineErrors: errors.slice(0, baseline), newErrors: errors.slice(baseline), modelCalls: blocked.length }, null, 2));
  console.error('UI state:', (await page.locator('.phone').innerText().catch(() => '')).slice(-5000));
  throw error;
} finally { await browser.close(); }
