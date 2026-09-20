import type { SearchResult } from '../core/types.js';
import type { PhoneStorage } from './storage.js';

export const ONLINE_CACHE_KEY = 'webcache:wikipedia-zh:v1';
export const ONLINE_CACHE_MAX_PAGES = 20;
export const ONLINE_CACHE_MAX_BYTES = 10 * 1024 * 1024;
export type OnlineCacheStorage = Pick<PhoneStorage, 'getValue' | 'setValue'>;
export interface CachedOnlinePage {
  schemaVersion: 1; path: string; aliases: string[]; result: SearchResult; content: string;
  fetchedAt: string; url: string; revision: number; source: string;
}
interface CacheData { schemaVersion: 1; pages: CachedOnlinePage[]; }

export function normalizedTerm(text: string): string {
  return text.normalize('NFKC').replace(/_/g, ' ').trim().toLocaleLowerCase('zh');
}

/** Plain text only: source markup is never inserted into the host DOM. */
export function sourceText(html: string): string {
  const plain = html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<[^>]*>/g, ' ').replace(/&#(x[0-9a-f]+|\d+);/gi, (_match, digits: string) => {
      const code = digits[0].toLowerCase() === 'x' ? parseInt(digits.slice(1), 16) : Number(digits);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    });
  return plain.replace(/&(nbsp|amp|lt|gt|quot|apos);/g, (_match, entity: string) =>
    ({ nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[entity] ?? ''))
    .replace(/\s+/g, ' ').trim();
}

export function cachedResult(page: CachedOnlinePage): SearchResult {
  return { ...page.result, reason: '已读原文缓存', entry: { ...page.result.entry,
    source: { ...page.result.entry.source, kind: 'cache' },
    metadata: { ...page.result.entry.metadata, fetchedAt: page.fetchedAt, cached: '1' },
  } };
}

/** A bounded value in the existing extension database; only successfully read pages enter it. */
export class OnlineCache {
  private writes: Promise<unknown> = Promise.resolve();
  constructor(private readonly storage: OnlineCacheStorage) {}

  async list(): Promise<CachedOnlinePage[]> {
    await this.writes.catch(() => undefined);
    const saved = await this.storage.getValue<CacheData>(ONLINE_CACHE_KEY);
    if (saved?.schemaVersion !== 1 || !Array.isArray(saved.pages)) return [];
    return saved.pages.filter(page => page?.schemaVersion === 1 && typeof page.path === 'string'
      && typeof page.content === 'string' && page.result?.packId === 'online:wikipedia-zh')
      .slice(0, ONLINE_CACHE_MAX_PAGES);
  }

  async get(path: string): Promise<CachedOnlinePage | undefined> {
    const key = normalizedTerm(path);
    return (await this.list()).find(page => [page.path, ...page.aliases].some(value => normalizedTerm(value) === key));
  }

  put(page: CachedOnlinePage): Promise<boolean> {
    const operation = this.writes.catch(() => undefined).then(async () => {
      const encoder = new TextEncoder();
      if (encoder.encode(JSON.stringify(page)).length > ONLINE_CACHE_MAX_BYTES) return false;
      const saved = await this.storage.getValue<CacheData>(ONLINE_CACHE_KEY);
      const prior = saved?.schemaVersion === 1 && Array.isArray(saved.pages) ? saved.pages : [];
      const pages = [page, ...prior.filter(item => item.path !== page.path)].slice(0, ONLINE_CACHE_MAX_PAGES);
      while (encoder.encode(JSON.stringify({ schemaVersion: 1, pages })).length > ONLINE_CACHE_MAX_BYTES) pages.pop();
      if (!pages.length) return false;
      await this.storage.setValue(ONLINE_CACHE_KEY, { schemaVersion: 1, pages } satisfies CacheData);
      return true;
    });
    this.writes = operation;
    return operation;
  }

  async search(query: string, limit = 12): Promise<SearchResult[]> {
    const term = normalizedTerm(query);
    if (!term) return [];
    const ranked = (await this.list()).map(page => {
      const titles = [page.path, ...page.aliases].map(normalizedTerm);
      const score = titles.includes(term) ? 1000 : titles.some(title => title.includes(term)) ? 500
        : normalizedTerm(sourceText(page.content)).includes(term) ? 100 : 0;
      return { ...cachedResult(page), score };
    });
    return ranked.filter(item => item.score > 0).sort((a, b) => b.score - a.score).slice(0, limit);
  }
}
