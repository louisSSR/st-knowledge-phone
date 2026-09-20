import test from 'node:test';
import assert from 'node:assert/strict';
import { Controller } from '../dist/controller.js';
import { PhoneStorage } from '../dist/library/storage.js';
import { ZimProvider } from '../dist/providers/zim.js';
import { ZimTimeoutError } from '../dist/zim/engine.js';
import { LocalLibraryProvider } from '../dist/providers/local.js';
import { OnlineProvider, ONLINE_PACK_ID } from '../dist/providers/online.js';
import { chatStorageKey, defaultChat } from '../dist/settings/settings.js';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function fixture(t, initial = { chatKey: 'A', messages: ['世界时间：2020-01-01\n地点：东京'], label: 'A' }) {
  const values = new Map();
  values.set('settings', { schemaVersion: 1, theme: 'midnight', sourceMode: 'offline' });
  const delays = new Map();
  const searchRequests = [];
  const listeners = new Set();
  let actual = initial;
  let totalSubscriptions = 0;
  const host = {
    label: 'Controller fixture', snapshot: () => actual,
    subscribe(callback) { listeners.add(callback); totalSubscriptions++; return () => listeners.delete(callback); },
    dispose() { listeners.clear(); },
  };
  // Stub dependencies, not Controller internals. No IndexedDB, Worker or host request is made.
  t.mock.method(PhoneStorage.prototype, 'getValue', async key => {
    const value = structuredClone(values.get(key));
    const delay = delays.get(key);
    if (delay) { delay.entered.resolve(); await delay.release.promise; }
    return value;
  });
  t.mock.method(PhoneStorage.prototype, 'listPacks', async () => []);
  t.mock.method(PhoneStorage.prototype, 'setValue', async (key, value) => { values.set(key, structuredClone(value)); });
  t.mock.method(PhoneStorage.prototype, 'dispose', () => {});
  t.mock.method(LocalLibraryProvider.prototype, 'isAvailable', async () => true);
  t.mock.method(LocalLibraryProvider.prototype, 'search', async request => {
    searchRequests.push(structuredClone(request));
    return { results: [], total: 0, suggestions: [`source:${request.context.chatKey}`] };
  });
  t.mock.method(LocalLibraryProvider.prototype, 'pause', () => {});
  t.mock.method(LocalLibraryProvider.prototype, 'dispose', () => {});
  const controller = new Controller(host);
  t.after(() => { controller.dispose(); t.mock.restoreAll(); });
  return {
    controller, values, searchRequests,
    actualKey: () => actual.chatKey,
    subscriptionCount: () => totalSubscriptions,
    activeSubscriptions: () => listeners.size,
    emit(kind, snapshot) { actual = snapshot; for (const callback of [...listeners]) callback(kind, snapshot); },
    delayRead(key) {
      const delay = { entered: deferred(), release: deferred() };
      delays.set(key, delay);
      return { entered: delay.entered.promise, release() { delays.delete(key); delay.release.resolve(); } };
    },
  };
}

function waitForState(controller, predicate) {
  if (predicate(controller.getState())) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { stop(); reject(new Error('Controller did not reach the expected state')); }, 1500);
    const stop = controller.subscribe(state => {
      if (!predicate(state)) return;
      clearTimeout(timeout); stop(); resolve();
    });
  });
}

test('A → delayed B → C never emits B content or ready state after C is selected', { concurrency: false, timeout: 3000 }, async t => {
  const env = fixture(t);
  const { controller } = env;
  const frames = [];
  controller.subscribe(state => frames.push({ actual: env.actualKey(), key: state.chatKey, ready: state.ready,
    suggestions: [...state.suggestions], date: state.context.worldDate }));
  await controller.start();
  await controller.navigate('library');
  const blockedB = env.delayRead(chatStorageKey('B'));
  env.emit('chat', { chatKey: 'B', messages: ['世界时间：2021-01-01'], label: 'B' });
  await blockedB.entered;
  env.emit('chat', { chatKey: 'C', messages: ['世界时间：2022-01-01'], label: 'C' });
  assert.equal(controller.getState().chatKey, 'C');
  assert.equal(controller.getState().ready, false);
  blockedB.release();
  await waitForState(controller, state => state.chatKey === 'C' && state.ready && state.suggestions.includes('source:C'));
  const afterC = frames.filter(frame => frame.actual === 'C');
  assert.ok(afterC.length > 0);
  assert.ok(afterC.every(frame => frame.key === 'C'), 'a stale chat identity was emitted after selection changed');
  assert.ok(afterC.every(frame => !frame.suggestions.includes('source:B')), 'B results leaked into C');
  assert.ok(afterC.every(frame => !frame.ready || frame.date === '2022-01-01'));
  assert.equal(env.searchRequests.some(request => request.context.chatKey === 'B'), false);
});

test('closing and reopening during a pending chat load preserves one host subscription', { concurrency: false, timeout: 3000 }, async t => {
  const env = fixture(t);
  const { controller } = env;
  const storedB = { ...defaultChat(), mode: 'custom', customDate: '1999-12-31' };
  env.values.set(chatStorageKey('B'), storedB);
  await controller.start();
  assert.equal(env.subscriptionCount(), 1);
  const blockedB = env.delayRead(chatStorageKey('B'));
  env.emit('chat', { chatKey: 'B', messages: ['世界时间：2021-01-01'], label: 'B' });
  await blockedB.entered;
  controller.pause();
  // start legitimately waits for the pending load: release it before awaiting reopen.
  const reopening = Promise.all([controller.start(), controller.start()]);
  assert.equal(env.subscriptionCount(), 1);
  assert.equal(env.activeSubscriptions(), 1);
  assert.equal(controller.getState().ready, false);
  blockedB.release();
  await reopening;
  await waitForState(controller, state => state.chatKey === 'B' && state.ready);
  assert.equal(controller.getState().context.worldDate, '1999-12-31');
  assert.equal(controller.getState().chat.mode, 'custom');
  assert.equal(env.values.get(chatStorageKey('B')).customDate, '1999-12-31');
  assert.equal(env.subscriptionCount(), 1);
  controller.dispose();
  assert.equal(env.activeSubscriptions(), 0);
});

test('reconcile removes deleted date and location instead of retaining stale story context', { concurrency: false, timeout: 3000 }, async t => {
  const env = fixture(t);
  const { controller } = env;
  await controller.start();
  assert.equal(controller.getState().context.worldDate, '2020-01-01');
  assert.deepEqual(controller.getState().context.location, ['东京']);
  env.emit('reconcile', { chatKey: 'A', messages: ['删改后没有日期和地点标注。'], label: 'A' });
  await waitForState(controller, state => state.context.worldDate === null && state.context.location.length === 0);
  assert.equal(controller.getState().chat.context.worldDate, undefined);
  assert.deepEqual(controller.getState().chat.context.location, []);
  const saved = env.values.get(chatStorageKey('A'));
  assert.equal(saved.context.worldDate, undefined);
  assert.deepEqual(saved.context.location, []);
});

test('the first startup realigns with a chat switch made before the host subscription exists', { concurrency: false, timeout: 3000 }, async t => {
  const env = fixture(t);
  const { controller } = env;
  const blockedA = env.delayRead(chatStorageKey('A'));
  const starting = controller.start();
  await blockedA.entered;
  assert.equal(env.activeSubscriptions(), 0);
  // This event is intentionally missed: the second snapshot must recover it.
  env.emit('chat', { chatKey: 'B', messages: ['世界时间：2021-01-01\n地点：大阪'], label: 'B' });
  blockedA.release();
  await starting;
  assert.equal(controller.getState().ready, true);
  assert.equal(controller.getState().chatKey, 'B');
  assert.equal(controller.getState().context.worldDate, '2021-01-01');
  assert.deepEqual(controller.getState().context.location, ['大阪']);
  assert.equal(env.subscriptionCount(), 1);
  assert.equal(env.activeSubscriptions(), 1);
});

test('reopening then leaving a pending chat cannot overwrite its saved custom settings with defaults', { concurrency: false, timeout: 3000 }, async t => {
  const env = fixture(t);
  const { controller } = env;
  const storedB = { ...defaultChat(), mode: 'custom', customDate: '1999-12-31', location: '京都' };
  env.values.set(chatStorageKey('B'), structuredClone(storedB));
  await controller.start();
  const blockedB = env.delayRead(chatStorageKey('B'));
  env.emit('chat', { chatKey: 'B', messages: ['世界时间：2021-01-01'], label: 'B' });
  await blockedB.entered;
  controller.pause();
  const reopening = controller.start();
  // Allow resume to reach its first await while B still owns the delayed read.
  await Promise.resolve();
  assert.deepEqual(env.values.get(chatStorageKey('B')), storedB);
  env.emit('chat', { chatKey: 'C', messages: ['世界时间：2022-01-01'], label: 'C' });
  blockedB.release();
  await reopening;
  await waitForState(controller, state => state.chatKey === 'C' && state.ready);
  assert.deepEqual(env.values.get(chatStorageKey('B')), storedB);
  assert.equal(env.subscriptionCount(), 1);
  assert.equal(controller.getState().context.worldDate, '2022-01-01');
});

test('an initial archive timeout retains the selected File for retry without another picker', async t => {
  const { controller } = fixture(t);
  await controller.start();
  const file = { name: 'fixture_2026-07.zim', size: 100 };
  const selected = [];
  t.mock.method(ZimProvider.prototype, 'attach', async candidate => {
    selected.push(candidate);
    if (selected.length === 1) throw new ZimTimeoutError('init', 120_000);
    return { id: 'zim:retry', name: file.name, fileName: file.name, size: 100, articleCount: 2, date: '2026-07-31', connected: true };
  });
  await controller.attachArchive(file);
  assert.equal(controller.getState().canRetryArchive, true);
  assert.match(controller.getState().notice, /超时/);
  await controller.retryArchive();
  assert.deepEqual(selected, [file, file]);
  assert.equal(controller.getState().canRetryArchive, false);
  assert.equal(controller.getState().archives[0].id, 'zim:retry');
});

const onlineResult = () => ({ packId: ONLINE_PACK_ID, packName: '中文维基百科', score: 1000, entry: {
  id: '鬥地主', title: '鬥地主', aliases: ['斗地主'], type: 'article', summary: '来源摘要', contentRef: '鬥地主',
  tags: [], location: [], dates: {}, source: { name: '中文维基百科', url: 'https://zh.wikipedia.org/w/index.php?oldid=123',
    updatedAt: '', license: 'CC BY-SA 4.0', kind: 'online' }, metadata: { fetchedAt: '2026-09-20T00:00:00Z', revision: 123 },
} });

test('fresh and pre-v0.3 settings default online; startup never queries and manual search strips all chat context', async t => {
  const { controller, values } = fixture(t);
  values.set('settings', { schemaVersion: 1, theme: 'midnight' });
  const requests = [];
  t.mock.method(OnlineProvider.prototype, 'search', async request => {
    requests.push(structuredClone(request)); return { results: [onlineResult()], total: 1, suggestions: [] };
  });
  await controller.start();
  assert.equal(controller.getState().settings.sourceMode, 'online');
  assert.equal(requests.length, 0);
  await controller.search('斗地主');
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].context, { worldDate: null, location: [], strictTimeline: false, chatKey: '' });
  assert.equal(requests[0].query, '斗地主');
  assert.equal(controller.getState().results[0].entry.title, '鬥地主');
});

test('switching to offline discards a delayed online result and persists the selected source', async t => {
  const { controller, values } = fixture(t);
  const delay = deferred();
  t.mock.method(OnlineProvider.prototype, 'search', async () => { await delay.promise; return { results: [onlineResult()], total: 1, suggestions: [] }; });
  await controller.start(); await controller.setSourceMode('online');
  const search = controller.search('斗地主');
  await controller.setSourceMode('offline');
  delay.resolve(); await search;
  assert.equal(values.get('settings').sourceMode, 'offline');
  assert.deepEqual(controller.getState().results, []);
  assert.equal(controller.getState().busy, false);
});

test('cache-only reading opens original HTML under historical context without network, and reports evicted entries', async t => {
  const { controller, values } = fixture(t);
  let onlineReads = 0;
  t.mock.method(OnlineProvider.prototype, 'read', async () => { onlineReads++; throw new Error('Unexpected network path'); });
  const result = onlineResult();
  values.set('webcache:wikipedia-zh:v1', { schemaVersion: 1, pages: [{ schemaVersion: 1, path: '鬥地主', aliases: ['斗地主'], result,
    content: '<h2>术语</h2><p>来源原文</p>', fetchedAt: '2026-09-20T00:00:00Z', url: result.entry.source.url, revision: 123, source: 'wikipedia-zh' }] });
  await controller.start(); await controller.readCached(result);
  assert.equal(onlineReads, 0);
  assert.equal(controller.getState().reader.result.entry.source.kind, 'cache');
  assert.match(controller.getState().notice, /不是实时/);
  assert.match(controller.getState().reader.content, /<h2>术语/);
  controller.closeReader(); values.delete('webcache:wikipedia-zh:v1');
  await controller.readCached(result);
  assert.equal(controller.getState().reader, null);
  assert.match(controller.getState().notice, /已被清理/);
  assert.equal(onlineReads, 0);
});

test('online bookmarks remain per chat and no historical source date is fabricated', async t => {
  const env = fixture(t), { controller } = env;
  await controller.start(); await controller.toggleBookmark(onlineResult()); await controller.navigate('bookmarks');
  assert.equal(controller.getState().results.length, 1);
  assert.deepEqual(controller.getState().results[0].entry.dates, {});
  env.emit('chat', { chatKey: 'B', messages: ['世界时间：1999-01-01'], label: 'B' });
  await waitForState(controller, state => state.chatKey === 'B' && state.ready);
  assert.equal(controller.getState().bookmarks.length, 0);
  assert.equal(controller.getState().results.length, 0);
});

test('migrated disconnected ZIM records never ask online or cache users to reconnect', async t => {
  const { controller, values } = fixture(t);
  values.set('settings', { schemaVersion: 1, theme: 'midnight' });
  values.set('archives', [{ id: 'zim:old', name: '旧知识库', fileName: 'old.zim', size: 100, articleCount: 2, connected: false }]);
  await controller.start(); await controller.navigate('library');
  assert.equal(controller.getState().settings.sourceMode, 'online');
  assert.equal(controller.getState().notice, '');
  await controller.setSourceMode('offline'); await controller.navigate('library');
  assert.match(controller.getState().notice, /重新选择同一/);
});
