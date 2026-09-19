import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, rename, access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { buildPack } from './knowledge-builder.mjs';
import { MAX_PACK_BYTES, MAX_PACK_ENTRIES } from '../dist/library/pack.js';

const API = 'https://zh.wikipedia.org/w/api.php';
const LICENSE_URL = 'https://creativecommons.org/licenses/by-sa/4.0/';
const USER_AGENT = 'KnowledgePhoneCollector/0.1 (https://github.com/louisSSR/st-knowledge-phone)';
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_ARTICLE_CHARACTERS = 250_000;
export const sha256 = value => createHash('sha256').update(value).digest('hex');
const stamp = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));

export function validateConfig(config) {
  if (config?.schemaVersion !== 1 || !/^[a-z0-9][a-z0-9-]{0,49}$/.test(config.id ?? '')) throw new Error('配置 schemaVersion/id 无效');
  if (typeof config.name !== 'string' || !config.name.trim() || config.name.length > 150) throw new Error('配置 name 无效');
  if (!Array.isArray(config.articles) || config.articles.length < 1 || config.articles.length > 100) throw new Error('每批需明确列出 1–100 个条目，不自动递归抓取');
  for (const item of config.articles) {
    if (typeof item.title !== 'string' || !item.title.trim() || item.title.length > 180 || /[|\u0000-\u001f]/.test(item.title)) throw new Error('条目 title 无效');
    if (!['article', 'game_rule'].includes(item.type)) throw new Error('type 仅支持 article/game_rule');
    for (const key of ['tags', 'aliases']) {
      if (item[key] !== undefined && (!Array.isArray(item[key]) || item[key].length > 12 || item[key].some(s => typeof s !== 'string' || !s.trim() || s.length > 180 || s.includes('\0')))) throw new Error(`${item.title}: ${key} 无效`);
    }
  }
  return config;
}

export function normalizeExtract(text) {
  return text.replace(/\r\n?/g, '\n').replace(/[\t\u00a0 ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// Keep every normalized character, including paragraph separators, across chunks.
export function splitText(text, maxCharacters = 6000) {
  if (!Number.isInteger(maxCharacters) || maxCharacters < 100 || maxCharacters > 50_000) throw new Error('分段字符上限必须为 100–50000');
  const parts = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + maxCharacters, text.length);
    if (end < text.length) {
      const paragraph = text.lastIndexOf('\n\n', end - 2);
      if (paragraph >= start + Math.floor(maxCharacters / 2)) end = paragraph + 2;
      // Never split a Unicode surrogate pair.
      if (/[\uD800-\uDBFF]/.test(text[end - 1])) end--;
    }
    parts.push(text.slice(start, end));
    start = end;
  }
  return parts;
}

export function validateSnapshot(snapshot, title) {
  if (snapshot?.schemaVersion !== 1 || snapshot.requestedTitle !== title || !stamp(snapshot.retrievedAt) || Date.parse(snapshot.retrievedAt) > Date.now() + 300_000) throw new Error('缓存标题或采集时间无效');
  if (snapshot.responseSha256 !== sha256(JSON.stringify(snapshot.response))) throw new Error('缓存原始响应校验失败；请使用 --refresh 重新采集');
  const data = snapshot.response;
  if (data?.error || data?.warnings) throw new Error('来源返回 API 错误/警告');
  if (data?.query?.redirects?.some(item => Object.hasOwn(item, 'tofragment'))) throw new Error('章节重定向不能冒充整篇资料');
  const pages = data?.query?.pages;
  if (!Array.isArray(pages) || pages.length !== 1) throw new Error('来源未返回唯一页面');
  const page = pages[0];
  if (['missing', 'invalid', 'known'].some(key => Object.hasOwn(page, key)) || page.ns !== 0 || !Number.isSafeInteger(page.pageid) || page.pageid <= 0) throw new Error('条目不存在或不属于百科正文');
  if (Object.hasOwn(page.pageprops ?? {}, 'disambiguation')) throw new Error('拒绝消歧义页，请指定具体条目');
  if (typeof page.title !== 'string' || !page.title.trim() || page.title.length > 180) throw new Error('来源标题无效');
  const revision = page.revisions?.[0];
  if (!Number.isSafeInteger(revision?.revid) || revision.revid <= 0 || !stamp(revision.timestamp) || Date.parse(revision.timestamp) > Date.parse(snapshot.retrievedAt) + 300_000) throw new Error('观测版本或版本时间无效');
  if (typeof page.extract !== 'string' || page.extract.includes('\0') || page.extract.length > MAX_ARTICLE_CHARACTERS) throw new Error('摘录缺失、含空字符或超过 25 万字符限额');
  const normalized = normalizeExtract(page.extract);
  if (normalized.length < 200) throw new Error('摘录不足 200 字符，不能作为本批可读资料');
  if (/\\(?:displaystyle|ce|begin|frac|mathrm|text|sqrt|left)\b/.test(normalized)) throw new Error('摘录含未可靠渲染的公式残渣，需人工复核或改用支持公式的采集方式');
  return { page, revision, normalized };
}

async function readJSONLimited(response) {
  if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) throw new Error('响应超过 2 MiB 限额');
  const reader = response.body.getReader();
  const buffers = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error('响应超过 2 MiB 限额');
      buffers.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  return JSON.parse(Buffer.concat(buffers).toString('utf8'));
}

export async function requestJSON(params, { fetchImpl = fetch, sleep = delay } = {}) {
  const url = new URL(API);
  url.search = new URLSearchParams({ action: 'query', format: 'json', formatversion: '2', maxlag: '5', ...params });
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    await sleep(1100);
    let response, data;
    try {
      response = await fetchImpl(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' }, signal: AbortSignal.timeout(30_000), redirect: 'error' });
      if (response.ok) data = await readJSONLimited(response);
      else await response.body?.cancel();
    } catch (error) {
      lastError = new Error(`下载失败：${error.message}`);
      if (attempt === 2) break;
      await sleep(5000 * 2 ** attempt);
      continue;
    }
    const transient = response.status === 429 || response.status >= 500 || ['maxlag', 'ratelimited', 'readonly'].includes(data?.error?.code);
    if (!response.ok || data?.error) {
      lastError = new Error(`来源拒绝：HTTP ${response.status}${data?.error?.code ? ` / ${data.error.code}` : ''}`);
      if (!transient || attempt === 2) {
        // The same host remains rate-limited even when moving to another title.
        if (transient) lastError.stopBatch = true;
        break;
      }
      const retry = response.headers.get('retry-after');
      const retrySeconds = retry === null ? 0 : (/^\d+$/.test(retry) ? Number(retry) : Math.max(0, (Date.parse(retry) - Date.now()) / 1000));
      if (!Number.isFinite(retrySeconds) || retrySeconds > 60) {
        const error = new Error('来源要求长时间等待；已停止整批，稍后使用缓存续跑');
        error.stopBatch = true;
        throw error;
      }
      await sleep(Math.max(5000 * 2 ** attempt, retrySeconds * 1000));
      continue;
    }
    if (data?.warnings) throw new Error('API 返回警告，需核对采集参数后重试');
    return data;
  }
  throw lastError;
}

export function buildCollection(config, snapshots, { generatedAt = new Date().toISOString(), maxPackBytes = 512 * 1024, maxPackEntries = 200, chunkCharacters = 6000 } = {}) {
  validateConfig(config);
  if (!Number.isInteger(maxPackBytes) || maxPackBytes < 1000 || maxPackBytes > MAX_PACK_BYTES || !Number.isInteger(maxPackEntries) || maxPackEntries < 1 || maxPackEntries > MAX_PACK_ENTRIES) throw new Error('分包限额无效');
  const report = { schemaVersion: 1, status: 'passed', generatedAt, requested: config.articles.length, articles: [], duplicates: [], failures: [], packs: [] };
  const unique = new Map();
  const contentHashes = new Map();
  for (let i = 0; i < config.articles.length; i++) {
    const spec = config.articles[i];
    try {
      const snapshot = snapshots[i];
      if (snapshot?.failure) throw new Error(snapshot.failure);
      const parsed = validateSnapshot(snapshot, spec.title);
      const { page, normalized } = parsed;
      if (unique.has(page.pageid)) {
        const previous = unique.get(page.pageid);
        if (previous.normalized !== normalized || previous.spec.type !== spec.type) throw new Error('相同页面的重复请求内容或类型不一致');
        previous.titles.add(spec.title);
        for (const alias of spec.aliases ?? []) previous.aliases.add(alias);
        for (const tag of spec.tags ?? []) previous.tags.add(tag);
        report.duplicates.push({ requestedTitle: spec.title, pageId: page.pageid, reason: 'same-page' });
        continue;
      }
      const contentHash = sha256(normalized);
      if (contentHashes.has(contentHash)) throw new Error(`正文与另一页面 ${contentHashes.get(contentHash)} 完全相同，请核对来源`);
      contentHashes.set(contentHash, page.pageid);
      unique.set(page.pageid, { ...parsed, snapshot, spec, titles: new Set([spec.title]), aliases: new Set(spec.aliases ?? []), tags: new Set(spec.tags ?? []) });
    } catch (error) { report.failures.push({ title: spec.title, reason: error.message }); }
  }
  if (report.failures.length) return { report: { ...report, status: 'failed' }, packs: [] };
  const entries = [];
  for (const { page, revision, normalized, snapshot, spec, titles, aliases, tags } of unique.values()) {
    const sourceUrl = `https://zh.wikipedia.org/wiki/${encodeURIComponent(page.title)}`;
    const historyUrl = `https://zh.wikipedia.org/w/index.php?title=${encodeURIComponent(page.title)}&action=history`;
    const chunks = splitText(normalized, chunkCharacters);
    const article = { pageId: page.pageid, title: page.title, requestedTitles: [...titles], retrievedAt: snapshot.retrievedAt, sourceUrl, historyUrl,
      observedRevisionId: revision.revid, observedRevisionAt: revision.timestamp, extractSha256: sha256(page.extract), normalizedSha256: sha256(normalized), normalizedCharacters: normalized.length, entryIds: [] };
    const attribution = `\n\n——\n来源：中文维基百科《${page.title}》及其贡献者\n原文：${sourceUrl}\n作者历史：${historyUrl}\n许可：CC BY-SA 4.0 · ${LICENSE_URL}\n处理：纯文本摘录、空白规范化、分段；不含图片、部分表格与模板。\n采集：${snapshot.retrievedAt}（当前快照，不代表历史时点的知识）`;
    chunks.forEach((chunk, index) => {
      const id = `wiki-zh-${page.pageid}-${String(index + 1).padStart(3, '0')}`;
      article.entryIds.push(id);
      entries.push({ id, type: spec.type, title: index === 0 ? page.title : `${page.title}（第${index + 1}段）`,
        aliases: [...new Set([page.title, ...titles, ...aliases])], summary: Array.from(chunk.trim()).slice(0, 240).join(''), contentRef: id,
        tags: [...new Set(['维基百科', '当前快照', ...tags])], location: [], dates: { knownFrom: snapshot.retrievedAt.slice(0, 10) },
        source: { name: '中文维基百科贡献者 · 纯文本摘录', url: sourceUrl, updatedAt: snapshot.retrievedAt.slice(0, 10), license: `CC BY-SA 4.0 · ${LICENSE_URL}`, kind: 'offline' },
        metadata: { pageId: page.pageid, part: index + 1, partCount: chunks.length, observedRevisionId: revision.revid, observedRevisionAt: revision.timestamp,
          retrievedAt: snapshot.retrievedAt, extractSha256: article.extractSha256, normalizedSha256: article.normalizedSha256, historyUrl, licenseUrl: LICENSE_URL, sourceTitle: page.title, contentCharacters: chunk.length },
        content: chunk + attribution });
    });
    report.articles.push(article);
  }
  const packs = [];
  let batch = [];
  const makePack = items => buildPack({ manifest: { schemaVersion: 1, id: `${config.id}-${String(packs.length + 1).padStart(3, '0')}`, name: `${config.name} · ${packs.length + 1}`, version: generatedAt.replace(/[:.]/g, '-'),
    description: '中文维基百科纯文本摘录。当前采集快照；可能省略图片、表格、公式或模板，不保证事实正确或历史时点可知。保留来源、作者历史与 CC BY-SA 4.0 许可。', license: `CC BY-SA 4.0 · ${LICENSE_URL}`, createdAt: generatedAt.slice(0, 10) }, entries: items });
  const serialized = pack => `${JSON.stringify(pack)}\n`;
  const saveBatch = () => {
    const pack = makePack(batch);
    const bytes = serialized(pack);
    const file = `${pack.manifest.id}.pack.json`;
    packs.push({ file, pack });
    report.packs.push({ file, sha256: sha256(bytes), bytes: Buffer.byteLength(bytes), entryCount: batch.length });
    batch = [];
  };
  for (const entry of entries) {
    let candidate;
    try { candidate = makePack([...batch, entry]); } catch (error) {
      if (!batch.length) throw error;
      saveBatch(); candidate = makePack([entry]);
    }
    if (batch.length && (batch.length >= maxPackEntries || Buffer.byteLength(serialized(candidate)) > maxPackBytes)) {
      saveBatch(); candidate = makePack([entry]);
    }
    if (Buffer.byteLength(serialized(candidate)) > maxPackBytes) throw new Error(`单段 ${entry.id} 超过分包字节限额`);
    batch.push(entry);
  }
  if (batch.length) saveBatch();
  return { report, packs };
}

async function readCache(file) {
  try {
    const raw = await readFile(file);
    if (raw.byteLength > MAX_RESPONSE_BYTES * 2) throw new Error('缓存文件过大');
    return JSON.parse(raw.toString('utf8'));
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function writeCache(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(value), { flag: 'wx' });
  await rename(temporary, file);
}

function validateRights(snapshot) {
  const rights = snapshot?.response?.query?.rightsinfo;
  if (!stamp(snapshot?.retrievedAt) || snapshot.responseSha256 !== sha256(JSON.stringify(snapshot.response)) || !rights || !/^https:\/\/creativecommons\.org\/licenses\/by-sa\/4\.0\/(?:deed\.[a-z-]+)?$/.test(rights.url)) throw new Error('未确认站点 CC BY-SA 4.0 许可，停止采集');
  return rights;
}

export async function collect(config, { outDir, cacheDir, refresh = false, offline = false, request = requestJSON } = {}) {
  validateConfig(config);
  if (refresh && offline) throw new Error('--refresh 与 --offline 不能同时使用');
  await mkdir(cacheDir, { recursive: true });
  await mkdir(outDir, { recursive: true });
  for (const name of ['report.json', 'acceptance.json']) {
    try { await access(join(outDir, name)); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    throw new Error('输出目录已有报告；请使用新的目录，避免覆盖上一批证据');
  }
  const rightsFile = join(cacheDir, 'siteinfo.json');
  let rights = refresh ? null : await readCache(rightsFile);
  if (!rights) {
    if (offline) throw new Error('离线模式缺少站点许可证据');
    const response = await request({ meta: 'siteinfo', siprop: 'rightsinfo' });
    rights = { retrievedAt: new Date().toISOString(), responseSha256: sha256(JSON.stringify(response)), response };
    validateRights(rights);
    await writeCache(rightsFile, rights);
  }
  validateRights(rights);
  const snapshots = [];
  let stoppedReason;
  for (const [index, spec] of config.articles.entries()) {
    if (stoppedReason) { snapshots.push({ failure: `整批已停止，未请求：${stoppedReason}` }); continue; }
    try {
      const file = join(cacheDir, `${sha256(spec.title)}.json`);
      let snapshot = refresh ? null : await readCache(file);
      const cached = Boolean(snapshot);
      if (!snapshot) {
        if (offline) throw new Error('离线模式缺少此条缓存');
        const response = await request({ titles: spec.title, redirects: '1', converttitles: '1', prop: 'extracts|revisions|pageprops',
          explaintext: '1', exsectionformat: 'plain', exlimit: '1', rvprop: 'ids|timestamp', rvlimit: '1', ppprop: 'disambiguation' });
        snapshot = { schemaVersion: 1, requestedTitle: spec.title, retrievedAt: new Date().toISOString(), responseSha256: sha256(JSON.stringify(response)), response };
        validateSnapshot(snapshot, spec.title);
        await writeCache(file, snapshot);
      }
      validateSnapshot(snapshot, spec.title);
      snapshots.push(snapshot);
      console.log(`[${index + 1}/${config.articles.length}] ${cached ? '缓存' : '采集'} ${spec.title}`);
    } catch (error) {
      snapshots.push({ failure: error.message });
      console.error(`[${index + 1}/${config.articles.length}] 失败 ${spec.title}: ${error.message}`);
      if (error.stopBatch) stoppedReason = error.message;
    }
  }
  const { report, packs } = buildCollection(config, snapshots);
  report.rightsEvidence = rights;
  for (const { file, pack } of packs) await writeFile(join(outDir, file), `${JSON.stringify(pack)}\n`, { flag: 'wx' });
  await writeFile(join(outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  if (report.status !== 'passed') throw new Error(`${report.failures.length} 条失败，未发布任何资料包；成功项已缓存，修正清单后用新的输出目录续跑`);
  console.log(`完成：${report.articles.length} 篇，${report.packs.reduce((sum, pack) => sum + pack.entryCount, 0)} 段，${packs.length} 个包。请运行 npm run corpus:verify -- ${outDir}`);
  return report;
}

async function main() {
  const args = process.argv.slice(2);
  const options = { config: 'corpus/wikipedia-zh-starter.json', cache: 'corpus/.cache/wikipedia-zh' };
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === '--help') {
      console.log('node scripts/collect-wikipedia.mjs --out OUTPUT [--config CONFIG.json] [--cache DIR] [--refresh | --offline]\nNode.js 24+；只采集清单中明确列出的中文维基百科条目。默认复用缓存，--refresh 更新，--offline 完全不联网。');
      return;
    }
    if (['--refresh', '--offline'].includes(key)) options[key.slice(2)] = true;
    else if (['--config', '--out', '--cache'].includes(key) && args[i + 1] && !args[i + 1].startsWith('--')) options[key.slice(2)] = args[++i];
    else throw new Error(`未知或缺值参数：${key}`);
  }
  if (!options.out) throw new Error('请用 --out 指定新的输出目录；--help 查看用法');
  const config = JSON.parse(await readFile(resolve(options.config), 'utf8'));
  await collect(config, { outDir: resolve(options.out), cacheDir: resolve(options.cache), refresh: options.refresh, offline: options.offline });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
