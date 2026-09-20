import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

// Controlled fault injection validates recovery. It does not reproduce the user's unknown root cause.
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.KNOWLEDGE_PHONE_PLAYWRIGHT || 'playwright');
const file = path.resolve(process.argv[2] || 'evidence/zim/wikibooks_zh_all_nopic_2026-07.zim');
const base = process.env.KNOWLEDGE_PHONE_PREVIEW || 'http://127.0.0.1:4182';
const evidence = path.resolve('evidence/zim');
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({ headless: true, ...(process.env.KNOWLEDGE_PHONE_CHROME ? { executablePath: process.env.KNOWLEDGE_PHONE_CHROME } : {}) });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
page.setDefaultTimeout(15_000);
const started = Date.now(), checks = [], errors = [], modelCalls = [];
const deadline = setTimeout(() => { void browser.close(); }, 55_000);
page.on('pageerror', error => errors.push(String(error)));
await page.route('**/api/**', route => {
  if (/\/generate(?:\/|$)|\/generate-stream/.test(new URL(route.request().url()).pathname)) {
    modelCalls.push(route.request().url());
    return route.abort();
  }
  return route.continue();
});

await context.addInitScript(() => {
  const NativeWorker = window.Worker;
  const nativeAttachShadow = Element.prototype.attachShadow;
  const nativeTimeout = window.setTimeout.bind(window);
  const trace = window.__zimTimeoutFaults = {
    injected: true, shortenedDeadlineMs: 2500, droppedInit: 0, droppedFulltext: 0,
    fileSelections: 0, calls: [], shortenedTimers: [],
  };
  let firstFile;
  const countSelection = event => {
    if (event.target instanceof HTMLInputElement && event.target.type === 'file' && event.target.files?.length) trace.fileSelections++;
  };
  document.addEventListener('change', countSelection, true);
  // Native change events stay within a shadow root; observe the real picker at that boundary.
  Element.prototype.attachShadow = function (options) {
    const root = nativeAttachShadow.call(this, options);
    root.addEventListener('change', countSelection, true);
    return root;
  };
  window.setTimeout = (callback, delay, ...args) => {
    if (delay === 90_000 || delay === 120_000) {
      trace.shortenedTimers.push(delay);
      return nativeTimeout(callback, trace.shortenedDeadlineMs, ...args);
    }
    return nativeTimeout(callback, delay, ...args);
  };
  window.Worker = class extends NativeWorker {
    constructor(url, options) { super(url, options); this.isZim = String(url).includes('/vendor/libzim/bridge.js'); }
    postMessage(message, ...args) {
      if (this.isZim) {
        const row = { action: message.action, text: message.text, path: message.path };
        if (message.action === 'init') {
          firstFile ??= message.files[0];
          row.fileName = message.files[0].name;
          row.fileSize = message.files[0].size;
          row.sameSelectedFile = message.files[0] === firstFile;
        }
        trace.calls.push(row);
        if (message.action === 'init' && trace.droppedInit === 0) { trace.droppedInit++; return; }
        if (message.action === 'st-search' && trace.droppedFulltext === 0) { trace.droppedFulltext++; return; }
      }
      return super.postMessage(message, ...args);
    }
  };
});

const done = name => { checks.push(name); console.log(`PASS ${name}`); };
const ready = () => page.locator('.content[aria-busy="false"]').waitFor();
const nav = async name => {
  await page.getByRole('navigation', { name: '终端导航' }).getByRole('button', { name, exact: true }).click();
  await ready();
};
const submit = async query => {
  await page.getByRole('searchbox').fill(query);
  await page.getByRole('button', { name: '开始搜索', exact: true }).click();
  await ready();
};
let initializationNotice = '', searchNotice = '';
try {
  await page.goto(base);
  await page.getByRole('button', { name: '打开掌上知库', exact: true }).click();
  await ready();
  await page.getByRole('button', { name: '离线资料', exact: true }).click();
  await ready();
  await nav('知库');
  await page.getByLabel('选择本地 ZIM 知识库').setInputFiles(file);
  await ready();
  initializationNotice = await page.locator('.notice').innerText();
  assert.match(initializationNotice, /引擎初始化超时/);
  assert.match(initializationNotice, /已保留|无需重新下载/);
  await page.getByRole('button', { name: '重试连接刚才的文件', exact: true }).waitFor();
  await page.screenshot({ path: path.join(evidence, 'timeout-initialization.png') });
  done('injected initialization timeout identifies its stage and exposes retry with the retained file');

  await page.getByRole('button', { name: '重试连接刚才的文件', exact: true }).click();
  await ready();
  await page.getByText('已连接 · 本地文件', { exact: true }).waitFor();
  assert.match(await page.getByText('已连接 · 本地文件', { exact: true }).locator('..').innerText(), /8,302 篇文章/);
  done('retry opens the real 98,984,637-byte archive without another file selection');

  await nav('设置');
  await page.locator('select[name="mode"]').selectOption('custom');
  await page.locator('input[name="customDate"]').fill('2026-09-20');
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await ready();
  await nav('搜索');
  await submit('斗地主');
  searchNotice = await page.locator('.notice').innerText();
  assert.match(searchNotice, /全文搜索超时/);
  assert.match(searchNotice, /已保留|无需重新下载/);
  assert.equal(await page.locator('.result-card').count(), 0);
  await page.screenshot({ path: path.join(evidence, 'timeout-fulltext.png') });
  done('injected full-text timeout reports failure while retaining file access');

  // Stay in the search view: another navigation would intentionally repeat the existing query.
  await submit('扑克');
  assert.equal(await page.locator('.result-card h3').first().innerText(), '扑克');
  const afterTitle = await page.evaluate(() => window.__zimTimeoutFaults);
  assert.equal(afterTitle.calls.filter(row => row.action === 'st-search').length, 1, 'title hits must not start another full-text search');
  done('the next title search automatically restores the same file and returns without full-text work');

  await page.getByRole('button', { name: '阅读：扑克', exact: true }).click();
  await ready();
  const frame = page.frameLocator('.archive-reader iframe');
  await frame.getByRole('link', { name: '术语表', exact: true }).waitFor();
  await frame.getByRole('link', { name: '术语表', exact: true }).click();
  await ready();
  await frame.getByText('Ante（前注）', { exact: false }).first().waitFor();
  await page.screenshot({ path: path.join(evidence, 'timeout-recovered-reader.png') });
  done('original article and source glossary remain readable after recovery');

  const trace = await page.evaluate(() => window.__zimTimeoutFaults);
  assert.equal(trace.fileSelections, 1);
  assert.equal(trace.droppedInit, 1);
  assert.equal(trace.droppedFulltext, 1);
  assert.equal(trace.calls.filter(row => row.action === 'init').length, 3);
  assert.ok(trace.calls.filter(row => row.action === 'init').every(row => row.sameSelectedFile));
  assert.deepEqual(errors, []);
  assert.equal(modelCalls.length, 0);
  done('one file selection supports both recovery paths, with no model calls or browser errors');
  await writeFile(path.join(evidence, 'timeout-acceptance.json'), JSON.stringify({
    capturedAt: new Date().toISOString(), status: 'passed', base, elapsedMs: Date.now() - started,
    browser: browser.version(), checks, initializationNotice, searchNotice, trace, errors, modelCalls,
    limitations: ['Controlled message-drop and shortened-deadline fault injection; not evidence of the user incident root cause.',
      'Isolated Chrome profile and repository preview; the user in-app browser is a separate acceptance surface.'],
  }, null, 2));
  console.log(`PASS ${checks.length} browser timeout-recovery checks`);
} catch (error) {
  await page.screenshot({ path: path.join(evidence, 'timeout-failure.png') }).catch(() => {});
  await writeFile(path.join(evidence, 'timeout-failure.json'), JSON.stringify({ status: 'failed', base,
    elapsedMs: Date.now() - started, message: String(error), checks, errors,
    ui: await page.locator('.phone').innerText().catch(() => ''),
    trace: await page.evaluate(() => window.__zimTimeoutFaults).catch(() => null),
  }, null, 2));
  throw error;
} finally {
  clearTimeout(deadline);
  await browser.close();
}
