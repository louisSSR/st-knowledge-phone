export const MAX_PACK_BYTES = 10 * 1024 * 1024;
export const MAX_PACK_ENTRIES = 5000;
export const ENTRY_TYPES = ['game_rule', 'historical_event', 'sports_match', 'store', 'brand', 'product', 'person', 'place', 'article'];
const DATE_KEYS = ['occurredAt', 'publishedAt', 'knownFrom', 'validFrom', 'validUntil'];
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
function record(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error(`${label} 必须是对象`);
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
        throw new Error(`${label} 必须是普通 JSON 对象`);
    if (Object.keys(value).some(key => FORBIDDEN_KEYS.has(key)))
        throw new Error(`${label} 含保留字段`);
    return value;
}
function fields(value, allowed, label) {
    if (Object.keys(value).some(key => !allowed.includes(key)))
        throw new Error(`${label} 含不支持字段`);
}
function text(value, label, max = 500, empty = false) {
    if (typeof value !== 'string' || value.length > max || (!empty && !value.trim()) || value.includes('\0')) {
        throw new Error(`${label} 必须是有效文本（最多 ${max} 字符）`);
    }
    return value;
}
function identifier(value, label) {
    const result = text(value, label, 100);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(result) || FORBIDDEN_KEYS.has(result))
        throw new Error(`${label} 格式无效`);
    return result;
}
export function isDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000'))
        return false;
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
function date(value, label) {
    const result = text(value, label, 10);
    if (!isDate(result))
        throw new Error(`${label} 必须是有效 YYYY-MM-DD 日期`);
    return result;
}
function strings(value, label, max = 40) {
    if (!Array.isArray(value) || value.length > max)
        throw new Error(`${label} 必须是文本数组（最多 ${max} 项）`);
    return value.map(item => text(item, label, 200));
}
function sourceInfo(input) {
    const value = record(input, 'source');
    fields(value, ['name', 'url', 'updatedAt', 'license', 'kind'], 'source');
    if (value.kind !== 'offline')
        throw new Error('仅支持 offline 来源');
    let url;
    if (value.url !== undefined) {
        url = text(value.url, 'source.url', 2048);
        if (!/^https?:\/\//i.test(url))
            throw new Error('来源网址仅允许 HTTP(S)');
        try {
            new URL(url);
        }
        catch {
            throw new Error('来源网址格式无效');
        }
    }
    return { name: text(value.name, 'source.name'), updatedAt: date(value.updatedAt, 'source.updatedAt'),
        license: text(value.license, 'source.license', 2000), kind: 'offline', ...(url ? { url } : {}) };
}
function entry(input) {
    const value = record(input, 'entry');
    fields(value, ['id', 'type', 'title', 'aliases', 'summary', 'contentRef', 'tags', 'location', 'dates', 'source', 'metadata'], 'entry');
    if (!ENTRY_TYPES.includes(value.type))
        throw new Error('不支持的条目类型');
    const inputDates = record(value.dates, 'dates');
    fields(inputDates, DATE_KEYS, 'dates');
    const dates = {};
    for (const key of DATE_KEYS)
        if (inputDates[key] !== undefined)
            dates[key] = date(inputDates[key], `dates.${key}`);
    if (dates.validFrom && dates.validUntil && dates.validFrom > dates.validUntil)
        throw new Error('有效期起点不能晚于终点');
    const inputMetadata = record(value.metadata, 'metadata');
    if (Object.keys(inputMetadata).length > 40)
        throw new Error('metadata 字段过多');
    const metadata = {};
    for (const [key, item] of Object.entries(inputMetadata)) {
        text(key, 'metadata key', 100);
        if (typeof item === 'number' && Number.isFinite(item))
            metadata[key] = item;
        else if (Array.isArray(item))
            metadata[key] = strings(item, 'metadata');
        else
            metadata[key] = text(item, 'metadata', 2000, true);
    }
    return { id: identifier(value.id, 'entry.id'), type: value.type, title: text(value.title, 'title'),
        aliases: strings(value.aliases, 'aliases'), summary: text(value.summary, 'summary', 4000),
        contentRef: identifier(value.contentRef, 'contentRef'), tags: strings(value.tags, 'tags'),
        location: strings(value.location, 'location', 8), dates, source: sourceInfo(value.source), metadata };
}
function manifest(input) {
    const value = record(input, 'manifest');
    fields(value, ['schemaVersion', 'id', 'name', 'version', 'description', 'entryCount', 'license', 'createdAt'], 'manifest');
    if (value.schemaVersion !== 1)
        throw new Error('不支持的 manifest schemaVersion');
    if (!Number.isInteger(value.entryCount) || Number(value.entryCount) < 1 || Number(value.entryCount) > MAX_PACK_ENTRIES) {
        throw new Error(`知识包需包含 1–${MAX_PACK_ENTRIES} 个条目`);
    }
    return { schemaVersion: 1, id: identifier(value.id, 'manifest.id'), name: text(value.name, 'manifest.name'),
        version: text(value.version, 'manifest.version', 60), description: text(value.description, 'manifest.description', 4000),
        entryCount: Number(value.entryCount), license: text(value.license, 'manifest.license', 2000),
        createdAt: date(value.createdAt, 'manifest.createdAt') };
}
export function normalizeText(value) {
    return value.normalize('NFKC').toLocaleLowerCase('en-US').replace(/\s+/g, ' ').trim();
}
export function buildDocument(item, content) {
    return normalizeText([item.title, ...item.aliases, item.summary, ...item.tags, ...item.location, content].join('\n'));
}
export function parsePack(input) {
    const value = record(input, '知识包');
    let bytes;
    try {
        bytes = new TextEncoder().encode(JSON.stringify(input)).byteLength;
    }
    catch {
        throw new Error('知识包必须可序列化为 JSON');
    }
    if (bytes > MAX_PACK_BYTES)
        throw new Error('知识包超过 10 MB 限制');
    fields(value, ['schemaVersion', 'manifest', 'entries', 'index', 'content'], '知识包');
    if (value.schemaVersion !== 1)
        throw new Error('不支持的知识包 schemaVersion；请先显式迁移');
    const info = manifest(value.manifest);
    if (!Array.isArray(value.entries) || value.entries.length !== info.entryCount)
        throw new Error('条目数量与 manifest 不一致');
    const entries = value.entries.map(entry);
    const index = record(value.index, 'index');
    fields(index, ['schemaVersion', 'documents'], 'index');
    if (index.schemaVersion !== 1)
        throw new Error('不支持的索引 schemaVersion');
    const inputDocuments = record(index.documents, 'index.documents');
    const inputContent = record(value.content, 'content');
    if (Object.keys(inputDocuments).length !== entries.length || Object.keys(inputContent).length !== entries.length) {
        throw new Error('索引、正文与条目数量不一致');
    }
    const documents = {};
    const content = {};
    for (const item of entries) {
        if (Object.hasOwn(documents, item.id) || Object.hasOwn(content, item.contentRef))
            throw new Error('条目 ID 或正文引用重复');
        const body = text(inputContent[item.contentRef], '正文', 1_000_000);
        const document = text(inputDocuments[item.id], '索引正文', 1_050_000);
        if (document !== buildDocument(item, body))
            throw new Error(`条目 ${item.id} 的预建索引与内容不一致`);
        documents[item.id] = document;
        content[item.contentRef] = body;
    }
    return { schemaVersion: 1, manifest: info, entries, index: { schemaVersion: 1, documents }, content };
}
