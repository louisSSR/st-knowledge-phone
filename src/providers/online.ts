import type { SearchProvider, SearchRequest, SearchResponse, SearchResult } from '../core/types.js';
import { OnlineCache, cachedResult, normalizedTerm, sourceText, type OnlineCacheStorage } from '../library/online-cache.js';

export const ONLINE_PACK_ID = 'online:wikipedia-zh';
export const ONLINE_SOURCE_ID = 'wikipedia-zh';
export const ONLINE_API_URL = 'https://zh.wikipedia.org/w/api.php';
export const ONLINE_LICENSE_URL = 'https://creativecommons.org/licenses/by-sa/4.0/';
const MAX_RESULTS = 12;
const TIMEOUT_MS = 8000;
const MAX_RESPONSE_BYTES = 12 * 1024 * 1024;
interface WikiHit { title: string; pageid?: number; snippet?: string; timestamp?: string; lastrevid?: number; missing?: boolean; invalid?: boolean; ns?: number; }
interface WikiResponse {
  error?: { code?: string; info?: string };
  query?: { search?: WikiHit[]; pages?: WikiHit[]; searchinfo?: { suggestion?: string } };
  parse?: { title: string; pageid: number; revid: number; text: string; displaytitle?: string; links?: unknown[]; tocdata?: unknown };
}
export interface OnlineRead { result: SearchResult; content: string; cached: boolean; notice?: string; }
export interface OnlineProviderOptions { fetch?: typeof fetch; now?: () => number; timeoutMs?: number; }

export function normalizeOnlinePath(input: string): string {
  const raw = input.trim();
  if (!raw || raw.length > 1200) throw new Error('词条地址无效');
  let title = raw;
  if (/^(?:https?:\/\/|\/\/|\/wiki\/|\/w\/index\.php)/i.test(raw)) {
    const url = new URL(raw, 'https://zh.wikipedia.org');
    if (url.origin !== 'https://zh.wikipedia.org' || url.username || url.password) throw new Error('此链接不属于中文维基百科');
    if (url.pathname.startsWith('/wiki/')) title = decodeURIComponent(url.pathname.slice(6));
    else if (url.pathname === '/w/index.php') title = url.searchParams.get('title') ?? '';
    else throw new Error('此链接不是词条页面');
  } else {
    if (/^[a-z][a-z\d+.-]*:\/\//i.test(raw) || /^(?:javascript|data|file|blob):/i.test(raw)) throw new Error('词条地址无效');
    title = raw.replace(/^\.\//, '').split('#')[0];
    try { title = decodeURIComponent(title); } catch { /* Plain text percent signs can be part of a title. */ }
  }
  title = title.replace(/_/g, ' ').trim();
  if (!title || /[\u0000-\u001f|]/.test(title)) throw new Error('词条地址无效');
  return title;
}

function canonicalUrl(title: string): string {
  return `https://zh.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`;
}

function queryTerm(query: string): string {
  return query.trim().slice(0, 200).replace(/[?？。！!]+$/g, '')
    .replace(/^(?:请问|請問)\s*/, '').replace(/^(?:什么是|什麼是)\s*/, '')
    .replace(/(?:是什么意思|是什麼意思|怎么玩|怎麼玩|的规则|的規則)\s*$/g, '').trim();
}

function resultFromHit(hit: WikiHit, fetchedAt: string, score: number, reason: string): SearchResult {
  return { packId: ONLINE_PACK_ID, packName: '中文维基百科', score, reason, entry: {
    id: hit.title, type: 'article', title: hit.title, aliases: [], summary: sourceText(hit.snippet ?? ''),
    contentRef: hit.title, tags: [], location: [], dates: {},
    source: { name: '中文维基百科', url: canonicalUrl(hit.title), updatedAt: hit.timestamp ?? '', license: 'CC BY-SA 4.0', kind: 'online' },
    metadata: { online: ONLINE_SOURCE_ID, fetchedAt, revision: hit.lastrevid ?? 0, pageId: hit.pageid ?? 0,
      canonicalUrl: canonicalUrl(hit.title), licenseUrl: ONLINE_LICENSE_URL },
  } };
}

function aborted(): DOMException { return new DOMException('查询已取消', 'AbortError'); }

export class OnlineProvider implements SearchProvider {
  readonly id = ONLINE_SOURCE_ID;
  readonly name = '中文维基百科 · 联网';
  readonly cache: OnlineCache;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private pending = new Set<AbortController>();
  private generation = 0;
  private disposed = false;
  private retryAfter = 0;

  constructor(storage: OnlineCacheStorage, options: OnlineProviderOptions = {}) {
    this.cache = new OnlineCache(storage);
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  }

  async isAvailable(): Promise<boolean> { return !this.disposed; }
  cancelSearch(): void { this.generation++; for (const controller of this.pending) controller.abort(); this.pending.clear(); }
  pause(): void { this.cancelSearch(); }
  dispose(): void { this.disposed = true; this.cancelSearch(); }

  private async api(parameters: Record<string, string>): Promise<WikiResponse> {
    if (this.disposed) throw aborted();
    if (this.now() < this.retryAfter) throw new Error('来源暂时限流，请稍后重试');
    const controller = new AbortController();
    this.pending.add(controller);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.timeoutMs);
    const url = new URL(ONLINE_API_URL);
    url.search = new URLSearchParams({ ...parameters, format: 'json', formatversion: '2', origin: '*' }).toString();
    try {
      const response = await this.fetcher(url, { signal: controller.signal, credentials: 'omit', referrerPolicy: 'no-referrer',
        headers: { 'Api-User-Agent': 'st-knowledge-phone/0.3 (https://github.com/louisSSR/st-knowledge-phone)' } });
      if (response.status === 429 || response.status === 503) {
        const wait = response.headers.get('Retry-After');
        const seconds = Number(wait);
        const until = wait ? Date.parse(wait) : NaN;
        this.retryAfter = wait && Number.isFinite(seconds) ? this.now() + Math.max(1, seconds) * 1000
          : Number.isFinite(until) ? Math.max(this.now() + 1000, until) : this.now() + 60_000;
      }
      if (!response.ok) throw new Error(`来源返回 HTTP ${response.status}`);
      const text = await response.text();
      if (new TextEncoder().encode(text).length > MAX_RESPONSE_BYTES) throw new Error('来源页面过大，请在原站阅读');
      const data = JSON.parse(text) as WikiResponse;
      if (data.error) throw new Error(`来源读取失败：${data.error.info ?? data.error.code ?? '未知错误'}`);
      return data;
    } catch (error) {
      if (timedOut) throw new Error('中文维基百科连接超时（8 秒），请检查网络后重试');
      if (controller.signal.aborted) throw aborted();
      throw error;
    } finally { clearTimeout(timer); this.pending.delete(controller); }
  }

  async search(request: SearchRequest): Promise<SearchResponse> {
    const query = queryTerm(request.query);
    if (!query || (request.types?.length && !request.types.includes('article'))) return { results: [], total: 0, suggestions: [] };
    if (request.context.strictTimeline) return { results: [], total: 0, suggestions: [], notice: '联网来源是当前版本，未经历史版本核验；严格剧情模式下不展示。日常科普可使用科普模式。' };
    const generation = this.generation;
    try {
      const [searched, exact] = await Promise.allSettled([
        this.api({ action: 'query', list: 'search', srsearch: query, srlimit: String(MAX_RESULTS), srprop: 'timestamp|snippet', srinfo: 'suggestion' }),
        query.includes('|') ? Promise.resolve({} as WikiResponse) : this.api({ action: 'query', titles: query, redirects: '1', converttitles: '1', prop: 'info' }),
      ]);
      if (generation !== this.generation || this.disposed) throw aborted();
      if (searched.status === 'rejected') throw searched.reason;
      if (!Array.isArray(searched.value.query?.search)) throw new Error('来源没有返回有效搜索结果');
      return this.searchResponse(searched.value, exact.status === 'fulfilled' ? exact.value : undefined, request, query);
    } catch (error) {
      if (generation !== this.generation || this.disposed || (error instanceof DOMException && error.name === 'AbortError')) throw aborted();
      let results: SearchResult[] = [];
      try { results = await this.cache.search(query, MAX_RESULTS); } catch { /* The network failure remains useful when storage is also unavailable. */ }
      if (generation !== this.generation || this.disposed) throw aborted();
      const detail = error instanceof Error ? error.message : '网络不可用';
      return { results, total: results.length, suggestions: [], notice: `联网查询失败：${detail}。${results.length ? '以下仅为已读原文缓存，不是实时结果。' : '没有匹配的已读缓存；请检查网络后重试。'}` };
    }
  }

  private searchResponse(searched: WikiResponse, exact: WikiResponse | undefined, request: SearchRequest, query: string): SearchResponse {
    const timestamp = new Date(this.now()).toISOString();
    const hit = exact?.query?.pages?.find(page => !page.missing && !page.invalid && (page.ns ?? 0) === 0 && page.pageid);
    const hits = searched.query?.search ?? [];
    const results = hits.map((page, index) => resultFromHit(page, timestamp, 500 - index,
      normalizedTerm(page.title) === normalizedTerm(query) ? '标题精确匹配 · 来源检索' : '来源全文检索'));
    if (hit) {
      const existing = results.find(result => result.entry.metadata.pageId === hit.pageid || result.entry.title === hit.title);
      if (existing) { existing.score = 1000; existing.reason = '标题或来源重定向精确匹配'; existing.entry.metadata.revision = hit.lastrevid ?? 0; }
      else results.unshift(resultFromHit(hit, timestamp, 1000, '标题或来源重定向精确匹配'));
      const result = results.find(row => row.entry.title === hit.title);
      if (result && result.entry.title !== query) result.entry.aliases = [query];
    }
    results.sort((a, b) => b.score - a.score);
    const unique = [...new Map(results.map(result => [result.entry.title, result])).values()].slice(0, MAX_RESULTS);
    const offset = Math.max(0, request.offset ?? 0), limit = Math.min(MAX_RESULTS, Math.max(1, request.limit ?? 10));
    return { results: unique.slice(offset, offset + limit), total: unique.length,
      suggestions: searched.query?.searchinfo?.suggestion ? [sourceText(searched.query.searchinfo.suggestion)] : [],
      notice: `联网检索中文维基百科，最多展示 ${MAX_RESULTS} 条来源结果；未核验历史版本。` };
  }

  async read(input: string | SearchResult): Promise<OnlineRead> {
    const path = normalizeOnlinePath(typeof input === 'string' ? input : input.entry.contentRef);
    const generation = this.generation;
    if (typeof input !== 'string' && input.entry.source.kind === 'cache') {
      const cached = await this.cache.get(path);
      if (generation !== this.generation || this.disposed) throw aborted();
      if (cached) return { result: cachedResult(cached), content: cached.content, cached: true, notice: '正在阅读已读原文缓存。' };
    }
    try {
      const data = await this.api({ action: 'parse', page: path, redirects: '1', prop: 'text|displaytitle|revid|links|tocdata' });
      if (generation !== this.generation || this.disposed) throw aborted();
      const page = data.parse;
      if (!page || typeof page.text !== 'string' || !page.text.trim() || !page.title || !Number.isSafeInteger(page.revid)) throw new Error('来源没有返回完整词条正文');
      const fetchedAt = new Date(this.now()).toISOString();
      const result = resultFromHit({ title: page.title, pageid: page.pageid, lastrevid: page.revid,
        timestamp: typeof input === 'string' ? undefined : input.entry.source.updatedAt }, fetchedAt, 1000, '来源原文');
      result.entry.summary = sourceText(page.text).slice(0, 240);
      result.entry.aliases = [...new Set([path, ...(typeof input === 'string' ? [] : input.entry.aliases)])]
        .filter(alias => alias !== page.title);
      result.entry.source.url = `https://zh.wikipedia.org/w/index.php?title=${encodeURIComponent(page.title)}&oldid=${page.revid}`;
      result.entry.metadata.revisionUrl = result.entry.source.url;
      let notice: string | undefined;
      try {
        const saved = await this.cache.put({ schemaVersion: 1, path: page.title, aliases: result.entry.aliases, result,
          content: page.text, fetchedAt, url: result.entry.source.url, revision: page.revid, source: ONLINE_SOURCE_ID });
        if (!saved) notice = '原文已读取；页面超过本地缓存预算，本次未保存。';
      } catch { notice = '原文已读取，但浏览器未能保存离线缓存。'; }
      if (generation !== this.generation || this.disposed) throw aborted();
      return { result, content: page.text, cached: false, notice };
    } catch (error) {
      if (generation !== this.generation || this.disposed || (error instanceof DOMException && error.name === 'AbortError')) throw aborted();
      const cached = await this.cache.get(path).catch(() => undefined);
      if (generation !== this.generation || this.disposed) throw aborted();
      if (!cached) throw error;
      return { result: cachedResult(cached), content: cached.content, cached: true,
        notice: '联网读取失败，正在显示已读原文缓存；内容不是实时版本。' };
    }
  }
}
