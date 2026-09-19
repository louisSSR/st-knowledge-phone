import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildPack } from '../scripts/knowledge-builder.mjs';
import { verifyCollection } from '../scripts/verify-collection.mjs';

const sha256 = value => createHash('sha256').update(value).digest('hex');

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'knowledge-acceptance-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const parts = ['象棋采用棋盘与棋子。\n\n', '双方交替行棋，规则详见原文。'];
  const text = parts.join('');
  const article = {
    pageId: 123, title: '象棋', requestedTitles: ['中国象棋'],
    retrievedAt: '2026-09-20T01:00:00.000Z', sourceUrl: 'https://zh.wikipedia.org/wiki/%E8%B1%A1%E6%A3%8B',
    historyUrl: 'https://zh.wikipedia.org/w/index.php?title=%E8%B1%A1%E6%A3%8B&action=history',
    observedRevisionId: 987654, observedRevisionAt: '2026-09-19T00:00:00Z',
    extractSha256: sha256(text), normalizedSha256: sha256(text), normalizedCharacters: text.length,
    entryIds: ['wiki-zh-123-001', 'wiki-zh-123-002'],
  };
  const source = {
    manifest: { schemaVersion: 1, id: 'fixture-wikipedia', name: '测试采集包', version: '1',
      description: '仅供测试的采集器输出', license: 'CC BY-SA 4.0', createdAt: '2026-09-20' },
    entries: parts.map((part, index) => ({
      id: article.entryIds[index], type: 'game_rule', title: index === 0 ? '象棋' : '象棋（第2段）',
      aliases: ['象棋', '中国象棋'], summary: part.trim(), contentRef: article.entryIds[index],
      tags: ['棋类'], location: [], dates: { knownFrom: '2026-09-20' },
      source: { kind: 'offline', name: '中文维基百科', url: article.sourceUrl, updatedAt: '2026-09-20', license: 'CC BY-SA 4.0' },
      metadata: { pageId: 123, part: index + 1, partCount: 2, observedRevisionId: article.observedRevisionId,
        observedRevisionAt: article.observedRevisionAt, retrievedAt: article.retrievedAt,
        extractSha256: article.extractSha256, normalizedSha256: article.normalizedSha256,
        historyUrl: article.historyUrl, licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/', sourceTitle: article.title,
        contentCharacters: part.length },
      content: `${part}\n\n——\n来源：中文维基百科《${article.title}》及其贡献者\n原文：${article.sourceUrl}\n作者历史：${article.historyUrl}\n许可：CC BY-SA 4.0 · https://creativecommons.org/licenses/by-sa/4.0/\n处理：纯文本摘录、空白规范化、分段；不含图片、部分表格与模板。\n采集：${article.retrievedAt}（当前快照，不代表历史时点的知识）`,
    })),
  };
  const report = { schemaVersion: 1, status: 'passed', generatedAt: '2026-09-20T01:00:01.000Z', requested: 1,
    articles: [article], duplicates: [], failures: [], packs: [] };
  const rightsResponse = { query: { rightsinfo: { url: 'https://creativecommons.org/licenses/by-sa/4.0/deed.zh', text: 'Creative Commons Attribution-Share Alike 4.0' } } };
  report.rightsEvidence = { retrievedAt: '2026-09-20T00:59:00.000Z', responseSha256: sha256(JSON.stringify(rightsResponse)), response: rightsResponse };
  async function save() {
    const bytes = Buffer.from(`${JSON.stringify(buildPack(source))}\n`);
    report.packs = [{ file: 'fixture.pack.json', sha256: sha256(bytes), bytes: bytes.length, entryCount: source.entries.length }];
    await writeFile(join(directory, 'fixture.pack.json'), bytes);
    await saveReport();
  }
  async function saveReport() { await writeFile(join(directory, 'report.json'), JSON.stringify(report)); }
  await save();
  return { directory, source, report, article, save, saveReport };
}

test('collection acceptance verifies full reconstruction, provenance, strict timeline and alias search offline', async t => {
  const data = await fixture(t);
  const before = await readFile(join(data.directory, 'fixture.pack.json'));
  const result = await verifyCollection(data.directory);
  assert.equal(result.status, 'passed');
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.summary, { packs: 1, articles: 1, entries: 2, reconstructedCharacters: data.article.normalizedCharacters, searchQueries: 2 });
  assert.match(result.limitations.join(' '), /不是逐条事实核查、真实 SillyTavern/);
  assert.deepEqual(JSON.parse(await readFile(join(data.directory, 'acceptance.json'), 'utf8')), result);
  assert.deepEqual(await readFile(join(data.directory, 'fixture.pack.json')), before, 'acceptance cannot modify the source pack');
});

test('collection acceptance rejects altered pack bytes even when the schema remains valid', async t => {
  const data = await fixture(t);
  data.report.packs[0].sha256 = '0'.repeat(64);
  await data.saveReport();
  const result = await verifyCollection(data.directory);
  assert.equal(result.status, 'failed');
  assert.match(JSON.stringify(result.failures), /SHA-256 不匹配/);
});

test('collection acceptance never certifies a partial or failed collection report', async t => {
  const data = await fixture(t);
  data.report.status = 'failed';
  data.report.failures = [{ title: '桥牌', message: 'network timeout' }];
  await data.saveReport();
  const result = await verifyCollection(data.directory);
  assert.equal(result.status, 'failed');
  assert.equal(result.summary.articles, 0);
});

test('collection acceptance detects silent omission of requested articles', async t => {
  const data = await fixture(t);
  data.report.requested = 2;
  await data.saveReport();
  const result = await verifyCollection(data.directory);
  assert.equal(result.status, 'failed');
  assert.match(JSON.stringify(result.failures), /请求总数/);
});

test('collection acceptance counts each repeated request and checks its target mapping', async t => {
  const data = await fixture(t);
  data.report.requested = 3;
  data.report.duplicates = [
    { requestedTitle: '中国象棋', pageId: 123, reason: 'same-page' },
    { requestedTitle: '中国象棋', pageId: 123, reason: 'same-page' },
  ];
  await data.saveReport();
  assert.equal((await verifyCollection(data.directory)).status, 'passed');
  data.report.duplicates[1].requestedTitle = '完全不同的文章';
  await data.saveReport();
  const result = await verifyCollection(data.directory);
  assert.equal(result.status, 'failed');
  assert.match(JSON.stringify(result.failures), /合并请求未映射/);
});

test('collection acceptance rejects altered license evidence and incompatible upstream licenses', async t => {
  const data = await fixture(t);
  data.report.rightsEvidence.response.query.rightsinfo.url = 'https://creativecommons.org/licenses/by-nc/4.0/';
  await data.saveReport();
  assert.match(JSON.stringify((await verifyCollection(data.directory)).failures), /许可证据 SHA-256 不匹配/);
  data.report.rightsEvidence.responseSha256 = sha256(JSON.stringify(data.report.rightsEvidence.response));
  await data.saveReport();
  assert.match(JSON.stringify((await verifyCollection(data.directory)).failures), /未确认 CC BY-SA 4.0/);
});

test('collection acceptance detects missing mapped chunks despite updated pack checksums and counts', async t => {
  const data = await fixture(t);
  data.source.entries.pop();
  await data.save();
  const result = await verifyCollection(data.directory);
  assert.equal(result.status, 'failed');
  assert.match(JSON.stringify(result.failures), /条目不存在/);
});

test('collection acceptance detects content changes against the reconstructed source hash', async t => {
  const data = await fixture(t);
  data.source.entries[0].content = data.source.entries[0].content.replace('棋盘', '棋槃');
  await data.save();
  const result = await verifyCollection(data.directory);
  assert.equal(result.status, 'failed');
  assert.match(JSON.stringify(result.failures), /重组正文 SHA-256 不匹配/);
});

test('collection acceptance rejects an attempt to expose modern snapshots on a 2008 timeline', async t => {
  const data = await fixture(t);
  data.source.entries[0].dates.knownFrom = '2000-01-01';
  await data.save();
  const result = await verifyCollection(data.directory);
  assert.equal(result.status, 'failed');
  assert.match(JSON.stringify(result.failures), /禁止倒填为历史日期/);
});

test('collection acceptance rejects missing attribution even when content indexes and checksums are rebuilt', async t => {
  const data = await fixture(t);
  data.source.entries[0].content = data.source.entries[0].content.replace('及其贡献者', '');
  await data.save();
  const result = await verifyCollection(data.directory);
  assert.equal(result.status, 'failed');
  assert.match(JSON.stringify(result.failures), /署名、来源、许可或处理声明不完整/);
});

test('collection acceptance refuses report paths outside its output directory', async t => {
  const data = await fixture(t);
  data.report.packs[0].file = '../fixture.pack.json';
  await data.saveReport();
  const result = await verifyCollection(data.directory);
  assert.equal(result.status, 'failed');
  assert.match(JSON.stringify(result.failures), /文件名不安全/);
});

test('collection acceptance writes a failed receipt for malformed report JSON', async t => {
  const data = await fixture(t);
  await writeFile(join(data.directory, 'report.json'), '{');
  const result = await verifyCollection(data.directory);
  assert.equal(result.status, 'failed');
  assert.equal(result.failures[0].check, '验收输入可读取');
});
