import test from 'node:test';
import assert from 'node:assert/strict';
import { OnlineProvider, ONLINE_PACK_ID, normalizeOnlinePath } from '../dist/providers/online.js';
import { OnlineCache, ONLINE_CACHE_KEY, ONLINE_CACHE_MAX_PAGES, ONLINE_CACHE_MAX_BYTES } from '../dist/library/online-cache.js';

const timestamp = '2026-09-20T10:00:00.000Z';
const context = { worldDate: '2026-09-20', location: ['private-location'], strictTimeline: false, chatKey: 'secret-chat' };
const request = query => ({ query, context });
const json = data => new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
const raw = '<h1>鬥地主</h1><p>地主是獲得底牌後對抗兩位農民的玩家。</p><table><tr><td>底牌</td><td>三張</td></tr></table><a href="/wiki/撲克牌">撲克牌</a>';
const parse = (title = '鬥地主', revid = 123, text = raw) => ({ parse: { title, pageid: 7, revid, text } });
function memory() {
  const values = new Map();
  return { values, async getValue(key) { return structuredClone(values.get(key)); }, async setValue(key, value) { values.set(key, structuredClone(value)); } };
}
function fixture(fetcher) {
  const calls = [], storage = memory();
  const provider = new OnlineProvider(storage, { now: () => Date.parse(timestamp), fetch: async (url, options) => {
    calls.push({ url: new URL(url), options });
    return fetcher(new URL(url), options);
  } });
  return { provider, storage, calls };
}

test('source redirect makes simplified query rank the original traditional title first, without uploading context', async () => {
  const { provider, storage, calls } = fixture(url => url.searchParams.get('list') === 'search'
    ? json({ query: { search: [
      { title: 'QQ游戏', pageid: 8, snippet: '平台收錄鬥地主。', timestamp },
      { title: '鬥地主', pageid: 7, snippet: '<span class="searchmatch">鬥地主</span>是撲克牌遊戲。', timestamp },
    ] } }) : json({ query: { pages: [{ title: '鬥地主', pageid: 7, ns: 0, lastrevid: 123 }] } }));
  const result = await provider.search(request('斗地主怎么玩？'));
  assert.equal(result.results[0].entry.title, '鬥地主');
  assert.equal(result.results[0].entry.summary, '鬥地主 是撲克牌遊戲。');
  assert.match(result.results[0].reason, /精确/);
  assert.equal(result.results[0].packId, ONLINE_PACK_ID);
  assert.equal(result.results[0].entry.source.kind, 'online');
  assert.deepEqual(result.results[0].entry.dates, {});
  assert.deepEqual(result.results[0].entry.aliases, ['斗地主']);
  assert.equal(storage.values.size, 0, 'search snippets are not saved as article content');
  for (const { url, options } of calls) {
    assert.equal(url.origin, 'https://zh.wikipedia.org');
    assert.equal(url.searchParams.get('origin'), '*');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.referrerPolicy, 'no-referrer');
    assert.doesNotMatch(url.href, /private-location|secret-chat|2026-09-20/);
    assert.equal(options.body, undefined);
  }
});

test('strict historical context and unsupported filters never send a network request', async () => {
  const { provider, calls } = fixture(() => { throw new Error('must not send'); });
  const historical = await provider.search({ query: '斗地主', context: { ...context, worldDate: '2008-07-18', strictTimeline: true } });
  assert.equal(historical.total, 0);
  assert.match(historical.notice, /未经历史版本核验/);
  assert.equal((await provider.search({ ...request('斗地主'), types: ['game_rule'] })).total, 0);
  assert.equal(calls.length, 0);
});

test('read caches full untouched original markup with revision and source, and offline read is labelled', async () => {
  let connected = true;
  const { provider, storage, calls } = fixture(() => { if (!connected) throw new TypeError('Failed to fetch'); return json(parse()); });
  const online = await provider.read('斗地主');
  assert.equal(online.content, raw);
  assert.equal(online.cached, false);
  assert.equal(online.result.entry.metadata.revision, 123);
  assert.equal(online.result.entry.metadata.fetchedAt, timestamp);
  assert.equal(online.result.entry.source.updatedAt, '', 'fetch time is not claimed as source modification time');
  assert.match(online.result.entry.source.url, /oldid=123/);
  assert.match(online.result.entry.metadata.licenseUrl, /by-sa\/4.0/);
  assert.equal(calls[0].url.searchParams.get('prop'), 'text|displaytitle|revid|links|tocdata');
  const saved = storage.values.get(ONLINE_CACHE_KEY);
  assert.equal(saved.pages.length, 1);
  assert.equal(saved.pages[0].content, raw);
  connected = false;
  const cached = await provider.read('斗地主');
  assert.equal(cached.cached, true);
  assert.equal(cached.content, raw);
  assert.equal(cached.result.entry.source.kind, 'cache');
  assert.match(cached.notice, /不是实时/);
  const search = await provider.search(request('底牌'));
  assert.equal(search.results.length, 1);
  assert.equal(search.results[0].entry.source.kind, 'cache');
  assert.match(search.notice, /联网查询失败.*缓存/);
  const noCache = await provider.search(request('从未读过的内容'));
  assert.equal(noCache.total, 0);
  assert.match(noCache.notice, /联网查询失败.*没有匹配/);
});

test('a failed or malformed read is never cached as an article', async () => {
  const { provider, storage } = fixture(() => json({ error: { code: 'missingtitle', info: '不存在的页面' } }));
  await assert.rejects(provider.read('不存在'), /不存在的页面/);
  assert.equal(storage.values.size, 0);
  const invalid = fixture(() => json({ parse: { title: '页面', revid: 5, text: '' } }));
  await assert.rejects(invalid.provider.read('页面'), /完整词条正文/);
  assert.equal(invalid.storage.values.size, 0);
});

test('source redirect aliases survive reading and remain searchable offline', async () => {
  const { provider } = fixture(url => url.searchParams.get('action') === 'parse' ? json(parse())
    : url.searchParams.get('list') ? json({ query: { search: [{ title: '鬥地主', pageid: 7, timestamp }] } })
      : json({ query: { pages: [{ title: '鬥地主', pageid: 7, lastrevid: 123 }] } }));
  const response = await provider.search(request('斗地主'));
  const read = await provider.read(response.results[0]);
  assert.equal(read.result.entry.source.updatedAt, timestamp, 'matching source revision preserves its modification time');
  response.results[0].entry.metadata.revision = 122;
  const changed = await provider.read(response.results[0]);
  assert.equal(changed.result.entry.source.updatedAt, '', 'a different parsed revision must not inherit an earlier search timestamp');
  response.results[0].entry.metadata.revision = 0;
  const unknown = await provider.read(response.results[0]);
  assert.equal(unknown.result.entry.source.updatedAt, '', 'an unknown search revision does not establish modification time');
  assert.equal((await provider.cache.search('斗地主'))[0].entry.title, '鬥地主');
});

test('malformed search responses cannot masquerade as a successful empty result', async () => {
  const { provider } = fixture(() => json({ unexpected: true }));
  const response = await provider.search(request('太阳'));
  assert.equal(response.total, 0);
  assert.match(response.notice, /联网查询失败.*有效搜索结果/);
});

test('cache read is available after creating a fresh provider and does not send a request', async () => {
  const { provider, storage } = fixture(() => json(parse()));
  await provider.read('鬥地主');
  const fresh = new OnlineProvider(storage, { fetch: async () => { throw new Error('network should not be used'); } });
  const [result] = await fresh.cache.search('鬥地主');
  const read = await fresh.read(result);
  assert.equal(read.cached, true);
  assert.equal(read.content, raw);
});

test('cache caps pages, evicts oldest reads and refuses oversized originals', async () => {
  const storage = memory(), cache = new OnlineCache(storage);
  const { provider } = fixture(() => json(parse()));
  const initial = await provider.read('鬥地主');
  const base = { schemaVersion: 1, aliases: [], result: initial.result, content: raw, fetchedAt: timestamp,
    url: initial.result.entry.source.url, revision: 123, source: 'wikipedia-zh' };
  await Promise.all(Array.from({ length: 23 }, (_, i) => cache.put({ ...base, path: `页${i}` })));
  assert.equal((await cache.list()).length, ONLINE_CACHE_MAX_PAGES);
  assert.equal(await cache.get('页0'), undefined);
  assert.ok(await cache.get('页22'));
  assert.equal(await cache.put({ ...base, path: '过大', content: 'x'.repeat(ONLINE_CACHE_MAX_BYTES + 1) }), false);
  assert.equal(await cache.get('过大'), undefined);
  assert.ok(new TextEncoder().encode(JSON.stringify(storage.values.get(ONLINE_CACHE_KEY))).length <= ONLINE_CACHE_MAX_BYTES);
});

test('external, credential-bearing and executable links cannot change the provider endpoint', () => {
  assert.equal(normalizeOnlinePath('/wiki/%E9%AC%A5%E5%9C%B0%E4%B8%BB#规则'), '鬥地主');
  assert.equal(normalizeOnlinePath('./撲克牌#花色'), '撲克牌');
  assert.equal(normalizeOnlinePath('https://zh.wikipedia.org/w/index.php?title=扑克&oldid=123'), '扑克');
  for (const path of ['https://evil.example/wiki/word', 'https://user:pass@zh.wikipedia.org/wiki/word', 'javascript:alert(1)', 'data:text/html,test', '甲|乙']) {
    assert.throws(() => normalizeOnlinePath(path), /词条|不属于/);
  }
});

test('cancellation rejects pending work instead of showing a stale network failure or cache', async () => {
  const { provider, storage } = fixture((_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  }));
  const pending = provider.search(request('太阳'));
  provider.cancelSearch();
  await assert.rejects(pending, error => error.name === 'AbortError');
  assert.equal(storage.values.size, 0);
});

test('timeouts are bounded and explicitly different from a successful empty query', async () => {
  const provider = new OnlineProvider(memory(), { timeoutMs: 10, fetch: (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  }) });
  const result = await provider.search(request('太阳'));
  assert.equal(result.total, 0);
  assert.match(result.notice, /联网查询失败.*连接超时/);
});

test('rate-limited source is not retried again during its requested backoff', async () => {
  const { provider, calls } = fixture(() => new Response('', { status: 429, headers: { 'Retry-After': '120' } }));
  const result = await provider.search(request('太阳'));
  assert.match(result.notice, /联网查询失败/);
  const count = calls.length;
  await provider.search(request('月亮'));
  assert.equal(calls.length, count);
});
