import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parsePack, buildDocument, isDate, MAX_PACK_BYTES } from '../dist/library/pack.js';
import { PhoneStorage } from '../dist/library/storage.js';
import { isVisible } from '../dist/search/filters.js';
import { searchCorpus } from '../dist/search/rank.js';
import { parseQuery } from '../dist/search/query.js';
import { SearchService } from '../dist/search/service.js';
import { LocalLibraryProvider } from '../dist/providers/local.js';
import { buildPack } from '../scripts/knowledge-builder.mjs';

const rawPack = JSON.parse(await readFile(new URL('../packs/original-demo.pack.json', import.meta.url), 'utf8'));
const pack = parsePack(rawPack);
const context = { worldDate: '2008-07-18', location: ['日本', '东京', '涩谷'], strictTimeline: true, chatKey: 'test-chat' };
const corpus = [{ packId: pack.manifest.id, packName: pack.manifest.name, entries: pack.entries, documents: pack.index.documents }];
const search = (query, options = {}) => searchCorpus(corpus, { query, context, ...options });
const find = id => pack.entries.find(entry => entry.id === id);

test('original pack has six rule types and a reproducible complete prebuilt index', async () => {
  assert.equal(pack.entries.filter(entry => entry.type === 'game_rule').length, 6);
  assert.equal(pack.manifest.entryCount, 17);
  for (const entry of pack.entries) assert.equal(pack.index.documents[entry.id], buildDocument(entry, pack.content[entry.contentRef]));
  const source = JSON.parse(await readFile(new URL('../packs/sources/original-demo.source.json', import.meta.url), 'utf8'));
  assert.deepEqual(buildPack(source), pack);
});

test('natural card-game questions show six playable choices with comparison metadata', () => {
  const expectedIds = ['poker-blackjack', 'poker-doudizhu', 'poker-old-maid', 'poker-solitaire', 'poker-texas', 'poker-upgrade'];
  for (const query of ['扑克牌怎么玩', '扑克牌有什么玩法', '请问扑克牌有哪些玩法？']) {
    const request = { query, context };
    const reply = searchCorpus(corpus, request);
    assert.equal(request.query, query, 'the original question remains unchanged for history');
    assert.equal(reply.total, 6);
    assert.deepEqual(reply.results.map(result => result.entry.id).sort(), expectedIds);
    assert.equal(reply.suggestions.length, 6);
    for (const { entry } of reply.results) {
      assert.equal(entry.type, 'game_rule');
      assert.match(entry.metadata.players, /人/);
      assert.ok(entry.metadata.difficulty);
      assert.match(entry.metadata.duration, /分钟/);
    }
  }
  assert.equal(search('扑克牌怎么玩', { types: ['store'] }).total, 0);
  assert.equal(search('斗地主怎么玩').results[0].entry.id, 'poker-doudizhu');
  assert.equal(search('德州扑克有什么玩法').total, 1);
  assert.equal(parseQuery('扑克牌 斗地主').ruleOverview, false);
});

test('autumn clothing shortcut finds period-visible data without future fixture text leakage', () => {
  const autumn = search('秋装');
  assert.equal(autumn.total, 3);
  assert.equal(autumn.results.some(result => result.entry.id === 'shibuya-cotton-jacket'), true);
  assert.equal(search('2025').total, 0);
  assert.deepEqual(search('2025').suggestions, []);
  assert.equal(search('2012').total, 0);
  const future = search('2025', { context: { ...context, worldDate: '2025-02-01' } });
  assert.equal(future.total, 1);
  assert.equal(future.results[0].entry.id, 'future-phone-2025');
  assert.deepEqual(future.suggestions, ['星盒 Pocket 2025 · 未来演示']);
});

test('2008 hard filters remove future titles from results and autocomplete', () => {
  const reply = search('Pocket');
  assert.deepEqual(reply.results.map(result => result.entry.id), ['pocket-2008']);
  assert.deepEqual(reply.suggestions, ['Pocket 纸面终端 · 2008 演示']);
  assert.equal(search('纸月').total, 0);
  assert.equal(search('纸月').suggestions.length, 0);
  const future = search('Pocket', { context: { ...context, worldDate: '2025-02-01' } });
  assert.equal(future.total, 2);
});

test('occurredAt is independent of when knowledge is public', () => {
  assert.equal(isVisible(find('late-publication'), context), false);
  assert.equal(isVisible(find('announced-future-match'), context), true);
  assert.equal(search('友谊赛').results[0].entry.id, 'announced-future-match');
});

test('each explicit date bound is enforced inclusively; missing knownFrom is hidden', () => {
  const base = find('pocket-2008');
  const visible = dates => isVisible({ ...base, dates }, context);
  assert.equal(visible({ publishedAt: '2007-01-01' }), false);
  assert.equal(visible({ knownFrom: '2008-07-18' }), true);
  assert.equal(visible({ knownFrom: '2008-07-19' }), false);
  assert.equal(visible({ knownFrom: '2008-01-01', publishedAt: '2008-07-19' }), false);
  assert.equal(visible({ knownFrom: '2008-01-01', validFrom: '2008-07-19' }), false);
  assert.equal(visible({ knownFrom: '2008-01-01', validUntil: '2008-07-17' }), false);
  assert.equal(visible({ knownFrom: '2008-01-01', validFrom: '2008-07-18', validUntil: '2008-07-18' }), true);
  assert.equal(visible({ knownFrom: '2008-01-01', occurredAt: '2025-01-01' }), true);
});

test('strict unknown world dates reveal only undated records; explicit opt-out removes time gates', () => {
  const unknown = { ...context, worldDate: null };
  assert.equal(isVisible(find('pocket-2008'), unknown), false);
  assert.equal(isVisible(find('poker-texas'), unknown), true);
  assert.equal(isVisible(find('pocket-2008'), { ...unknown, worldDate: '2008-99-42' }), false);
  assert.equal(isVisible(find('future-phone-2025'), { ...unknown, strictTimeline: false }), true);
  assert.equal(isVisible(find('unknown-knowledge-time'), context), false);
});

test('place paths are prefix-compatible; branches differ; unlocated entries remain general', () => {
  assert.equal(isVisible(find('shibuya-demo-map'), { ...context, location: ['日本', '东京'] }), true);
  assert.equal(isVisible(find('tokyo-demo-guide'), context), true);
  assert.equal(isVisible(find('osaka-demo-shop'), context), false);
  assert.equal(isVisible(find('osaka-demo-shop'), { ...context, location: [] }), true);
  assert.equal(isVisible(find('poker-texas'), { ...context, location: ['火星'] }), true);
  assert.equal(search('纸舟').suggestions.length, 0);
});

test('type filtering also constrains suggestions and full-text body matches work', () => {
  assert.equal(search('涩谷', { types: ['game_rule'] }).total, 0);
  assert.equal(search('涩谷', { types: ['game_rule'] }).suggestions.length, 0);
  assert.equal(search('边池').results[0].entry.id, 'poker-texas');
  assert.equal(search('棉布 深蓝').results.some(result => result.entry.id === 'shibuya-cotton-jacket'), true);
  assert.equal(search('ＰｏｃＫｅｔ').results[0].entry.id, 'pocket-2008');
});

test('paging is capped at twelve with stable totals and no cross-page duplicates', () => {
  const modern = { ...context, location: [], strictTimeline: false };
  const first = search('', { context: modern, limit: 99 });
  const second = search('', { context: modern, offset: 12, limit: 99 });
  assert.equal(first.total, 17);
  assert.equal(first.results.length, 12);
  assert.equal(second.results.length, 5);
  assert.equal(new Set([...first.results, ...second.results].map(result => result.entry.id)).size, 17);
});

test('pack rejects inconsistent indexes, missing/orphan content, duplicate ids, schema and unsafe shapes', () => {
  const rejectMutation = mutate => { const changed = structuredClone(rawPack); mutate(changed); assert.throws(() => parsePack(changed)); };
  rejectMutation(value => { value.index.documents['poker-texas'] += ' extra'; });
  rejectMutation(value => { delete value.content['poker-texas']; });
  rejectMutation(value => { value.content.orphan = 'orphan'; });
  rejectMutation(value => { value.entries[1].id = value.entries[0].id; });
  rejectMutation(value => { value.entries[1].contentRef = value.entries[0].contentRef; });
  rejectMutation(value => { value.entries[0].source.url = 'javascript:alert(1)'; });
  rejectMutation(value => { value.schemaVersion = 2; });
  rejectMutation(value => { value.manifest.entryCount = 5001; });
  rejectMutation(value => { value.entries[0].source.updatedAt = '2025-02-30'; });
  rejectMutation(value => { value.entries[0].script = 'alert(1)'; });
  rejectMutation(value => { value.entries[0].metadata = JSON.parse('{"__proto__":"bad"}'); });
  rejectMutation(value => { value.entries[0].dates = { validFrom: '2020-01-01', validUntil: '2019-01-01' }; });
  assert.throws(() => parsePack({ ...rawPack, content: { oversized: 'x'.repeat(MAX_PACK_BYTES) } }), /10 MB/);
  assert.equal(isDate('2024-02-29'), true);
  assert.equal(isDate('2025-02-29'), false);
});

test('plain-text content is accepted without becoming executable code', () => {
  const changed = structuredClone(rawPack);
  const item = changed.entries[0];
  changed.content[item.contentRef] = '<script>alert("text only")</script>';
  changed.index.documents[item.id] = buildDocument(item, changed.content[item.contentRef]);
  assert.equal(parsePack(changed).content[item.contentRef], '<script>alert("text only")</script>');
});

test('SearchService passes the full context to registered providers and surfaces failures', async () => {
  let received;
  const request = { query: 'Pocket', context, types: ['product'], offset: 0, limit: 12 };
  const result = search('Pocket');
  const provider = { id: 'test', name: 'test', isAvailable: async () => true,
    search: async input => { received = input; return result; } };
  assert.deepEqual(await new SearchService([provider]).search(request), result);
  assert.equal(received, request);
  await assert.rejects(new SearchService([{ ...provider, search: async () => { throw new Error('index unavailable'); } }]).search(request), /index unavailable/);
  await assert.rejects(new SearchService([{ ...provider, isAvailable: async () => false }]).search(request), /不可用/);
});

test('storage constructor is lazy and dispose forbids future reads', async () => {
  const storage = new PhoneStorage();
  storage.dispose();
  await assert.rejects(storage.listPacks(), /已关闭/);
});

test('local Worker requests are isolated; pause terminates, rejects pending and permits restart', async () => {
  const originalWorker = globalThis.Worker;
  const originalIDB = globalThis.indexedDB;
  const workers = [];
  class FakeWorker {
    requests = [];
    terminated = false;
    constructor(url, options) { assert.match(url.href, /search\/worker\.js$/); assert.equal(options.type, 'module'); workers.push(this); }
    postMessage(message) { this.requests.push(message); }
    terminate() { this.terminated = true; }
    respond(id, response) { this.onmessage({ data: { id, kind: 'success', response } }); }
  }
  globalThis.Worker = FakeWorker;
  globalThis.indexedDB = {};
  const provider = new LocalLibraryProvider();
  try {
    assert.equal(workers.length, 0);
    assert.equal(await provider.isAvailable(), true);
    const first = provider.search({ query: 'one', context });
    const second = provider.search({ query: 'two', context });
    assert.equal(workers.length, 1);
    const worker = workers[0];
    const [one, two] = worker.requests;
    const secondReply = { results: [], total: 2, suggestions: ['two'] };
    const firstReply = { results: [], total: 1, suggestions: ['one'] };
    worker.respond(two.id, secondReply);
    worker.respond(one.id, firstReply);
    assert.deepEqual(await first, firstReply);
    assert.deepEqual(await second, secondReply);
    const pending = provider.search({ query: 'pause me', context });
    const rejected = assert.rejects(pending, /暂停/);
    provider.pause();
    await rejected;
    assert.equal(worker.terminated, true);
    const resumed = provider.search({ query: 'resume', context });
    assert.equal(workers.length, 2);
    workers[1].respond(workers[1].requests[0].id, firstReply);
    assert.deepEqual(await resumed, firstReply);
    const failed = provider.search({ query: 'fail', context });
    const failure = assert.rejects(failed, /Worker/);
    workers[1].onerror();
    await failure;
    assert.equal(workers[1].terminated, true);
    provider.dispose();
    assert.equal(await provider.isAvailable(), false);
    await assert.rejects(provider.search({ query: 'disposed', context }), /关闭/);
  } finally {
    provider.dispose();
    if (originalWorker === undefined) delete globalThis.Worker; else globalThis.Worker = originalWorker;
    if (originalIDB === undefined) delete globalThis.indexedDB; else globalThis.indexedDB = originalIDB;
  }
});
