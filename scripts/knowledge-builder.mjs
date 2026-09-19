import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildDocument, MAX_PACK_BYTES, parsePack } from '../dist/library/pack.js';

/** Source format: { manifest, entries: [{ ...KnowledgeEntry, content: 'plain text' }] }. */
export function buildPack(source) {
  if (!source || typeof source !== 'object' || !Array.isArray(source.entries)) throw new Error('资料源必须包含 manifest 和 entries');
  const entries = [];
  const content = {};
  const documents = {};
  for (const raw of source.entries) {
    if (!raw || typeof raw !== 'object' || typeof raw.content !== 'string') throw new Error('每条资料必须提供 content 纯文本正文');
    const { content: body, ...entry } = raw;
    if (typeof entry.id !== 'string' || typeof entry.contentRef !== 'string') throw new Error('每条资料必须提供 id 和 contentRef');
    if (['__proto__', 'constructor', 'prototype'].includes(entry.id) || ['__proto__', 'constructor', 'prototype'].includes(entry.contentRef)) throw new Error('条目含保留 ID');
    if (Object.hasOwn(content, entry.contentRef) || Object.hasOwn(documents, entry.id)) throw new Error('资料源含重复 ID 或正文引用');
    entries.push(entry);
    content[entry.contentRef] = body;
    documents[entry.id] = buildDocument(entry, body);
  }
  return parsePack({ schemaVersion: 1, manifest: { ...source.manifest, entryCount: entries.length },
    entries, index: { schemaVersion: 1, documents }, content });
}

async function main() {
  const [, , inputPath, outputPath] = process.argv;
  if (!inputPath || !outputPath) throw new Error('用法：node scripts/knowledge-builder.mjs 本地资料.source.json 输出.pack.json（先运行 build）');
  if (/^[a-z]+:\/\//i.test(inputPath) || /^[a-z]+:\/\//i.test(outputPath)) throw new Error('此工具仅处理本地文件；不抓取远程资料');
  const sourcePath = resolve(inputPath);
  const destinationPath = resolve(outputPath);
  if (sourcePath.toLocaleLowerCase() === destinationPath.toLocaleLowerCase()) throw new Error('输出文件不能覆盖原始资料源');
  const raw = await readFile(sourcePath);
  if (raw.byteLength > MAX_PACK_BYTES) throw new Error('资料源超过 10 MB 限制');
  const pack = buildPack(JSON.parse(raw.toString('utf8')));
  const serialized = JSON.stringify(pack);
  if (Buffer.byteLength(serialized) > MAX_PACK_BYTES) throw new Error('生成包超过 10 MB 限制');
  await mkdir(dirname(destinationPath), { recursive: true });
  await writeFile(destinationPath, `${serialized}\n`, { encoding: 'utf8', flag: 'wx' });
  process.stdout.write(`已生成 ${destinationPath}，${pack.entries.length} 条原创或用户提供资料。\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
