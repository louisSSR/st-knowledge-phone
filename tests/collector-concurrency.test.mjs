import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, realpath, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { collect, createRequestGate, requestJSON, sha256 } from '../scripts/collect-wikipedia.mjs';

const rights = { query: { rightsinfo: { url: 'https://creativecommons.org/licenses/by-sa/4.0/' } } };
const spec = title => ({ title, type: 'article' });
const configFor = (...titles) => ({ schemaVersion: 1, id: 'concurrency-fixture', name: '并发离线测试', articles: titles.map(spec) });
const turn = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
async function eventually(check, message) {
  for (let i = 0; i < 2000; i++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  assert.fail(message);
}
function article(title, extract = `${title}的完整测试资料，含足够的中文正文和可阅读段落。`.repeat(18)) {
  return { query: { pages: [{ pageid: 1 + [...title].reduce((sum, char) => sum + char.codePointAt(0), 0), ns: 0, title,
    revisions: [{ revid: 1234, timestamp: '2020-01-01T00:00:00Z' }], extract }] } };
}
async function workspace(t) {
  const temporaryRoot = await realpath(tmpdir());
  const directory = await mkdtemp(join(temporaryRoot, 'knowledge-phone-concurrency-'));
  t.after(async () => {
    const resolved = await realpath(directory);
    assert.equal(dirname(resolved), temporaryRoot, 'cleanup must remain directly inside the resolved temporary directory');
    assert.ok(basename(resolved).startsWith('knowledge-phone-concurrency-'));
    await rm(resolved, { recursive: true, force: true });
  });
  return { directory, cacheDir: join(directory, 'cache'), out: name => join(directory, name) };
}
const reportAt = async directory => JSON.parse(await readFile(join(directory, 'report.json'), 'utf8'));
function fakeClock() {
  let time = 0;
  const sleepers = [];
  return {
    now: () => time,
    sleepers,
    sleep(ms) {
      assert.ok(Number.isFinite(ms) && ms >= 0, `invalid simulated sleep ${ms}`);
      const wait = deferred();
      sleepers.push({ at: time + ms, resolve: wait.resolve });
      return wait.promise;
    },
    async advance(ms) {
      assert.ok(ms >= 0);
      time += ms;
      for (const waiter of [...sleepers]) {
        if (waiter.at <= time) {
          sleepers.splice(sleepers.indexOf(waiter), 1);
          waiter.resolve();
        }
      }
      await turn();
    },
  };
}

test('collect defaults to one active article and permits only integer concurrency 1–3', async t => {
  const space = await workspace(t);
  let active = 0, peak = 0;
  const report = await collect(configFor('第一篇', '第二篇', '第三篇'), {
    outDir: space.out('default'), cacheDir: space.cacheDir,
    request: async params => {
      if (params.meta) return rights;
      peak = Math.max(peak, ++active);
      await turn();
      active--;
      return article(params.titles);
    },
  });
  assert.equal(peak, 1);
  assert.equal(report.metrics.concurrency, 1);
  for (const concurrency of [0, 4, -1, 1.5, NaN, '3']) {
    await assert.rejects(collect(configFor('第一篇'), { concurrency }), /并发数必须为 1–3/);
  }
});

test('three workers overlap, stay bounded, and publish articles in configuration order', async t => {
  const space = await workspace(t);
  const titles = ['第一篇', '第二篇', '第三篇', '第四篇', '第五篇', '第六篇'];
  const active = new Map();
  const starts = [];
  let peak = 0;
  const running = collect(configFor(...titles), {
    outDir: space.out('parallel'), cacheDir: space.cacheDir, concurrency: 3,
    request: async params => {
      if (params.meta) return rights;
      const wait = deferred();
      starts.push(params.titles);
      active.set(params.titles, wait);
      peak = Math.max(peak, active.size);
      await wait.promise;
      active.delete(params.titles);
      return article(params.titles);
    },
  });
  await eventually(() => starts.length === 3, 'three initial articles should overlap');
  for (const title of ['第三篇', '第二篇', '第一篇']) {
    active.get(title).resolve();
    const expected = starts.length + 1;
    await eventually(() => starts.length >= expected, 'completion should free one worker');
  }
  for (const wait of active.values()) wait.resolve();
  const report = await running;
  assert.equal(peak, 3);
  assert.equal(starts.length, titles.length);
  assert.deepEqual(report.articles.map(item => item.title), titles);
  assert.equal(report.metrics.downloaded, titles.length);
});

test('parallel duplicate titles share one download and cache record; resume makes zero requests', async t => {
  const space = await workspace(t);
  const config = configFor('重复文章', '重复文章', '独立文章', '重复文章');
  config.articles[1].aliases = ['另一个名称'];
  const requested = [];
  const first = await collect(config, {
    outDir: space.out('first'), cacheDir: space.cacheDir, concurrency: 3,
    request: async params => {
      if (params.meta) return rights;
      requested.push(params.titles);
      await turn();
      return article(params.titles);
    },
  });
  assert.deepEqual(requested.sort(), ['独立文章', '重复文章'].sort());
  assert.equal(first.metrics.downloaded, 2);
  assert.equal(first.metrics.reusedTitles, 2);
  assert.equal(first.duplicates.length, 2);
  assert.deepEqual((await readdir(space.cacheDir)).sort(), ['siteinfo.json', `${sha256('重复文章')}.json`, `${sha256('独立文章')}.json`].sort());
  const before = await readFile(join(space.cacheDir, `${sha256('重复文章')}.json`), 'utf8');
  const second = await collect(config, {
    outDir: space.out('resume'), cacheDir: space.cacheDir, concurrency: 3,
    request: async () => assert.fail('a complete cache must not perform network requests'),
  });
  assert.equal(second.metrics.cacheHits, 2);
  assert.equal(second.metrics.downloaded, 0);
  assert.equal(second.metrics.requests, 0);
  assert.equal(await readFile(join(space.cacheDir, `${sha256('重复文章')}.json`), 'utf8'), before);
});

test('quality-rejected raw responses remain cached and resume without requests or packages', async t => {
  const space = await workspace(t);
  const config = configFor('正常文章', '公式文章');
  let requests = 0;
  await assert.rejects(collect(config, {
    outDir: space.out('first'), cacheDir: space.cacheDir, concurrency: 2,
    request: async params => {
      if (params.meta) return rights;
      requests++;
      return article(params.titles, `${params.titles}的完整正文。`.repeat(50) + (params.titles === '公式文章' ? '\\frac {a}{b}' : ''));
    },
  }), /1 条失败/);
  assert.equal(requests, 2);
  const rejected = JSON.parse(await readFile(join(space.cacheDir, `${sha256('公式文章')}.json`), 'utf8'));
  assert.ok(rejected.response.query.pages[0].extract.includes('\\frac'));
  assert.equal(rejected.responseSha256, sha256(JSON.stringify(rejected.response)));
  assert.ok((await readdir(space.out('first'))).every(file => !file.endsWith('.pack.json')));
  await assert.rejects(collect(config, {
    outDir: space.out('resume'), cacheDir: space.cacheDir, concurrency: 3,
    request: async () => assert.fail('rejected cached material must not be downloaded again implicitly'),
  }), /1 条失败/);
  const report = await reportAt(space.out('resume'));
  assert.equal(report.metrics.cacheHits, 2);
  assert.equal(report.metrics.downloaded, 0);
  assert.equal(report.failures[0].pending, undefined, 'quality rejection is distinct from a retryable missing response');
});

test('stopBatch retains in-flight successes but leaves unstarted titles pending', async t => {
  const space = await workspace(t);
  const titles = ['停止文章', '在途甲文', '在途乙文', '排队甲文', '排队乙文', '排队丙文'];
  const waits = new Map(titles.map(title => [title, deferred()]));
  const requested = [];
  const stopped = new Error('来源要求长时间等待');
  stopped.stopBatch = true;
  const running = collect(configFor(...titles), {
    outDir: space.out('stop'), cacheDir: space.cacheDir, concurrency: 3,
    request: async params => {
      if (params.meta) return rights;
      requested.push(params.titles);
      await waits.get(params.titles).promise;
      return article(params.titles);
    },
  });
  const failure = assert.rejects(running, /4 条失败/);
  await eventually(() => requested.length === 3, 'expected initial in-flight requests');
  waits.get('停止文章').reject(stopped);
  await turn();
  await turn();
  waits.get('在途甲文').resolve();
  waits.get('在途乙文').resolve();
  await failure;
  assert.deepEqual(requested.sort(), titles.slice(0, 3).sort());
  const report = await reportAt(space.out('stop'));
  assert.equal(report.stoppedReason, stopped.message);
  assert.deepEqual(report.failures.map(item => item.title), ['停止文章', ...titles.slice(3)]);
  assert.ok(report.failures.every(item => item.pending === true));
  const files = await readdir(space.cacheDir);
  assert.ok(files.includes(`${sha256('在途甲文')}.json`));
  assert.ok(files.includes(`${sha256('在途乙文')}.json`));
  assert.ok(!files.includes(`${sha256('停止文章')}.json`));
});

test('exhausted transport failures are pending and missing offline articles never fetch', async t => {
  const space = await workspace(t);
  let attempts = 0;
  await assert.rejects(collect(configFor('网络失败'), {
    outDir: space.out('network'), cacheDir: space.cacheDir,
    request: async params => params.meta ? rights : requestJSON(params, {
      sleep: async () => {},
      fetchImpl: async () => { attempts++; throw new TypeError('simulated connection reset'); },
    }),
  }), /1 条失败/);
  assert.equal(attempts, 3);
  const network = await reportAt(space.out('network'));
  assert.equal(network.failures[0].pending, true);
  assert.equal(network.stoppedReason, undefined);
  await assert.rejects(collect(configFor('缓存缺失'), {
    outDir: space.out('offline'), cacheDir: space.cacheDir, offline: true, concurrency: 3,
    request: async () => assert.fail('offline mode must not request missing articles'),
  }), /1 条失败/);
  const offline = await reportAt(space.out('offline'));
  assert.equal(offline.failures[0].pending, true);
  assert.match(offline.failures[0].reason, /离线模式缺少此条缓存/);
});

test('the shared gate spaces request starts while allowing unresolved requests to overlap', async () => {
  const clock = fakeClock();
  const gate = createRequestGate({ sleep: clock.sleep, now: clock.now });
  const starts = [];
  const waits = [deferred(), deferred(), deferred()];
  const requests = waits.map((wait, index) => gate.run(() => { starts.push({ index, time: clock.now() }); return wait.promise; }));
  await turn();
  assert.deepEqual(starts, [{ index: 0, time: 0 }]);
  await clock.advance(499);
  assert.equal(starts.length, 1);
  await clock.advance(1);
  assert.equal(starts.length, 2);
  await clock.advance(500);
  assert.deepEqual(starts.map(item => item.time), [0, 500, 1000]);
  waits.forEach((wait, index) => wait.resolve(index));
  assert.deepEqual(await Promise.all(requests), [0, 1, 2]);
});

test('a later shared cooldown is rechecked after an already-scheduled sleep wakes', async () => {
  const clock = fakeClock();
  const gate = createRequestGate({ sleep: clock.sleep, now: clock.now });
  const starts = [];
  await gate.run(() => { starts.push(clock.now()); return 'first'; });
  const second = gate.run(() => { starts.push(clock.now()); return 'second'; });
  await turn();
  await clock.advance(100);
  gate.defer(2000);
  await clock.advance(400);
  assert.equal(starts.length, 1, 'the original 500 ms wait must not bypass a new cooldown');
  await clock.advance(1599);
  assert.equal(starts.length, 1);
  await clock.advance(1);
  assert.equal(await second, 'second');
  assert.deepEqual(starts, [0, 2100]);
});

test('stopping the gate prevents queued starts without cancelling a request already in flight', async () => {
  const clock = fakeClock();
  const gate = createRequestGate({ sleep: clock.sleep, now: clock.now });
  const inFlight = deferred();
  const first = gate.run(() => inFlight.promise);
  const next = gate.run(() => assert.fail('a stopped queue must not dispatch this request'));
  const stopped = Object.assign(new Error('stop all starts'), { stopBatch: true });
  const rejected = assert.rejects(next, error => error === stopped);
  await turn();
  gate.stop(stopped);
  inFlight.resolve('retained result');
  assert.equal(await first, 'retained result');
  await clock.advance(500);
  await rejected;
  await assert.rejects(gate.run(() => assert.fail('new starts also remain stopped')), error => error === stopped);
});

test('requestJSON applies HTTP 200 maxlag backoff to other workers through the shared gate', async () => {
  const clock = fakeClock();
  const gate = createRequestGate({ sleep: clock.sleep, now: clock.now });
  const starts = [];
  const counts = new Map();
  const fetchImpl = async url => {
    const title = new URL(url).searchParams.get('titles');
    const attempt = 1 + (counts.get(title) ?? 0);
    counts.set(title, attempt);
    starts.push({ title, time: clock.now() });
    return title === '受限甲' && attempt === 1
      ? new Response(JSON.stringify({ error: { code: 'maxlag' } }), { headers: { 'Retry-After': '2' } })
      : new Response(JSON.stringify({ query: { title } }));
  };
  const options = { gate, sleep: clock.sleep, fetchImpl };
  const first = requestJSON({ titles: '受限甲' }, options);
  const second = requestJSON({ titles: '排队乙' }, options);
  await eventually(() => clock.sleepers.some(wait => wait.at === 5000), 'maxlag should schedule its shared 5-second minimum cooldown');
  await clock.advance(500);
  assert.equal(starts.length, 1);
  await clock.advance(4499);
  assert.equal(starts.length, 1);
  await clock.advance(1);
  await clock.advance(500);
  const results = await Promise.all([first, second]);
  assert.deepEqual(results.map(item => item.query.title), ['受限甲', '排队乙']);
  assert.equal(starts.length, 3);
  assert.ok(starts.slice(1).every(item => item.time >= 5000));
  assert.ok(starts[2].time - starts[1].time >= 500);
});

test('long Retry-After stops sibling requestJSON workers without dispatching their queued fetches', async () => {
  const clock = fakeClock();
  const gate = createRequestGate({ sleep: clock.sleep, now: clock.now });
  let calls = 0;
  const options = { gate, sleep: clock.sleep, fetchImpl: async () => {
    calls++;
    return new Response('busy', { status: 429, headers: { 'Retry-After': '120' } });
  } };
  const first = requestJSON({ titles: '受限甲' }, options);
  const second = requestJSON({ titles: '排队乙' }, options);
  const checks = [first, second].map(promise => assert.rejects(promise, error => error.stopBatch === true));
  await turn();
  await clock.advance(500);
  await Promise.all(checks);
  assert.equal(calls, 1);
});
