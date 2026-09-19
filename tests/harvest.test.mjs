import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { harvest, parseArgs, partitionFailures } from '../scripts/harvest-wikipedia.mjs';
import { validateConfig } from '../scripts/collect-wikipedia.mjs';

const config = { schemaVersion: 1, id: 'harvest-fixture', name: '采集测试', articles: ['太阳系', '猫', '纸'].map(title => ({ title, type: 'article' })) };
const reportFor = value => ({ schemaVersion: 1, status: 'passed', requested: value.articles.length,
  articles: value.articles.map(item => ({ title: item.title })), duplicates: [], failures: [], packs: [{ file: 'fixture.pack.json', entryCount: value.articles.length }],
  metrics: { cacheHits: value.articles.length, downloaded: 0, durationMs: 1 },
});
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'knowledge-harvest-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const outDir = join(directory, 'batch'), cacheDir = join(directory, 'cache');
  return { outDir, cacheDir };
}
async function collectGood(value, options) {
  const report = reportFor(value);
  await mkdir(options.outDir, { recursive: true });
  await writeFile(join(options.outDir, 'report.json'), JSON.stringify(report));
  await writeFile(join(options.outDir, 'fixture.pack.json'), 'fixture');
  return report;
}
async function verifyGood(directory) {
  const report = JSON.parse(await readFile(join(directory, 'report.json'), 'utf8'));
  return { status: 'passed', summary: { articles: report.articles.length, packs: 1, entries: report.articles.length }, failures: [] };
}

test('one-step harvest publishes ready directory only after independent acceptance', async t => {
  const options = await fixture(t);
  const calls = [];
  const receipt = await harvest(config, { ...options, offline: true,
    collectImpl: async (value, opts) => { calls.push(opts); return collectGood(value, opts); },
    verifyImpl: async directory => {
      await assert.rejects(access(join(options.outDir, 'ready')));
      return verifyGood(directory);
    },
  });
  assert.equal(receipt.status, 'passed');
  assert.deepEqual(receipt.counts, { requested: 3, accepted: 3, articles: 3, duplicates: 0, quarantined: 0, pending: 0, packs: 1, entries: 3 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].offline, true);
  assert.equal(calls[0].concurrency, 1);
  await access(join(receipt.readyDirectory, 'fixture.pack.json'));
  assert.deepEqual(JSON.parse(await readFile(join(options.outDir, 'receipt.json'), 'utf8')), receipt);
});

test('quality rejection and rate-limit pending remain separate in a partial batch', async t => {
  const options = await fixture(t);
  let calls = 0;
  const receipt = await harvest(config, { ...options, concurrency: 3,
    collectImpl: async (value, opts) => {
      if (++calls === 2) {
        assert.deepEqual(value.articles.map(item => item.title), ['太阳系']);
        assert.equal(opts.offline, true, 'rescue packaging must never download again');
        return collectGood(value, opts);
      }
      const report = { ...reportFor(value), status: 'failed', articles: [], packs: [], stoppedReason: 'HTTP 429', failures: [
        { title: '猫', reason: '摘录不足 200 字符' },
        { title: '纸', reason: '来源要求等待', pending: true },
      ] };
      await mkdir(opts.outDir, { recursive: true });
      await writeFile(join(opts.outDir, 'report.json'), JSON.stringify(report));
      throw new Error('2 条失败，未发布');
    }, verifyImpl: verifyGood,
  });
  assert.equal(receipt.status, 'partial');
  assert.deepEqual(receipt.counts, { requested: 3, accepted: 1, articles: 1, duplicates: 0, quarantined: 1, pending: 1, packs: 1, entries: 1 });
  assert.equal(receipt.quarantined[0].title, '猫');
  assert.equal(receipt.pending[0].title, '纸');
  assert.equal(receipt.stoppedReason, 'HTTP 429');
  await access(join(options.outDir, 'raw', 'report.json'));
  await access(join(options.outDir, 'ready', 'fixture.pack.json'));
});

test('failed independent acceptance cannot yield accepted counts or a ready path', async t => {
  const options = await fixture(t);
  const receipt = await harvest(config, { ...options, collectImpl: collectGood,
    verifyImpl: async () => ({ status: 'failed', failures: [{ check: '正文 SHA-256', message: '被篡改' }] }),
  });
  assert.equal(receipt.status, 'failed');
  assert.equal(receipt.counts.accepted, 0);
  assert.equal(receipt.readyDirectory, null);
  assert.match(receipt.error, /独立技术验收失败/);
  await assert.rejects(access(join(options.outDir, 'ready')));
});

test('verifier exception and misleading count summaries both block readiness', async t => {
  for (const verifyImpl of [async () => { throw new Error('验收中断'); }, async () => ({ status: 'passed', summary: { articles: 1, packs: 1, entries: 3 } })]) {
    const options = await fixture(t);
    const receipt = await harvest(config, { ...options, collectImpl: collectGood, verifyImpl });
    assert.equal(receipt.status, 'failed');
    assert.equal(receipt.readyDirectory, null);
    assert.equal(receipt.counts.accepted, 0);
    await assert.rejects(access(join(options.outDir, 'ready')));
  }
});

test('batch stops without fabricating accepted data when every request is pending', async t => {
  const options = await fixture(t);
  let verified = false;
  const receipt = await harvest(config, { ...options,
    collectImpl: async (value, opts) => {
      await mkdir(opts.outDir, { recursive: true });
      await writeFile(join(opts.outDir, 'report.json'), JSON.stringify({ ...reportFor(value), status: 'failed', articles: [], packs: [], failures: value.articles.map(item => ({ title: item.title, reason: '整批已停止', pending: true })) }));
      throw new Error('停止');
    }, verifyImpl: async () => { verified = true; },
  });
  assert.equal(receipt.status, 'failed');
  assert.equal(receipt.counts.pending, 3);
  assert.equal(receipt.counts.quarantined, 0);
  assert.equal(receipt.counts.accepted, 0);
  assert.equal(verified, false);
});

test('candidate cache failure cannot trigger a network retry or successful receipt', async t => {
  const options = await fixture(t);
  let calls = 0, verified = false;
  const receipt = await harvest(config, { ...options,
    collectImpl: async (value, opts) => {
      if (++calls === 2) {
        assert.equal(opts.offline, true);
        throw new Error('候选项缓存发生损坏');
      }
      await mkdir(opts.outDir, { recursive: true });
      await writeFile(join(opts.outDir, 'report.json'), JSON.stringify({ ...reportFor(value), status: 'failed', articles: [], packs: [], failures: [{ title: '猫', reason: '消歧义页面' }] }));
      throw new Error('质量检查失败');
    }, verifyImpl: async () => { verified = true; },
  });
  assert.equal(calls, 2);
  assert.equal(verified, false);
  assert.equal(receipt.status, 'failed');
  assert.equal(receipt.counts.accepted, 0);
  assert.equal(receipt.readyDirectory, null);
  assert.match(receipt.error, /缓存发生损坏/);
  await assert.rejects(access(join(options.outDir, 'ready')));
});

test('collection failures without a report are preserved as failed batch receipts', async t => {
  const options = await fixture(t);
  const receipt = await harvest(config, { ...options, collectImpl: async () => { throw new Error('许可证据下载失败'); }, verifyImpl: verifyGood });
  assert.equal(receipt.status, 'failed');
  assert.equal(receipt.readyDirectory, null);
  assert.equal(receipt.counts.accepted, 0);
  assert.match(receipt.error, /许可证据下载失败/);
  assert.equal(JSON.parse(await readFile(join(options.outDir, 'receipt.json'), 'utf8')).status, 'failed');
});

test('incomplete or contradictory failure reports cannot produce candidates', () => {
  assert.throws(() => partitionFailures(config, { ...reportFor(config), requested: 2 }), /请求数/);
  assert.throws(() => partitionFailures(config, { ...reportFor(config), failures: [{ title: '未知', reason: '坏页' }] }), /未知标题/);
  assert.throws(() => partitionFailures(config, { ...reportFor(config), status: 'failed' }), /不一致/);
  const parts = partitionFailures(config, { ...reportFor(config), status: 'failed', failures: [{ title: '猫', reason: '下载失败：连接超时' }] });
  assert.equal(parts.pending.length, 1);
  assert.equal(parts.quarantined.length, 0);
});

test('existing batch output is never overwritten', async t => {
  const options = await fixture(t);
  await mkdir(options.outDir);
  await writeFile(join(options.outDir, 'receipt.json'), 'existing evidence');
  await assert.rejects(harvest(config, { ...options, collectImpl: collectGood, verifyImpl: verifyGood }), { code: 'EEXIST' });
  assert.equal(await readFile(join(options.outDir, 'receipt.json'), 'utf8'), 'existing evidence');
});

test('CLI argument handling bounds concurrency and rejects unexpected inputs', () => {
  assert.equal(parseArgs([]).concurrency, 1);
  assert.equal(parseArgs(['--concurrency', '3', '--offline']).offline, true);
  assert.throws(() => parseArgs(['--concurrency', '8']), /1–3/);
  assert.throws(() => parseArgs(['--out']), /缺值/);
  assert.throws(() => parseArgs(['--refresh']), /未知/);
});

test('general corpus is exactly 100 unique allowlisted articles without repeating starter titles', async () => {
  const general = JSON.parse(await readFile(new URL('../corpus/wikipedia-zh-general.json', import.meta.url), 'utf8'));
  const starter = JSON.parse(await readFile(new URL('../corpus/wikipedia-zh-starter.json', import.meta.url), 'utf8'));
  validateConfig(general);
  assert.equal(general.articles.length, 100);
  assert.equal(new Set(general.articles.map(item => item.title)).size, 100);
  assert.ok(general.articles.every(item => item.type === 'article'));
  for (const item of starter.articles) assert.ok(!general.articles.some(value => value.title === item.title));
});
