export type EntryType = 'game_rule' | 'historical_event' | 'sports_match' | 'store' | 'brand' | 'product' | 'person' | 'place' | 'article';
export interface SourceInfo { name: string; url?: string; updatedAt: string; license: string; kind: 'offline'; }
export interface KnowledgeEntry {
  id: string; type: EntryType; title: string; aliases: string[]; summary: string;
  contentRef: string; tags: string[]; location: string[];
  dates: { occurredAt?: string; publishedAt?: string; knownFrom?: string; validFrom?: string; validUntil?: string };
  source: SourceInfo; metadata: Record<string, string | number | string[]>;
}
export interface PackManifest {
  schemaVersion: 1; id: string; name: string; version: string; description: string;
  entryCount: number; license: string; createdAt: string;
}
export interface KnowledgePack {
  schemaVersion: 1; manifest: PackManifest; entries: KnowledgeEntry[];
  index: { schemaVersion: 1; documents: Record<string, string> };
  content: Record<string, string>;
}
export interface SearchContext {
  worldDate: string | null; location: string[]; strictTimeline: boolean; chatKey: string;
}
export interface SearchRequest {
  query: string; context: SearchContext; types?: EntryType[]; offset?: number; limit?: number;
}
export interface SearchResult { entry: KnowledgeEntry; packId: string; packName: string; score: number; }
export interface SearchResponse { results: SearchResult[]; total: number; suggestions: string[]; }
export interface SearchProvider {
  id: string; name: string; isAvailable(): Promise<boolean>;
  search(request: SearchRequest): Promise<SearchResponse>;
}
export interface ContextState {
  schemaVersion: 1; worldDate?: string; location: string[]; recentKeywords: string[]; updatedAt: number;
}
export interface ChatSettings {
  schemaVersion: 1; mode: 'story' | 'custom' | 'modern'; customDate: string;
  location: string; strictTimeline: boolean; context: ContextState;
}
export interface Settings { schemaVersion: 1; theme: string; }
export interface HistoryItem {
  schemaVersion: 1; id: string; query: string; worldDate: string | null; worldline: string;
  source: 'manual'; viewed: string[]; createdAt: number;
}
export interface Bookmark { schemaVersion: 1; key: string; packId: string; entryId: string; createdAt: number; }
export interface HostSnapshot { chatKey: string; messages: string[]; label: string; }
export interface HostAdapter {
  label: string; snapshot(): HostSnapshot;
  subscribe(callback: (kind: 'chat' | 'message' | 'reconcile', snapshot: HostSnapshot) => void): () => void;
  dispose(): void;
}
export interface PhoneState {
  ready: boolean; busy: boolean; notice: string; hostLabel: string; chatKey: string;
  settings: Settings; chat: ChatSettings; context: SearchContext; packs: PackManifest[];
  query: string; types: EntryType[]; results: SearchResult[]; total: number; suggestions: string[];
  page: 'home' | 'search' | 'library' | 'bookmarks' | 'history' | 'settings';
  reader: { result: SearchResult; content: string } | null;
  history: HistoryItem[]; bookmarks: Bookmark[];
}
export interface PhoneController {
  getState(): PhoneState;
  subscribe(callback: (state: PhoneState) => void): () => void;
  navigate(page: PhoneState['page'], offset?: number): Promise<void>;
  search(query: string, types?: EntryType[], offset?: number): Promise<void>;
  read(result: SearchResult): Promise<void>; closeReader(): void;
  install(file: File): Promise<void>; installSample(): Promise<void>; uninstall(id: string): Promise<void>;
  toggleBookmark(result: SearchResult): Promise<void>; clearHistory(): Promise<void>;
  saveSettings(settings: Settings, chat: ChatSettings): Promise<void>;
  start(): Promise<void>; pause(): void; dispose(): void;
}
