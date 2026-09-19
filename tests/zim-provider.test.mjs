import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { ZimProvider, archiveDate, archiveVisible, termQuery } from '../dist/providers/zim.js';
import { ZimEngine } from '../dist/zim/engine.js';
import { isRetiredPack } from '../dist/library/source-policy.js';

const context = { worldDate: '2026-09-20', location: [], strictTimeline: true, chatKey: 'qa' };
const request = (query, extra = {}) => ({ query, context, ...extra });
const sample = (name = 'wikibooks_zh_all_nopic_2026-07.zim') => ({ name, size: 98_984_637 });
const hit = (title, path = title, snippet = '') => ({ title, path, snippet });
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

function fixture(t, { titles = () => [], fulltext = () => [], metadata = () => ({}), read } = {}) {
  const files = new WeakMap();
  const opened = new WeakSet();
  const engines = [];
  const calls = [];
  const closed = [];
  t.mock.method(ZimEngine.prototype, 'open', async function (file) {
    files.set(this, file);
    engines.push(this);
    const extra = await metadata(file);
    opened.add(this);
    return { uuid: file.name, articleCount: 8302, name: file.name, size: file.size, ...extra };
  });
  t.mock.method(ZimEngine.prototype, 'isOpen', function () { return opened.has(this); });
  t.mock.method(ZimEngine.prototype, 'suggest', async function (query, options) {
    calls.push({ kind: 'titles', file: files.get(this).name, query, options });
    return titles(query, files.get(this));
  });
  t.mock.method(ZimEngine.prototype, 'search', async function (query, options) {
    calls.push({ kind: 'fulltext', file: files.get(this).name, query, options });
    return fulltext(query, files.get(this));
  });
  t.mock.method(ZimEngine.prototype, 'read', async function (path) {
    calls.push({ kind: 'read', file: files.get(this).name, path });
    if (read) return read(path, files.get(this));
    return { mimeType: 'text/html', data: new TextEncoder().encode(`${files.get(this).name}:${path}`) };
  });
  t.mock.method(ZimEngine.prototype, 'close', function () { opened.delete(this); closed.push(files.get(this)?.name); });
  const provider = new ZimProvider();
  t.after(() => { provider.detach(); t.mock.restoreAll(); });
  return { provider, calls, closed, engines };
}

test('snapshot filenames use a valid conservative month end and do not invent missing dates', () => {
  assert.equal(archiveDate('wikibooks_zh_all_nopic_2026-07.zim'), '2026-07-31');
  assert.equal(archiveDate('wikipedia_zh_all_mini_2026-07b.zim'), '2026-07-31');
  assert.equal(archiveDate('example_2024-02.zim'), '2024-02-29');
  assert.equal(archiveDate('example_2025-02.zim'), '2025-02-28');
  for (const name of ['unknown.zim', 'example_2026-00.zim', 'example_2026-13.zim']) assert.equal(archiveDate(name), undefined);
});

test('strict timeline refuses unknown, invalid and future dates, including an invalid world date', () => {
  for (const date of [undefined, '', 'not-a-date', '2026-13-01', '2027-01-01']) {
    assert.equal(archiveVisible({ date }, context), false, String(date));
  }
  for (const worldDate of [null, '', 'not-a-date', '2026-13-01', '2008-07-18']) {
    assert.equal(archiveVisible({ date: '2026-07-31' }, { ...context, worldDate }), false, String(worldDate));
  }
  assert.equal(archiveVisible({ date: '2026-09-20' }, context), true);
  assert.equal(archiveVisible({}, { ...context, strictTimeline: false, worldDate: null }), true);
});

test('natural questions retain the actual term, including nested politeness and Chinese punctuation', () => {
  for (const [input, expected] of [
    ['斗地主怎么玩？', '斗地主'], ['斗地主的规则', '斗地主'], ['什么是名词？', '名词'],
    ['请问什么是名词？', '名词'], ['名词是什么意思？', '名词'], ['名词是什麼意思？', '名词'],
    ['  计算机组成原理  ', '计算机组成原理'], ['C++', 'C++'], ['', ''],
  ]) assert.equal(termQuery(input), expected, input);
});

test('exact original titles outrank prefix and body hits and duplicate paths are merged', async t => {
  const { provider } = fixture(t, {
    titles: () => [hit('名词解释', 'prefix'), hit('名词', 'exact')],
    fulltext: () => [hit('俄语语法', 'body', '名词用于表示事物。'), hit('名词', 'exact', '原文的名词解释。')],
  });
  const archive = await provider.attach(sample());
  const response = await provider.search(request('名词'));
  assert.equal(response.results[0].entry.title, '名词');
  assert.equal(response.results[0].entry.id, 'exact');
  assert.match(response.results[0].reason, /精确/);
  assert.equal(response.results.filter(row => row.entry.id === 'exact').length, 1);
  assert.equal(response.results[0].packId, archive.id);
  assert.equal(response.results.find(row => row.entry.id === 'body').entry.summary, '名词用于表示事物。');
  assert.ok(response.results.every(row => !row.entry.source.name.includes('原创')));
});

test('NFKC-equivalent title lookup preserves the original title without rewriting it', async t => {
  const { provider } = fixture(t, { titles: () => [hit('Ｐｏｃｋｅｔ', 'full-width'), hit('Pocket devices', 'prefix')] });
  await provider.attach(sample());
  const result = await provider.search(request('Pocket'));
  assert.equal(result.results[0].entry.title, 'Ｐｏｃｋｅｔ');
  assert.match(result.results[0].reason, /精确/);
});

test('Chinese fulltext character splitting cannot recommend medieval Europe for 斗地主', async t => {
  const { provider } = fixture(t, { fulltext: () => [
    hit('欧洲中世纪', 'bad', '各地的地主在斗争中取得土地。'),
    hit('纸牌游戏', 'relevant', '本章节介绍斗地主的叫牌与出牌。'),
    hit('欧洲概览', 'no-evidence'),
  ] });
  await provider.attach(sample());
  const result = await provider.search(request('斗地主'));
  assert.deepEqual(result.results.map(row => row.entry.id), ['relevant']);
  assert.equal(result.results[0].entry.summary, '本章节介绍斗地主的叫牌与出牌。');
});

test('a missing search snippet falls back to the actual bounded article body, not invented text', async t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'document');
  // A deterministic inert-template dependency. Real HTML parsing and network isolation are browser checks.
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    createElement(tag) {
      assert.equal(tag, 'template');
      const content = { textContent: '', querySelectorAll: () => [] };
      return { content, set innerHTML(text) { content.textContent = text; } };
    },
  } });
  t.after(() => { if (original) Object.defineProperty(globalThis, 'document', original); else delete globalThis.document; });
  const pages = {
    good: '纸牌游戏：斗地主有叫牌和出牌阶段。这里继续保留来源原文。',
    bad: '中世纪的地主在争斗中取得土地。',
  };
  const { provider } = fixture(t, {
    fulltext: () => [hit('纸牌游戏', 'good'), hit('欧洲中世纪', 'bad')],
    read: path => ({ mimeType: 'text/html', data: new TextEncoder().encode(pages[path]) }),
  });
  await provider.attach(sample());
  const result = await provider.search(request('斗地主'));
  assert.deepEqual(result.results.map(row => row.entry.id), ['good']);
  assert.equal(result.results[0].entry.summary, pages.good);
});

test('strict timeline blocks the engine before search and cannot reuse modern cached results', async t => {
  const { provider, calls } = fixture(t, { titles: () => [hit('名词')] });
  await provider.attach(sample());
  assert.equal((await provider.search(request('名词'))).total, 1);
  const before = calls.length;
  const historic = await provider.search(request('名词', { context: { ...context, worldDate: '2008-07-18' } }));
  assert.equal(historic.total, 0);
  assert.match(historic.notice, /时间|快照/);
  assert.equal(calls.length, before);
});

test('unknown snapshot dates require an explicit timeline opt-out', async t => {
  const { provider, calls } = fixture(t, { titles: () => [hit('名词')] });
  const archive = await provider.attach(sample('unknown.zim'));
  assert.equal(archive.date, undefined);
  assert.equal((await provider.search(request('名词'))).total, 0);
  assert.equal(calls.length, 0);
  assert.equal((await provider.search(request('名词', { context: { ...context, strictTimeline: false } }))).total, 1);
});

test('source categories are not invented to satisfy a game-rule filter', async t => {
  const { provider, calls } = fixture(t, { titles: () => [hit('斗地主')] });
  await provider.attach(sample());
  assert.equal((await provider.search(request('斗地主', { types: ['game_rule'] }))).total, 0);
  assert.equal(calls.length, 0);
  assert.equal((await provider.search(request('斗地主', { types: ['article'] }))).results[0].entry.type, 'article');
});

test('cache is discarded on archive replacement and old bookmarks cannot read the new archive', async t => {
  const { provider, calls, closed } = fixture(t, { titles: (_query, file) => [hit('名词', file.name)] });
  const first = await provider.attach(sample('first_2026-07.zim'));
  assert.equal((await provider.search(request('名词'))).results[0].entry.id, first.fileName);
  const second = await provider.attach(sample('second_2026-07.zim'));
  const result = await provider.search(request('名词'));
  assert.equal(result.results[0].entry.id, second.fileName);
  assert.equal(result.results[0].packId, second.id);
  assert.equal(calls.filter(call => call.kind === 'titles').length, 2);
  assert.ok(closed.includes(first.fileName));
  await assert.rejects(provider.read(first.id, '名词'), /尚未连接|重新选择/);
});

test('in-flight results from a replaced archive cannot populate the new cache', async t => {
  const pending = deferred();
  const { provider } = fixture(t, { titles: (_query, file) => file.name.startsWith('first') ? pending.promise : [hit('名词', 'new')] });
  await provider.attach(sample('first_2026-07.zim'));
  const stale = provider.search(request('名词'));
  const current = await provider.attach(sample('second_2026-07.zim'));
  pending.resolve([hit('名词', 'old')]);
  assert.equal((await stale).total, 0);
  const result = await provider.search(request('名词'));
  assert.deepEqual(result.results.map(row => row.entry.id), ['new']);
  assert.equal(result.results[0].packId, current.id);
});

test('cancelled search does not start stale article reads or cache an empty successful response', async t => {
  const pending = deferred();
  let first = true;
  const { provider, calls } = fixture(t, {
    fulltext: () => { if (first) { first = false; return pending.promise; } return [hit('斗地主', 'current')]; },
  });
  await provider.attach(sample());
  const stale = provider.search(request('斗地主'));
  provider.cancelSearch();
  pending.resolve([hit('欧洲中世纪', 'stale-needs-body-check')]);
  assert.equal((await stale).total, 0);
  assert.equal(calls.filter(call => call.kind === 'read').length, 0);
  const current = await provider.search(request('斗地主'));
  assert.deepEqual(current.results.map(row => row.entry.id), ['current']);
  assert.equal(calls.filter(call => call.kind === 'fulltext').length, 2);
});

test('cancelling during an article check stops the remaining candidates and discards the stale page', async t => {
  const entered = deferred(), pending = deferred();
  const { provider, calls } = fixture(t, {
    fulltext: () => [hit('牌戏甲', 'first-body'), hit('牌戏乙', 'second-body')],
    read: () => { entered.resolve(); return pending.promise; },
  });
  await provider.attach(sample());
  const stale = provider.search(request('斗地主'));
  await entered.promise;
  provider.cancelSearch();
  pending.resolve({ mimeType: 'text/html', data: new TextEncoder().encode('斗地主的规则原文。') });
  assert.equal((await stale).total, 0);
  assert.deepEqual(calls.filter(call => call.kind === 'read').map(call => call.path), ['first-body']);
});

test('an engine that closed after a runtime failure is not reported as a connected archive', async t => {
  const { provider, engines } = fixture(t);
  const archive = await provider.attach(sample());
  assert.equal(provider.connected(archive.id), true);
  engines[0].close();
  assert.equal(provider.connected(archive.id), false);
  await assert.rejects(provider.read(archive.id, '名词'), /尚未连接|重新选择/);
});

test('failed replacement leaves the existing archive usable', async t => {
  const { provider } = fixture(t, {
    metadata: file => { if (file.name.startsWith('broken')) throw new Error('corrupt archive'); return {}; },
    titles: () => [hit('名词')],
  });
  const initial = await provider.attach(sample());
  await assert.rejects(provider.attach(sample('broken_2026-07.zim')), /corrupt/);
  assert.equal(provider.connected(initial.id), true);
  assert.equal((await provider.search(request('名词'))).total, 1);
});

test('a slow old archive open cannot replace a newer archive or survive detach', async t => {
  const pending = deferred();
  const { provider } = fixture(t, { metadata: file => file.name.startsWith('slow') ? pending.promise : {} });
  const stale = provider.attach(sample('slow_2026-07.zim'));
  const rejection = assert.rejects(stale, /取消/);
  const current = await provider.attach(sample('current_2026-07.zim'));
  pending.resolve({});
  await rejection;
  assert.equal(provider.connected(current.id), true);
  provider.detach();
  assert.equal(provider.connected(current.id), false);
  assert.equal((await provider.search(request('名词'))).total, 0);
});

test('index failures are disclosed and two failed indexes do not look like an empty successful search', async t => {
  const { provider } = fixture(t, {
    titles: query => { if (query === '全部失败') throw new Error('title index failed'); return [hit('名词')]; },
    fulltext: () => { throw new Error('fulltext index failed'); },
  });
  await provider.attach(sample());
  const result = await provider.search(request('名词'));
  assert.equal(result.total, 1);
  assert.match(result.notice, /全文索引不可用/);
  await assert.rejects(provider.search(request('全部失败')), /index failed/);
});

test('retirement policy covers all ten previously shipped project packs without retiring user packs', async () => {
  const paths = [new URL('../packs/original-demo.pack.json', import.meta.url)];
  for (const folder of ['wikipedia-zh-starter', 'wikipedia-zh-general']) {
    const base = new URL(`../packs/${folder}/`, import.meta.url);
    for (const name of await readdir(base)) if (name.endsWith('.pack.json')) paths.push(new URL(name, base));
  }
  assert.equal(paths.length, 10);
  for (const path of paths) {
    const pack = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(isRetiredPack(pack.manifest.id), true, pack.manifest.id);
  }
  assert.equal(isRetiredPack('user-knowledge'), false);
  assert.equal(isRetiredPack('zim:external-source'), false);
});
