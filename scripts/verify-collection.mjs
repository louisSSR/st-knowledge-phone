import { createHash } from 'node:crypto';
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { MAX_PACK_BYTES, parsePack } from '../dist/library/pack.js';
import { isVisible } from '../dist/search/filters.js';
import { searchCorpus } from '../dist/search/rank.js';

const LICENSE_URL = 'https://creativecommons.org/licenses/by-sa/4.0/';
const sha256 = value => createHash('sha256').update(value).digest('hex');
const context = worldDate => ({ worldDate, location: [], strictTimeline: true, chatKey: 'collection-acceptance' });

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function timestamp(value, label) {
  requireValue(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value)
    && Number.isFinite(Date.parse(value)), `${label} 必须是 UTC ISO 时间`);
  requireValue(new Date(value).toISOString().slice(0, 10) === value.slice(0, 10), `${label} 日期无效`);
  return Date.parse(value);
}

function hash(value, label) {
  requireValue(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value), `${label} 必须是 SHA-256`);
}

function sourceUrl(value, history = false) {
  const url = new URL(value);
  requireValue(url.protocol === 'https:' && url.hostname === 'zh.wikipedia.org' && !url.username && !url.password && !url.port,
    '来源必须是中文维基百科 HTTPS 地址');
  requireValue(history ? url.pathname === '/w/index.php' && url.searchParams.get('action') === 'history' : url.pathname.startsWith('/wiki/'),
    history ? '作者历史地址必须指向页面历史' : '原文地址必须指向百科页面');
}

function attribution(article) {
  return `\n\n——\n来源：中文维基百科《${article.title}》及其贡献者\n原文：${article.sourceUrl}\n作者历史：${article.historyUrl}\n许可：CC BY-SA 4.0 · ${LICENSE_URL}\n处理：纯文本摘录、空白规范化、分段；不含图片、部分表格与模板。\n采集：${article.retrievedAt}（当前快照，不代表历史时点的知识）`;
}

/** Offline structural acceptance only; it does not re-fetch or certify source facts. */
export async function verifyCollection(directory) {
  const root = await realpath(resolve(directory));
  const acceptance = {
    schemaVersion: 1, status: 'failed', verifiedAt: new Date().toISOString(),
    summary: { packs: 0, articles: 0, entries: 0, reconstructedCharacters: 0, searchQueries: 0 },
    checks: [], failures: [],
    limitations: [
      '这是离线技术验收，不是逐条事实核查、真实 SillyTavern 运行验收或用户最终验收。',
      '校验重组文本与采集报告中的 SHA-256 一致；未重新联网比对上游页面，也不能证明采集器记录的原始 extract 哈希。',
      '采集日期是保守的知识可见起点；当前快照不代表任何历史时点的百科内容。',
    ],
  };
  function check(name, action) {
    try { action(); acceptance.checks.push({ name, status: 'passed' }); return true; }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      acceptance.checks.push({ name, status: 'failed', message });
      acceptance.failures.push({ check: name, message });
      return false;
    }
  }
  try {
    const report = JSON.parse(await readFile(resolve(root, 'report.json'), 'utf8'));
    const validReport = check('采集报告完整成功', () => {
      requireValue(report && report.schemaVersion === 1, '不支持的采集报告版本');
      requireValue(report.status === 'passed', '采集报告未成功，不能验收为通过');
      timestamp(report.generatedAt, 'generatedAt');
      requireValue(Number.isInteger(report.requested) && report.requested > 0, 'requested 必须是正整数');
      requireValue(Array.isArray(report.articles) && report.articles.length > 0, '采集报告没有文章');
      requireValue(Array.isArray(report.duplicates), 'duplicates 必须是数组');
      requireValue(Array.isArray(report.failures) && report.failures.length === 0, '采集仍有失败项');
      requireValue(Array.isArray(report.packs) && report.packs.length > 0, '采集报告没有知识包');
      requireValue(report.requested === report.articles.length + report.duplicates.length, '请求总数与成功文章、合并请求数不一致');
      for (const duplicate of report.duplicates) {
        requireValue(duplicate && duplicate.reason === 'same-page' && typeof duplicate.requestedTitle === 'string', '合并请求记录无效');
        const article = report.articles.find(value => value.pageId === duplicate.pageId);
        requireValue(article && Array.isArray(article.requestedTitles) && article.requestedTitles.includes(duplicate.requestedTitle), '合并请求未映射到对应文章的请求标题');
      }
      const evidence = report.rightsEvidence;
      requireValue(evidence && timestamp(evidence.retrievedAt, 'rightsEvidence.retrievedAt') <= timestamp(report.generatedAt, 'generatedAt'), '站点许可证据缺失或晚于报告');
      hash(evidence.responseSha256, 'rightsEvidence.responseSha256');
      requireValue(evidence.response && sha256(JSON.stringify(evidence.response)) === evidence.responseSha256, '站点许可证据 SHA-256 不匹配');
      const rights = evidence.response.query?.rightsinfo;
      requireValue(rights && typeof rights.url === 'string'
        && /^https:\/\/creativecommons\.org\/licenses\/by-sa\/4\.0\/(?:deed\.[a-z-]+)?$/.test(rights.url)
        && typeof rights.text === 'string' && rights.text.trim(), '站点许可证据未确认 CC BY-SA 4.0');
    });
    if (validReport) {
      const packs = [];
      const fileNames = new Set();
      const packIds = new Set();
      const entries = new Map();
      for (const descriptor of report.packs) {
        let loaded;
        try {
          requireValue(descriptor && typeof descriptor.file === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]*\.pack\.json$/.test(descriptor.file), '知识包文件名不安全');
          requireValue(!fileNames.has(descriptor.file.toLowerCase()), '报告含重复知识包文件');
          fileNames.add(descriptor.file.toLowerCase());
          const path = await realpath(resolve(root, descriptor.file));
          requireValue(dirname(path) === root, '知识包路径必须位于采集目录内');
          const bytes = await readFile(path);
          loaded = { bytes, pack: parsePack(JSON.parse(bytes.toString('utf8'))) };
        } catch (error) {
          check(`知识包读取与 schema：${descriptor?.file ?? '(缺失文件名)'}`, () => { throw error; });
          continue;
        }
        const { bytes, pack } = loaded;
        const validPack = check(`知识包完整性：${descriptor.file}`, () => {
          hash(descriptor.sha256, 'pack.sha256');
          requireValue(bytes.byteLength <= MAX_PACK_BYTES, '知识包文件超过 10 MiB');
          requireValue(bytes.byteLength === descriptor.bytes, '知识包字节数不匹配');
          requireValue(sha256(bytes) === descriptor.sha256, '知识包 SHA-256 不匹配');
          requireValue(pack.entries.length === descriptor.entryCount, '知识包条目数不匹配');
          requireValue(!packIds.has(pack.manifest.id), '知识包 ID 重复');
          requireValue(/CC BY-SA\s*4\.0/.test(pack.manifest.license), '知识包缺少 CC BY-SA 4.0 许可');
          for (const entry of pack.entries) requireValue(!entries.has(entry.id), `跨包条目 ID 重复：${entry.id}`);
        });
        if (!validPack) continue;
        packIds.add(pack.manifest.id);
        packs.push(pack);
        for (const entry of pack.entries) entries.set(entry.id, { entry, body: pack.content[entry.contentRef] });
      }
      acceptance.summary.packs = packs.length;
      acceptance.summary.entries = entries.size;
      const corpora = packs.map(pack => ({ packId: pack.manifest.id, packName: pack.manifest.name, entries: pack.entries, documents: pack.index.documents }));
      const claimed = new Set();
      const pageIds = new Set();
      const articleHashes = new Set();
      for (const article of report.articles) {
        const validArticle = check(`文章来源与重组：${article?.title ?? '(缺失标题)'}`, () => {
          requireValue(article && Number.isInteger(article.pageId) && article.pageId > 0, 'pageId 必须是正整数');
          requireValue(!pageIds.has(article.pageId), '同一页面被重复采集');
          requireValue(typeof article.title === 'string' && article.title.trim(), '文章标题缺失');
          requireValue(Array.isArray(article.requestedTitles) && article.requestedTitles.length > 0
            && article.requestedTitles.every(value => typeof value === 'string' && value.trim()), '请求标题记录缺失');
          const retrieved = timestamp(article.retrievedAt, 'retrievedAt');
          requireValue(timestamp(article.observedRevisionAt, 'observedRevisionAt') <= retrieved, '修订时间晚于采集时间');
          requireValue(retrieved <= timestamp(report.generatedAt, 'generatedAt'), '采集时间晚于报告生成时间');
          requireValue(Number.isInteger(article.observedRevisionId) && article.observedRevisionId > 0, '修订 ID 无效');
          sourceUrl(article.sourceUrl);
          sourceUrl(article.historyUrl, true);
          hash(article.extractSha256, 'extractSha256');
          hash(article.normalizedSha256, 'normalizedSha256');
          requireValue(!articleHashes.has(article.normalizedSha256), '相同规范化正文被重复收录');
          requireValue(Number.isInteger(article.normalizedCharacters) && article.normalizedCharacters > 0, '正文字符数无效');
          requireValue(Array.isArray(article.entryIds) && article.entryIds.length > 0, '文章缺少条目映射');
          let reconstructed = '';
          const localClaims = new Set();
          for (let index = 0; index < article.entryIds.length; index++) {
            const id = article.entryIds[index];
            requireValue(id === `wiki-zh-${article.pageId}-${String(index + 1).padStart(3, '0')}`, '条目 ID 或分段顺序无效');
            requireValue(!claimed.has(id) && !localClaims.has(id), '条目被多次声明');
            localClaims.add(id);
            const found = entries.get(id);
            requireValue(found, `文章映射的条目不存在：${id}`);
            const { entry, body } = found;
            const meta = entry.metadata;
            requireValue(['article', 'game_rule'].includes(entry.type), '采集文章条目类型无效');
            requireValue(meta.part === index + 1 && meta.partCount === article.entryIds.length, '分段编号或总数不匹配');
            requireValue(entry.title === (index === 0 ? article.title : `${article.title}（第${index + 1}段）`), '分段标题不匹配');
            for (const alias of [article.title, ...article.requestedTitles]) requireValue(entry.aliases.includes(alias), `来源标题别名缺失：${alias}`);
            for (const field of ['pageId', 'observedRevisionId', 'observedRevisionAt', 'retrievedAt', 'extractSha256', 'normalizedSha256', 'historyUrl']) {
              requireValue(meta[field] === article[field], `条目 ${id} 的 ${field} 与报告不符`);
            }
            requireValue(meta.sourceTitle === article.title && meta.licenseUrl === LICENSE_URL, '来源标题或许可地址不符');
            requireValue(entry.source.url === article.sourceUrl && entry.source.name.includes('中文维基百科'), '条目来源不符');
            requireValue(/CC BY-SA\s*4\.0/.test(entry.source.license), '条目许可缺失');
            requireValue(entry.source.updatedAt === article.retrievedAt.slice(0, 10), '来源更新日期不等于采集日期');
            requireValue(entry.dates.knownFrom === article.retrievedAt.slice(0, 10), '知识可见日期必须等于采集日期，禁止倒填为历史日期');
            requireValue(Number.isInteger(meta.contentCharacters) && meta.contentCharacters > 0 && meta.contentCharacters < body.length, '分段正文字符数无效');
            requireValue(body.slice(meta.contentCharacters) === attribution(article), '分段署名、来源、许可或处理声明不完整');
            reconstructed += body.slice(0, meta.contentCharacters);
            requireValue(isVisible(entry, context(article.retrievedAt.slice(0, 10))), '采集当天应能检索该条目');
            requireValue(!isVisible(entry, context('2008-07-18')), '当前快照泄漏到 2008 年时间线');
            requireValue(!isVisible(entry, context(null)), '未知世界日期时泄漏当前快照');
          }
          requireValue(reconstructed.length === article.normalizedCharacters, '重组正文字符数不匹配');
          requireValue(sha256(reconstructed) === article.normalizedSha256, '重组正文 SHA-256 不匹配，可能截断、遗漏或乱序');
          for (const id of localClaims) claimed.add(id);
          pageIds.add(article.pageId);
          articleHashes.add(article.normalizedSha256);
          acceptance.summary.reconstructedCharacters += reconstructed.length;
        });
        if (!validArticle) continue;
        acceptance.summary.articles++;
        for (const query of new Set([article.title, ...article.requestedTitles])) {
          check(`标题/别名检索：${query}`, () => {
            const reply = searchCorpus(corpora, { query, context: context(article.retrievedAt.slice(0, 10)), limit: 12 });
            requireValue(reply.results.some(result => article.entryIds.includes(result.entry.id)), '标题或别名未在首屏检出对应文章');
            for (const date of ['2008-07-18', null]) {
              const hidden = searchCorpus(corpora, { query, context: context(date), limit: 12 });
              requireValue(hidden.total === 0 && hidden.suggestions.length === 0, '严格历史/未知日期搜索或建议泄漏当前快照');
            }
            acceptance.summary.searchQueries++;
          });
        }
      }
      check('报告与知识包条目一一对应', () => {
        requireValue(claimed.size === entries.size, '存在未映射条目或未能完整重组的文章');
        requireValue(packs.length === report.packs.length, '有知识包未通过校验');
        requireValue(acceptance.summary.articles === report.articles.length, '有文章未通过校验');
      });
    }
  } catch (error) {
    check('验收输入可读取', () => { throw error; });
  }
  acceptance.status = acceptance.failures.length === 0 ? 'passed' : 'failed';
  const output = resolve(root, 'acceptance.json');
  const existing = await lstat(output).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
  requireValue(!existing?.isSymbolicLink(), '拒绝写入符号链接 acceptance.json');
  await writeFile(output, `${JSON.stringify(acceptance, null, 2)}\n`, 'utf8');
  return acceptance;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 3) {
    process.stderr.write('用法：node scripts/verify-collection.mjs 采集输出目录\n');
    process.exitCode = 1;
  } else {
    await verifyCollection(process.argv[2]).then(result => {
      process.stdout.write(`${result.status === 'passed' ? '技术验收通过' : '技术验收失败'}：${result.summary.articles} 篇文章，${result.summary.entries} 个条目；详见 acceptance.json\n`);
      if (result.status !== 'passed') process.exitCode = 1;
    }).catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
  }
}
