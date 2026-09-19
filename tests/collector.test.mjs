import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, realpath, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { validateConfig, normalizeExtract, splitText, validateSnapshot, buildCollection, collect, requestJSON, sha256 } from '../scripts/collect-wikipedia.mjs';
import { parsePack } from '../dist/library/pack.js';

const retrievedAt = '2025-01-20T12:00:00.000Z';
const revisionAt = '2019-06-15T12:00:00Z';
const generatedAt = '2025-01-21T12:00:00.000Z';
const prose = '这是用于离线测试的完整资料正文，包含中文、英文 encyclopedia 和数字 123。'.repeat(12);
const configFor = (...articles) => ({ schemaVersion: 1, id: 'collector-fixture', name: '离线采集测试', articles });
const spec = (title, extras = {}) => ({ title, type: 'article', ...extras });
function snapshot(title = '测试条目', pageOverrides = {}, responseOverrides = {}) {
  const response = { query: { pages: [{ pageid: 42, ns: 0, title, revisions: [{ revid: 1234, timestamp: revisionAt }], extract: prose, ...pageOverrides }] }, ...responseOverrides };
  return { schemaVersion: 1, requestedTitle: title, retrievedAt, response, responseSha256: sha256(JSON.stringify(response)) };
}
const build = (config, snapshots, options = {}) => buildCollection(config, snapshots, { generatedAt, ...options });
const allEntries = collection => collection.packs.flatMap(({ pack }) => pack.entries);
const jsonResponse = (data, options) => new Response(JSON.stringify(data), options);

test('collector requires a bounded explicit article list and valid source fields', () => {
  assert.equal(validateConfig(configFor(spec('围棋'))).articles.length, 1);
  assert.throws(() => validateConfig(configFor()), /1–100/);
  assert.throws(() => validateConfig(configFor(...Array.from({ length: 101 }, () => spec('围棋')))), /1–100/);
  for (const article of [spec(''), spec('A|B'), spec('A\0B'), spec('围棋', { type: 'store' }), spec('围棋', { aliases: [''] })]) {
    assert.throws(() => validateConfig(configFor(article)));
  }
});

test('collector rejects disambiguation even when the API flag is an empty string', () => {
  for (const disambiguation of ['', true]) {
    assert.throws(() => validateSnapshot(snapshot('歧义', { pageprops: { disambiguation } }), '歧义'), /消歧义/);
  }
  assert.equal(validateSnapshot(snapshot('正文', { pageprops: {} }), '正文').page.pageid, 42);
});

test('collector rejects missing pages, non-article namespaces, API warnings and section redirects', () => {
  for (const page of [{ missing: '' }, { invalid: '' }, { known: '' }, { ns: 1 }, { pageid: -1 }]) {
    assert.throws(() => validateSnapshot(snapshot('测试条目', page), '测试条目'), /不存在|百科正文/);
  }
  for (const apiProblem of [{ error: { code: 'maxlag' } }, { warnings: { extracts: { warnings: 'truncated' } } }]) {
    assert.throws(() => validateSnapshot(snapshot('测试条目', {}, apiProblem), '测试条目'), /API 错误\/警告/);
  }
  const redirected = snapshot();
  redirected.response.query.redirects = [{ from: '测试条目', to: '正文', tofragment: '' }];
  redirected.responseSha256 = sha256(JSON.stringify(redirected.response));
  assert.throws(() => validateSnapshot(redirected, '测试条目'), /章节重定向/);
});

test('collector verifies cache identity, raw response hash and plausible retrieval/revision times', () => {
  assert.throws(() => validateSnapshot(snapshot(), '不同标题'), /标题或采集时间/);
  const tampered = snapshot();
  tampered.response.query.pages[0].extract += '未经记录的更改';
  assert.throws(() => validateSnapshot(tampered, '测试条目'), /原始响应校验/);
  assert.throws(() => validateSnapshot({ ...snapshot(), retrievedAt: new Date(Date.now() + 86_400_000).toISOString() }, '测试条目'), /采集时间/);
  assert.throws(() => validateSnapshot(snapshot('测试条目', { revisions: [{ revid: 1234, timestamp: '2025-01-22T12:00:00Z' }] }), '测试条目'), /版本时间/);
});

test('collector rejects empty, short, NUL-containing and oversized extracts', () => {
  for (const extract of ['', ' \r\n\t '.repeat(200), '短'.repeat(199), null, `${prose}\0`, '长'.repeat(250_001)]) {
    assert.throws(() => validateSnapshot(snapshot('测试条目', { extract }), '测试条目'), /摘录/);
  }
  assert.equal(validateSnapshot(snapshot('边界', { extract: '字'.repeat(200) }), '边界').normalized.length, 200);
});

test('normalization and chunking preserve all normalized paragraph and emoji characters', () => {
  const normalized = normalizeExtract(`  第一段\t\t内容\r\n\r\n\r\n ${'甲'.repeat(98)}😀${'乙'.repeat(140)}\r\n\r\n${'末尾段落 🌏 '.repeat(30)}\u00a0 `);
  assert.ok(!normalized.includes('\r'));
  assert.ok(!normalized.includes('\n\n\n'));
  for (const limit of [100, 101, 137, 6000]) {
    const chunks = splitText(normalized, limit);
    assert.equal(chunks.join(''), normalized);
    assert.ok(chunks.every(chunk => chunk.length > 0 && chunk.length <= limit));
    assert.ok(chunks.every(chunk => !/[\uD800-\uDBFF]$/.test(chunk) && !/^[\uDC00-\uDFFF]/.test(chunk)));
  }
  assert.throws(() => splitText(normalized, 99), /字符上限/);
});

test('summary truncation preserves an emoji straddling the UTF-16 boundary', () => {
  const extract = '字'.repeat(239) + '😀' + '后文'.repeat(150);
  const collection = build(configFor(spec('摘要边界')), [snapshot('摘要边界', { extract })]);
  const entry = allEntries(collection)[0];
  assert.equal(entry.summary, '字'.repeat(239) + '😀');
  assert.equal(Array.from(entry.summary).length, 240);
  assert.equal(entry.summary.isWellFormed(), true);
  assert.ok(collection.packs[0].pack.content[entry.contentRef].startsWith(extract));
});

test('unrendered formula remnants are quarantined rather than published as readable prose', () => {
  for (const formula of ['{\\displaystyle x}', '\\frac {a}{b}', '\\ce {CO2 + H2O}']) {
    const bad = snapshot('公式损坏', { extract: prose + formula });
    assert.throws(() => validateSnapshot(bad, '公式损坏'), /公式残渣/);
    const collection = build(configFor(spec('公式损坏')), [bad]);
    assert.equal(collection.report.status, 'failed');
    assert.deepEqual(collection.packs, []);
  }
});

test('same-page redirects merge requested titles, aliases and tags without duplicating text', () => {
  const config = configFor(spec('原请求', { aliases: ['旧别名'], tags: ['桌游'] }), spec('重定向名', { aliases: ['新别名'], tags: ['游戏'] }));
  const collection = build(config, [snapshot('原请求', { title: '规范标题' }), snapshot('重定向名', { title: '规范标题' })]);
  assert.equal(collection.report.status, 'passed');
  assert.equal(collection.report.articles.length, 1);
  assert.deepEqual(collection.report.duplicates, [{ requestedTitle: '重定向名', pageId: 42, reason: 'same-page' }]);
  assert.deepEqual(new Set(allEntries(collection)[0].aliases), new Set(['规范标题', '原请求', '重定向名', '旧别名', '新别名']));
  assert.ok(['桌游', '游戏'].every(tag => allEntries(collection)[0].tags.includes(tag)));
});

test('different page IDs with identical normalized text fail the entire batch', () => {
  const collection = build(configFor(spec('甲'), spec('乙')), [snapshot('甲'), snapshot('乙', { pageid: 43, extract: ` \n${prose}\r\n ` })]);
  assert.equal(collection.report.status, 'failed');
  assert.match(collection.report.failures[0].reason, /完全相同/);
  assert.deepEqual(collection.packs, []);
});

test('same page with conflicting content or type fails closed', () => {
  for (const [secondSpec, secondSnapshot] of [
    [spec('乙'), snapshot('乙', { extract: prose + '新修订内容' })],
    [spec('乙', { type: 'game_rule' }), snapshot('乙')],
  ]) {
    const collection = build(configFor(spec('甲'), secondSpec), [snapshot('甲'), secondSnapshot]);
    assert.equal(collection.report.status, 'failed');
    assert.deepEqual(collection.packs, []);
    assert.match(collection.report.failures[0].reason, /内容或类型不一致/);
  }
});

test('one failed article never produces a partial collection', () => {
  const collection = build(configFor(spec('有效'), spec('无效'), spec('下载失败')), [snapshot('有效'), snapshot('无效', { missing: '' }), { failure: 'HTTP 503' }]);
  assert.equal(collection.report.status, 'failed');
  assert.equal(collection.report.failures.length, 2);
  assert.deepEqual(collection.packs, []);
  assert.deepEqual(collection.report.packs, []);
});

test('entries use the observation date, retain attribution and reconstruct the original normalized text', () => {
  const source = snapshot('资料', { extract: `${'段落😀内容'.repeat(50)}\n\n${'第二段文字'.repeat(50)}` });
  const collection = build(configFor(spec('资料')), [source], { chunkCharacters: 100 });
  const entries = allEntries(collection);
  assert.ok(entries.length > 1);
  let reconstructed = '';
  for (const { pack } of collection.packs) {
    assert.deepEqual(parsePack(pack), pack);
    for (const entry of pack.entries) {
      assert.deepEqual(entry.dates, { knownFrom: '2025-01-20' });
      assert.equal(entry.source.updatedAt, '2025-01-20');
      assert.equal(entry.metadata.observedRevisionAt, revisionAt);
      assert.equal(entry.metadata.retrievedAt, retrievedAt);
      const body = pack.content[entry.contentRef];
      reconstructed += body.slice(0, entry.metadata.contentCharacters);
      assert.match(body.slice(entry.metadata.contentCharacters), /作者历史：https:\/\/zh\.wikipedia\.org\/w\/index\.php/);
      assert.match(body, /CC BY-SA 4\.0/);
    }
  }
  assert.equal(reconstructed, normalizeExtract(source.response.query.pages[0].extract));
  assert.equal(collection.report.articles[0].normalizedSha256, sha256(reconstructed));
});

test('entry-count partitioning preserves order and exact pack checksums', () => {
  const collection = build(configFor(spec('长文')), [snapshot('长文', { extract: '跨包正文'.repeat(160) })], { chunkCharacters: 100, maxPackEntries: 2 });
  assert.ok(collection.packs.length > 2);
  assert.ok(collection.packs.every(({ pack }) => pack.entries.length <= 2));
  assert.deepEqual(allEntries(collection).map(entry => entry.metadata.part), Array.from({ length: allEntries(collection).length }, (_, index) => index + 1));
  collection.packs.forEach(({ pack, file }, index) => {
    const bytes = `${JSON.stringify(pack)}\n`;
    assert.equal(file, `collector-fixture-${String(index + 1).padStart(3, '0')}.pack.json`);
    assert.equal(collection.report.packs[index].bytes, Buffer.byteLength(bytes));
    assert.equal(collection.report.packs[index].sha256, sha256(bytes));
  });
});

test('byte partitioning measures UTF-8 serialized packs rather than character count', () => {
  const config = configFor(spec('中文资料'));
  const sources = [snapshot('中文资料', { extract: '中文资料😀'.repeat(130) })];
  const oneEntryPacks = build(config, sources, { chunkCharacters: 100, maxPackEntries: 1 });
  const byteLimit = Math.max(...oneEntryPacks.report.packs.map(pack => pack.bytes));
  const collection = build(config, sources, { chunkCharacters: 100, maxPackEntries: 200, maxPackBytes: byteLimit });
  assert.ok(collection.packs.length > 1);
  assert.ok(collection.report.packs.every(pack => pack.bytes <= byteLimit));
  assert.equal(allEntries(collection).length, allEntries(oneEntryPacks).length);
  assert.throws(() => build(config, sources, { chunkCharacters: 100, maxPackBytes: 1000 }), /单段.*字节限额/);
});

test('HTTP 200 maxlag is retried with server delay before accepting a response', async () => {
  const waits = [];
  const calls = [];
  const responses = [jsonResponse({ error: { code: 'maxlag' } }, { headers: { 'Retry-After': '9' } }), jsonResponse({ query: { ok: true } })];
  const data = await requestJSON({ titles: '测试条目' }, {
    sleep: async ms => { waits.push(ms); },
    fetchImpl: async (url, options) => { calls.push({ url: String(url), options }); return responses.shift(); },
  });
  assert.deepEqual(data, { query: { ok: true } });
  assert.deepEqual(waits, [1100, 9000, 1100]);
  assert.equal(calls.length, 2);
  assert.equal(new URL(calls[0].url).searchParams.get('maxlag'), '5');
  assert.equal(calls[0].options.redirect, 'error');
  assert.match(calls[0].options.headers['User-Agent'], /KnowledgePhoneCollector/);
});

test('HTTP 429 obeys numeric Retry-After and stops instead of retrying early for long delays', async () => {
  const waits = [];
  let calls = 0;
  await requestJSON({}, {
    sleep: async ms => { waits.push(ms); },
    fetchImpl: async () => ++calls === 1 ? new Response('busy', { status: 429, headers: { 'Retry-After': '17' } }) : jsonResponse({ ok: true }),
  });
  assert.deepEqual(waits, [1100, 17000, 1100]);
  let longCalls = 0;
  await assert.rejects(requestJSON({}, {
    sleep: async () => {},
    fetchImpl: async () => { longCalls++; return new Response('busy', { status: 429, headers: { 'Retry-After': '120' } }); },
  }), /长时间等待/);
  assert.equal(longCalls, 1);
});

test('HTTP-date Retry-After is respected with a bounded retry count', async () => {
  const waits = [];
  let calls = 0;
  const start = Date.now();
  const retryAt = new Date(start + 35_000).toUTCString();
  await requestJSON({}, {
    sleep: async ms => { waits.push(ms); },
    fetchImpl: async () => ++calls === 1 ? new Response('busy', { status: 429, headers: { 'Retry-After': retryAt } }) : jsonResponse({ ok: true }),
  });
  assert.ok(waits[1] >= 30_000 && waits[1] <= 35_000, `retry delay: ${waits[1]}`);
  calls = 0;
  await assert.rejects(requestJSON({}, {
    sleep: async () => {},
    fetchImpl: async () => { calls++; return jsonResponse({ error: { code: 'maxlag' } }); },
  }), /maxlag/);
  assert.equal(calls, 3);
});

test('long or exhausted rate limits stop the entire collection before requesting another article', async t => {
  const temporaryRoot = await realpath(tmpdir());
  const scenarios = [
    { name: 'long-retry', attempts: 1, response: () => new Response('busy', { status: 429, headers: { 'Retry-After': '120' } }) },
    { name: 'exhausted-429', attempts: 3, response: () => new Response('busy', { status: 429, headers: { 'Retry-After': '17' } }) },
    { name: 'exhausted-maxlag', attempts: 3, response: () => jsonResponse({ error: { code: 'maxlag' } }) },
  ];
  for (const scenario of scenarios) {
    let fetchCalls = 0;
    let stoppedError;
    await assert.rejects(requestJSON({}, {
      sleep: async () => {},
      fetchImpl: async () => { fetchCalls++; return scenario.response(); },
    }), error => {
      assert.equal(error.stopBatch, true, scenario.name);
      stoppedError = error;
      return true;
    });
    assert.equal(fetchCalls, scenario.attempts, scenario.name);

    const directory = await mkdtemp(join(temporaryRoot, 'knowledge-collector-'));
    t.after(async () => {
      const resolvedDirectory = await realpath(directory);
      assert.equal(dirname(resolvedDirectory), temporaryRoot, 'cleanup must remain under the resolved temporary directory');
      assert.ok(basename(resolvedDirectory).startsWith('knowledge-collector-'), 'cleanup must target this test fixture');
      await rm(resolvedDirectory, { recursive: true, force: true });
    });
    const outDir = join(directory, 'output');
    const calls = [];
    await assert.rejects(collect(configFor(spec('第一篇'), spec('第二篇'), spec('第三篇')), {
      outDir,
      cacheDir: join(directory, 'cache'),
      request: async params => {
        calls.push(params);
        if (params.meta === 'siteinfo') return { query: { rightsinfo: { url: 'https://creativecommons.org/licenses/by-sa/4.0/', text: 'CC BY-SA 4.0' } } };
        throw stoppedError;
      },
    }), /3 条失败，未发布任何资料包/);
    assert.equal(calls.length, 2, `${scenario.name}: only license metadata and the first article may be requested`);
    assert.equal(calls[1].titles, '第一篇');
    const report = JSON.parse(await readFile(join(outDir, 'report.json'), 'utf8'));
    assert.equal(report.status, 'failed');
    assert.equal(report.failures.length, 3);
    assert.deepEqual(report.packs, []);
    assert.deepEqual(report.failures.map(failure => failure.title), ['第一篇', '第二篇', '第三篇']);
    assert.ok(report.failures.slice(1).every(failure => failure.reason.includes('整批已停止，未请求')));
    assert.deepEqual(await readdir(outDir), ['report.json'], 'a stopped batch must leave no installable pack files');
  }
});

test('HTTP requests fail closed on non-transient API errors and warnings', async () => {
  for (const data of [{ error: { code: 'badvalue' } }, { warnings: { main: { '*': 'unsafe parameter' } } }]) {
    let calls = 0;
    await assert.rejects(requestJSON({}, {
      sleep: async () => {},
      fetchImpl: async () => { calls++; return jsonResponse(data); },
    }), /badvalue|警告/);
    assert.equal(calls, 1);
  }
});

test('response byte ceiling is enforced for advertised and streamed response sizes', async () => {
  for (const responseFactory of [
    () => jsonResponse({ ok: true }, { headers: { 'Content-Length': String(2 * 1024 * 1024 + 1) } }),
    () => jsonResponse({ text: '界'.repeat(710_000) }),
  ]) {
    let calls = 0;
    await assert.rejects(requestJSON({}, {
      sleep: async () => {},
      fetchImpl: async () => { calls++; return responseFactory(); },
    }), /2 MiB/);
    assert.ok(calls <= 3);
  }
});
