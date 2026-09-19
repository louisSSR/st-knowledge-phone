import { mkdir, mkdtemp, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { collect, validateConfig } from './collect-wikipedia.mjs';
import { verifyCollection } from './verify-collection.mjs';

const writeJSON = (file, value) => writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
const pendingReason = /下载失败|网络|HTTP\s*\d|离线模式缺少|整批已停止|未请求|来源要求.*等待|来源拒绝/;

/** Classify incomplete acquisition separately from content rejected by validation. */
export function partitionFailures(config, report) {
  if (report?.schemaVersion !== 1 || !['passed', 'failed'].includes(report.status) || report.requested !== config.articles.length || !Array.isArray(report.failures)) {
    throw new Error('采集报告请求数或失败清单不完整，不能筛选成功项');
  }
  const known = new Set(config.articles.map(item => item.title));
  const failed = new Set();
  const quarantined = [], pending = [];
  for (const failure of report.failures) {
    if (!failure || !known.has(failure.title) || typeof failure.reason !== 'string' || !failure.reason) throw new Error('失败清单含未知标题或缺失原因');
    failed.add(failure.title);
    (failure.pending || pendingReason.test(failure.reason) ? pending : quarantined).push({ title: failure.title, reason: failure.reason });
  }
  if ((report.status === 'passed') !== (report.failures.length === 0)) throw new Error('采集状态与失败清单不一致');
  // These are candidates, not accepted results: offline collection and independent
  // verification below must both pass before any candidate counts as accepted.
  return { candidates: config.articles.filter(item => !failed.has(item.title)), quarantined, pending };
}

/** Run a bounded allowlist, preserve failures, and expose only verified packs. */
export async function harvest(config, {
  outDir, cacheDir = 'corpus/.cache/wikipedia-zh', concurrency = 1, offline = false,
  collectImpl = collect, verifyImpl = verifyCollection,
} = {}) {
  validateConfig(config);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 3) throw new Error('并发数必须为 1–3');
  const started = performance.now();
  const generatedAt = new Date().toISOString();
  let root;
  if (outDir) {
    root = resolve(outDir);
    await mkdir(dirname(root), { recursive: true });
    await mkdir(root); // Never merge with or overwrite a previous batch.
  } else {
    const base = resolve('corpus/output');
    await mkdir(base, { recursive: true });
    root = await mkdtemp(join(base, `${config.id}-${generatedAt.replace(/[:.]/g, '-')}-`));
  }
  const receipt = {
    schemaVersion: 1, status: 'failed', generatedAt, batchDirectory: root,
    counts: { requested: config.articles.length, accepted: 0, articles: 0, duplicates: 0, quarantined: 0, pending: 0, packs: 0, entries: 0 },
    quarantined: [], pending: [], metrics: { concurrency, durationMs: 0 }, readyDirectory: null,
    limitations: ['技术验收覆盖完整性、来源许可和检索，不代表逐条事实正确，也不代表本批已经在酒馆实机验收。'],
  };
  await writeJSON(join(root, 'requested-config.json'), config);
  const rawDir = join(root, 'raw');
  try {
    let report, collectionError;
    try { report = await collectImpl(config, { outDir: rawDir, cacheDir: resolve(cacheDir), concurrency, offline }); }
    catch (error) {
      collectionError = error;
      try { report = JSON.parse(await readFile(join(rawDir, 'report.json'), 'utf8')); }
      catch { throw error; }
    }
    if (collectionError && report.status === 'passed') throw collectionError;
    const { candidates, quarantined, pending } = partitionFailures(config, report);
    receipt.quarantined = quarantined;
    receipt.pending = pending;
    receipt.counts.quarantined = quarantined.length;
    receipt.counts.pending = pending.length;
    receipt.metrics.collection = report.metrics ?? null;
    if (report.stoppedReason) receipt.stoppedReason = report.stoppedReason;
    await writeJSON(join(root, 'quarantine.json'), { schemaVersion: 1, quarantined, pending });
    if (!candidates.length) throw new Error('本批没有可验收候选项；请查看隔离和待重试清单');
    let verifyDir = rawDir;
    if (report.status !== 'passed') {
      const acceptedConfig = { ...config, articles: candidates };
      await writeJSON(join(root, 'candidate-config.json'), acceptedConfig);
      verifyDir = join(root, 'candidate');
      // Never make additional network requests to rescue a partially failed batch.
      report = await collectImpl(acceptedConfig, { outDir: verifyDir, cacheDir: resolve(cacheDir), concurrency, offline: true });
      if (report.status !== 'passed' || report.failures?.length) throw new Error('候选项离线重新建包失败');
    }
    const acceptance = await verifyImpl(verifyDir);
    if (acceptance?.status !== 'passed') {
      receipt.verificationFailures = acceptance?.failures ?? ['验收没有返回通过状态'];
      throw new Error('独立技术验收失败，未提供 ready 资料包');
    }
    const summary = acceptance.summary;
    if (report.requested !== candidates.length || !Array.isArray(report.articles) || !Array.isArray(report.duplicates)
      || candidates.length !== report.articles.length + report.duplicates.length
      || summary?.articles !== report.articles.length || summary?.packs !== report.packs?.length
      || summary?.entries !== report.packs.reduce((sum, pack) => sum + pack.entryCount, 0)) {
      throw new Error('验收数量与原请求、采集报告不一致');
    }
    await rename(verifyDir, join(root, 'ready'));
    receipt.readyDirectory = join(root, 'ready');
    Object.assign(receipt.counts, { accepted: candidates.length, articles: summary.articles, duplicates: report.duplicates.length, packs: summary.packs, entries: summary.entries });
    receipt.status = quarantined.length || pending.length ? 'partial' : 'passed';
  } catch (error) {
    receipt.error = error instanceof Error ? error.message : String(error);
  }
  receipt.metrics.durationMs = Math.round(performance.now() - started);
  await writeJSON(join(root, 'receipt.json'), receipt);
  return receipt;
}

export function parseArgs(args) {
  const options = { config: 'corpus/wikipedia-zh-general.json', cache: 'corpus/.cache/wikipedia-zh', concurrency: 1, offline: false };
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (key === '--help') return { help: true };
    if (key === '--offline') options.offline = true;
    else if (['--config', '--out', '--cache', '--concurrency'].includes(key) && args[index + 1] && !args[index + 1].startsWith('--')) options[key.slice(2)] = args[++index];
    else throw new Error(`未知或缺值参数：${key}`);
  }
  options.concurrency = Number(options.concurrency);
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 3) throw new Error('并发数必须为 1–3');
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log('node scripts/harvest-wikipedia.mjs [--config CONFIG.json] [--out NEW_DIRECTORY] [--cache CACHE_DIRECTORY] [--concurrency 1|2|3] [--offline]\n默认采集 100 篇明确列出的中文百科，自动复用缓存、隔离失败项、分包并验收。默认并发 1，显式 --concurrency 3 可加速，仍受来源限流约束。输出默认放 corpus/output/ 唯一批次目录；ready/ 只在技术验收通过后生成。不会自动导入酒馆、上传或调用模型。退出码：0 全部通过，2 部分通过（含隔离/待重试），1 失败。');
    return;
  }
  const config = JSON.parse(await readFile(resolve(options.config), 'utf8'));
  const receipt = await harvest(config, { outDir: options.out, cacheDir: options.cache, concurrency: options.concurrency, offline: options.offline });
  const n = receipt.counts;
  console.log(`${receipt.status === 'passed' ? '全部技术验收通过' : receipt.status === 'partial' ? '部分技术验收通过' : '本批失败'}：请求 ${n.requested} / 验收 ${n.accepted} / 隔离 ${n.quarantined} / 待重试 ${n.pending}；${n.articles} 篇、${n.entries} 段、${n.packs} 个包；耗时 ${(receipt.metrics.durationMs / 1000).toFixed(1)} 秒。`);
  if (receipt.readyDirectory) console.log(`可导入：${receipt.readyDirectory}/*.pack.json`);
  if (receipt.error) console.error(receipt.error);
  console.log(`完整回执：${join(receipt.batchDirectory, 'receipt.json')}`);
  process.exitCode = receipt.status === 'passed' ? 0 : receipt.status === 'partial' ? 2 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
