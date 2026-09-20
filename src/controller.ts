import type { Bookmark, ChatSettings, EntryType, HistoryItem, HostAdapter, HostSnapshot, PhoneController, PhoneState, SearchResult, Settings } from './core/types.js';
import { emptyContext, extractContext } from './context/extractor.js';
import { PhoneStorage } from './library/storage.js';
import { MAX_PACK_BYTES, parsePack } from './library/pack.js';
import { isVisible } from './search/filters.js';
import { SearchService } from './search/service.js';
import { ZimProvider, archiveVisible } from './providers/zim.js';
import { ZimTimeoutError } from './zim/engine.js';
import { isRetiredPack } from './library/source-policy.js';
import { LocalLibraryProvider } from './providers/local.js';
import { OnlineProvider, ONLINE_PACK_ID, normalizeOnlinePath, type OnlineRead } from './providers/online.js';
import { cachedResult } from './library/online-cache.js';
import { chatStorageKey, defaultChat, normalizeChat, normalizeSettings, searchContext, visibleHistory, worldline } from './settings/settings.js';

export class Controller implements PhoneController {
  private storage = new PhoneStorage();
  private local = new LocalLibraryProvider();
  private zim = new ZimProvider();
  private online = new OnlineProvider(this.storage);
  private archiveRevision = 0;
  private pendingArchiveFile: File | undefined;
  private service = new SearchService([this.zim, this.local]);
  private listeners = new Set<(state: PhoneState) => void>();
  private unsubscribe: (() => void) | undefined;
  private active = false;
  private disposed = false;
  private initialized = false;
  private starting: Promise<void> | undefined;
  private requestId = 0;
  private chatRevision = 0;
  private history: HistoryItem[] = [];
  private eventQueue: Promise<void> = Promise.resolve();
  private state: PhoneState;

  constructor(private host: HostAdapter) {
    const chat = defaultChat();
    this.state = {
      ready: false, busy: false, notice: '', hostLabel: host.label, chatKey: '', canRetryArchive: false, settings: normalizeSettings(),
      chat, context: searchContext(chat, ''), packs: [], archives: [], cachedPages: [], query: '', types: [], results: [], total: 0, suggestions: [],
      page: 'home', reader: null, history: [], bookmarks: [],
    };
  }
  getState(): PhoneState { return this.state; }
  subscribe(callback: (state: PhoneState) => void): () => void {
    this.listeners.add(callback); callback(this.state);
    return () => this.listeners.delete(callback);
  }
  private emit(): void { if (!this.disposed) for (const listener of this.listeners) listener(this.state); }
  private error(error: unknown): void {
    this.state.notice = error instanceof Error ? error.message : '操作未完成，请重试。';
    this.state.busy = false; this.emit();
  }
  async start(): Promise<void> {
    if (this.disposed) return;
    this.active = true;
    if (this.starting) return this.starting;
    this.starting = this.resume().finally(() => { this.starting = undefined; });
    return this.starting;
  }
  private async resume(): Promise<void> {
    try {
      if (!this.initialized) {
        this.state.settings = normalizeSettings(await this.storage.getValue<Settings>('settings'));
        this.state.packs = await this.storage.listPacks();
        await this.refreshCache();
        const archives = await this.storage.getValue<PhoneState['archives']>('archives');
        this.state.archives = Array.isArray(archives) ? archives.map(item => ({ ...item, connected: false })) : [];
        await this.switchChat(this.host.snapshot());
        if (this.disposed) return;
        this.unsubscribe = this.host.subscribe((kind, snapshot) => {
          if (kind === 'chat' || snapshot.chatKey !== this.state.chatKey) {
            const revision = ++this.chatRevision;
            this.resetChat(snapshot);
            this.eventQueue = this.eventQueue.then(() => this.switchChat(snapshot, revision)).catch(error => this.error(error));
          } else {
            const revision = this.chatRevision;
            this.eventQueue = this.eventQueue.then(async () => {
              if (revision === this.chatRevision) await this.updateContext(snapshot, kind === 'reconcile');
            }).catch(error => this.error(error));
          }
        });
        this.initialized = true;
        // Subscribe before a second snapshot so switches during initial DB reads
        // are reconciled, and subsequent switches use the normal epoch guard.
        const current = this.host.snapshot();
        if (current.chatKey !== this.state.chatKey) await this.switchChat(current);
        else if (this.state.ready) await this.updateContext(current);
      }
      await this.eventQueue;
      // Reopening while a chat is loading must not persist resetChat defaults.
      if (this.state.ready) await this.updateContext(this.host.snapshot());
      if (this.active && this.state.ready && ['search', 'library', 'bookmarks'].includes(this.state.page)) await this.navigate(this.state.page);
      this.emit();
    } catch (error) { this.error(error); }
  }
  private clearResults(): void {
    this.zim.cancelSearch();
    this.online.cancelSearch();
    this.requestId++; this.state.results = []; this.state.suggestions = []; this.state.total = 0;
    this.state.reader = null; this.state.busy = false;
  }
  private resetChat(snapshot: HostSnapshot): void {
    this.clearResults(); this.state.query = ''; this.state.chatKey = snapshot.chatKey;
    this.state.types = []; this.state.ready = false; this.state.notice = '';
    this.state.history = []; this.history = []; this.state.bookmarks = [];
    this.state.chat = defaultChat(); this.state.context = searchContext(this.state.chat, snapshot.chatKey); this.emit();
  }
  private async switchChat(snapshot: HostSnapshot, revision = ++this.chatRevision): Promise<void> {
    if (this.disposed || revision !== this.chatRevision) return;
    this.resetChat(snapshot);
    const [chat, history, bookmarks] = await Promise.all([
      this.storage.getValue<ChatSettings>(chatStorageKey(snapshot.chatKey)),
      this.storage.getValue<HistoryItem[]>(chatStorageKey(snapshot.chatKey, 'history')),
      this.storage.getValue<Bookmark[]>(chatStorageKey(snapshot.chatKey, 'bookmarks')),
    ]);
    if (this.disposed || revision !== this.chatRevision) return;
    if (!this.initialized && this.host.snapshot().chatKey !== snapshot.chatKey) return;
    this.state.chat = normalizeChat(chat); this.history = history ?? []; this.state.bookmarks = bookmarks ?? [];
    await this.updateContext(snapshot);
    if (this.disposed || revision !== this.chatRevision) return;
    this.state.ready = true; this.emit();
    if (this.initialized && this.active && ['search', 'library', 'bookmarks'].includes(this.state.page)) void this.navigate(this.state.page);
  }
  private async updateContext(snapshot: HostSnapshot, reconcile = false): Promise<void> {
    if (snapshot.chatKey !== this.state.chatKey || this.disposed) return;
    const revision = this.chatRevision;
    const before = worldline(this.state.context);
    this.state.chat.context = extractContext(snapshot.messages, reconcile ? emptyContext() : this.state.chat.context);
    this.state.context = searchContext(this.state.chat, snapshot.chatKey);
    this.state.history = visibleHistory(this.history, this.state.context);
    const contextChanged = before !== worldline(this.state.context);
    if (contextChanged && this.state.settings.sourceMode === 'offline') this.clearResults();
    await this.storage.setValue(chatStorageKey(snapshot.chatKey), structuredClone(this.state.chat));
    if (this.disposed || revision !== this.chatRevision) return;
    this.emit();
    if (contextChanged && this.state.settings.sourceMode === 'offline' && this.active && this.state.ready && ['search', 'bookmarks', 'library'].includes(this.state.page)) void this.navigate(this.state.page);
  }
  async navigate(page: PhoneState['page'], offset = 0): Promise<void> {
    if (!this.state.ready) return;
    this.clearResults(); this.state.page = page; this.state.notice = ''; this.emit();
    if (page === 'bookmarks') await this.loadBookmarks(offset);
    else if (page === 'search') await this.search(this.state.query, this.state.types);
    else if (page === 'library') { await this.refreshCache(); await this.runSearch('', [], 0, false); }
  }
  async search(query: string, types: EntryType[] = [], offset = 0): Promise<void> {
    if (!this.state.ready) return;
    this.state.page = 'search';
    await this.runSearch(query, types, offset, offset === 0);
  }
  private async runSearch(query: string, types: EntryType[], offset: number, record: boolean): Promise<void> {
    this.online.cancelSearch(); this.zim.cancelSearch();
    const id = ++this.requestId;
    const key = this.state.chatKey;
    this.state.query = query.trim().slice(0, 200); this.state.types = types; this.state.busy = true;
    this.state.notice = ''; this.state.reader = null; this.state.results = []; this.state.suggestions = []; this.emit();
    try {
      const online = this.state.settings.sourceMode === 'online' && this.state.page === 'search';
      // Online reference lookup deliberately contains no chat identity, text, location or inferred date.
      const response = online
        ? await this.online.search({ query: this.state.query, context: { worldDate: null, location: [], strictTimeline: false, chatKey: '' }, offset, limit: 12 })
        : await this.service.search({ query: this.state.query, context: this.state.context, types, offset, limit: 12 });
      if (id !== this.requestId || !this.active || key !== this.state.chatKey) return;
      this.state.results = response.results; this.state.total = response.total; this.state.suggestions = response.suggestions;
      this.state.archives = this.state.archives.map(item => ({ ...item, connected: this.zim.connected(item.id) }));
      this.state.busy = false; this.state.notice = response.notice || '';
      if (!online && !this.state.notice && this.state.archives.length && !this.state.archives.some(item => item.connected)) this.state.notice = '当前页面未连接文件，请到知库重新选择同一 .zim；无需重新下载。';
      if (record && this.state.query) await this.recordHistory();
      if (id === this.requestId) this.emit();
    } catch (error) { if (id === this.requestId) this.error(error); }
  }
  private async recordHistory(): Promise<void> {
    const line = worldline(this.state.context);
    const row: HistoryItem = { schemaVersion: 1, id: crypto.randomUUID(), query: this.state.query,
      worldDate: this.state.context.worldDate, worldline: line, source: 'manual', viewed: [], createdAt: Date.now() };
    this.history = [row, ...this.history.filter(item => item.query !== row.query || item.worldline !== line)].slice(0, 200);
    this.state.history = visibleHistory(this.history, this.state.context);
    await this.storage.setValue(chatStorageKey(this.state.chatKey, 'history'), this.history);
  }
  async read(result: SearchResult): Promise<void> {
    if (!this.state.ready) return;
    if (result.packId === ONLINE_PACK_ID) {
      if (result.entry.source.kind === 'cache') await this.readCached(result);
      else await this.readOnline(result);
      return;
    }
    const key = this.state.chatKey;
    const id = ++this.requestId;
    try {
      if (result.packId.startsWith('zim:')) {
        await this.readArchivePath(result.packId, result.entry.id); return;
      }
      if (isRetiredPack(result.packId)) throw new Error('此旧演示或摘录包已退出知识来源，请选择成熟资料库。');
      const entry = await this.storage.getEntry(result.packId, result.entry.id);
      if (id !== this.requestId || key !== this.state.chatKey) return;
      if (!entry || !isVisible(entry, this.state.context)) throw new Error('这份资料不在当前世界时间或地点内，或知识包已卸载。');
      const content = await this.storage.readContent(result.packId, entry.contentRef);
      if (id !== this.requestId || !this.active || key !== this.state.chatKey) return;
      this.state.reader = { result: { ...result, entry }, content: content ?? '正文暂不可用。' };
      const history = this.history.find(row => row.query === this.state.query && row.worldline === worldline(this.state.context));
      if (history) {
        history.viewed = [...new Set([...history.viewed, `${result.packId}/${entry.id}`])].slice(0, 20);
        await this.storage.setValue(chatStorageKey(key, 'history'), this.history);
      }
      if (id === this.requestId) this.emit();
    } catch (error) { if (id === this.requestId) this.error(error); }
  }
  async attachArchive(file: File): Promise<void> {
    const revision = ++this.archiveRevision;
    this.pendingArchiveFile = file; this.state.canRetryArchive = false;
    this.clearResults(); this.state.busy = true; this.state.notice = '正在打开库内索引，不复制整库…'; this.emit();
    try {
      const info = await this.zim.attach(file);
      if (this.disposed || revision !== this.archiveRevision) return;
      this.pendingArchiveFile = undefined;
      this.clearResults();
      this.state.archives = [info, ...this.state.archives.filter(item => item.id !== info.id).map(item => ({ ...item, connected: false }))].slice(0, 12);
      await this.storage.setValue('archives', this.state.archives.map(item => ({ ...item, connected: false })));
      this.state.notice = `已连接 ${info.articleCount.toLocaleString()} 篇原文。刷新页面后需重新选择同一文件。`;
      if (!archiveVisible(info, this.state.context)) this.state.notice += ' 当前严格时间线不允许使用这份快照，请在设置中选择现代查阅或自由查阅。';
      this.state.busy = false; this.emit();
    } catch (error) { if (revision === this.archiveRevision) {
      this.state.canRetryArchive = error instanceof ZimTimeoutError;
      if (!this.state.canRetryArchive) this.pendingArchiveFile = undefined;
      this.error(error);
    } }
  }
  async retryArchive(): Promise<void> {
    if (this.pendingArchiveFile && !this.state.busy) await this.attachArchive(this.pendingArchiveFile);
  }
  async detachArchive(id: string): Promise<void> {
    if (this.zim.connected(id)) { this.archiveRevision++; this.zim.detach(); this.clearResults(); }
    this.state.archives = this.state.archives.filter(item => item.id !== id);
    await this.storage.setValue('archives', this.state.archives.map(item => ({ ...item, connected: false })));
    this.state.notice = '已移除连接记录，磁盘文件与收藏没有删除。'; this.emit();
  }
  async readArchivePath(packId: string, path: string): Promise<void> {
    if (packId === ONLINE_PACK_ID) { await this.readOnline(path); return; }
    const id = ++this.requestId, key = this.state.chatKey;
    const hashAt = path.indexOf('#');
    const hash = hashAt < 0 ? '' : path.slice(hashAt);
    if (hashAt >= 0) path = path.slice(0, hashAt);
    try {
      const archive = this.state.archives.find(item => item.id === packId);
      if (!archive || !archiveVisible(archive, this.state.context)) throw new Error('这份资料库快照不在当前世界时间内，或尚未连接。');
      this.state.busy = true; this.state.notice = ''; this.emit();
      const page = await this.zim.read(packId, path);
      if (id !== this.requestId || !this.active || key !== this.state.chatKey) return;
      if (!/^(text\/html|application\/xhtml\+xml)/i.test(page.mimeType)) throw new Error('此链接不是可阅读词条。图片等资源仅在原文中显示。');
      const content = new TextDecoder().decode(page.data);
      const result = this.zim.resultForPath(path);
      const template = document.createElement('template'); template.innerHTML = content;
      const parsed = template.content;
      result.entry.title = parsed.querySelector('h1')?.textContent?.trim() || parsed.querySelector('title')?.textContent?.trim() || result.entry.title;
      const canonical = parsed.querySelector('link[rel="canonical"]')?.getAttribute('href');
      if (canonical && /^https?:\/\//i.test(canonical)) result.entry.source.url = canonical;
      this.state.reader = { result, content, format: 'html', path, hash };
      const history = this.history.find(row => row.query === this.state.query && row.worldline === worldline(this.state.context));
      if (history) {
        history.viewed = [...new Set([...history.viewed, `${packId}/${path}`])].slice(0, 20);
        await this.storage.setValue(chatStorageKey(key, 'history'), this.history);
      }
      if (id === this.requestId) { this.state.busy = false; this.emit(); }
    } catch (error) { if (id === this.requestId) this.error(error); }
  }
  async readArchiveResource(packId: string, path: string): Promise<{ mimeType: string; data: Uint8Array }> {
    const archive = this.state.archives.find(item => item.id === packId);
    if (!archive || !archiveVisible(archive, this.state.context)) throw new Error('当前世界时间不允许读取此资源。');
    return this.zim.read(packId, path);
  }
  closeReader(): void { this.online.cancelSearch(); this.requestId++; this.state.reader = null; this.state.busy = false; this.emit(); }
  private async refreshCache(): Promise<void> {
    this.state.cachedPages = (await this.online.cache.list()).map(cachedResult);
  }
  private async readOnline(input: string | SearchResult): Promise<void> {
    if (!this.state.ready) return;
    this.online.cancelSearch();
    const id = ++this.requestId, key = this.state.chatKey;
    const path = typeof input === 'string' ? input : input.entry.contentRef;
    const hashAt = path.indexOf('#'), hash = hashAt >= 0 ? path.slice(hashAt) : '';
    this.state.busy = true; this.state.notice = ''; this.emit();
    try {
      const page = await this.online.read(input);
      if (id !== this.requestId || !this.active || key !== this.state.chatKey) return;
      await this.showOnlinePage(page, hash, id, key);
    } catch (error) { if (id === this.requestId) this.error(error); }
  }
  async readCached(result: SearchResult): Promise<void> {
    if (!this.state.ready || result.packId !== ONLINE_PACK_ID) return;
    this.online.cancelSearch();
    const id = ++this.requestId, key = this.state.chatKey;
    this.state.busy = true; this.state.notice = ''; this.emit();
    try {
      const page = await this.online.cache.get(normalizeOnlinePath(result.entry.contentRef));
      if (id !== this.requestId || !this.active || key !== this.state.chatKey) return;
      if (!page) throw new Error('这篇原文缓存已被清理，请联网重新打开来源词条。');
      await this.showOnlinePage({ result: cachedResult(page), content: page.content, cached: true,
        notice: '正在阅读本地已读缓存；获取时间见来源信息，内容不是实时版本。' }, '', id, key);
    } catch (error) { if (id === this.requestId) this.error(error); }
  }
  private async showOnlinePage(page: OnlineRead, hash: string, id: number, key: string): Promise<void> {
    await this.refreshCache();
    if (id !== this.requestId || !this.active || key !== this.state.chatKey) return;
    const history = this.history.find(row => row.query === this.state.query && row.worldline === worldline(this.state.context));
    if (history) {
      history.viewed = [...new Set([...history.viewed, `${page.result.packId}/${page.result.entry.id}`])].slice(0, 20);
      await this.storage.setValue(chatStorageKey(key, 'history'), this.history);
      if (id !== this.requestId || !this.active || key !== this.state.chatKey) return;
    }
    this.state.reader = { result: page.result, content: page.content, format: 'html',
      path: `/wiki/${encodeURIComponent(page.result.entry.id.replace(/ /g, '_'))}`, hash };
    this.state.busy = false;
    this.state.notice = page.notice ?? '正在阅读来源原文，已存入本地缓存。当前版本未按剧情年代核验。';
    this.emit();
  }
  async setSourceMode(mode: Settings['sourceMode']): Promise<void> {
    if (!this.state.ready || !['online', 'offline'].includes(mode)) return;
    await this.saveSettings({ ...this.state.settings, sourceMode: mode }, this.state.chat);
  }
  private async changeLibrary(action: () => Promise<void>): Promise<void> {
    this.state.busy = true; this.state.notice = ''; this.emit();
    try {
      await action(); this.local.pause(); this.clearResults();
      this.state.packs = await this.storage.listPacks(); this.state.notice = '知识包已更新，全部保存在本机浏览器。';
      if (this.state.page === 'library') await this.runSearch('', [], 0, false);
      else if (this.state.page === 'bookmarks') await this.loadBookmarks();
      this.state.busy = false; this.emit();
    } catch (error) { this.error(error); }
  }
  async install(file: File): Promise<void> {
    await this.changeLibrary(async () => {
      if (file.size > MAX_PACK_BYTES) throw new Error('初版支持最大 10 MB 的知识包，请拆分后安装。');
      const pack = parsePack(JSON.parse(await file.text()));
      await this.storage.install(pack);
    });
  }
  async installSample(): Promise<void> {
    throw new Error('原创演示包已退出知识来源，请选择现成 ZIM 资料库。');
  }
  async uninstall(id: string): Promise<void> { await this.changeLibrary(() => this.storage.uninstall(id)); }
  async toggleBookmark(result: SearchResult): Promise<void> {
    if (!this.state.ready) return;
    const chatKey = this.state.chatKey;
    const revision = this.chatRevision;
    try {
      const key = `${result.packId}/${result.entry.id}`;
      if (isRetiredPack(result.packId) || (result.packId !== ONLINE_PACK_ID && !isVisible(result.entry, this.state.context))) throw new Error('当前时间线无法收藏这份资料。');
      const exists = this.state.bookmarks.some(bookmark => bookmark.key === key);
      if (!exists && this.state.bookmarks.length >= 200) throw new Error('初版每个聊天最多收藏 200 条，请先移除部分收藏。');
      const bookmarks = exists ? this.state.bookmarks.filter(bookmark => bookmark.key !== key) : [
        ...this.state.bookmarks, { schemaVersion: 1 as const, key, packId: result.packId, entryId: result.entry.id, createdAt: Date.now(), ...(result.packId.startsWith('zim:') || result.packId === ONLINE_PACK_ID ? { result } : {}) },
      ];
      this.state.bookmarks = bookmarks; this.emit();
      await this.storage.setValue(chatStorageKey(chatKey, 'bookmarks'), bookmarks);
      if (revision !== this.chatRevision) return;
      if (this.state.page === 'bookmarks') await this.loadBookmarks(); else this.emit();
    } catch (error) { if (revision === this.chatRevision) this.error(error); }
  }
  private async loadBookmarks(offset = 0): Promise<void> {
    const id = ++this.requestId;
    const context = this.state.context;
    try {
      const rows = await Promise.all(this.state.bookmarks.slice(0, 200).map(async bookmark => {
        if (isRetiredPack(bookmark.packId)) return null;
        if (bookmark.packId === ONLINE_PACK_ID) return bookmark.result ?? null;
        if (bookmark.packId.startsWith('zim:')) {
          const result = bookmark.result;
          return result && isVisible(result.entry, context) ? result : null;
        }
        const entry = await this.storage.getEntry(bookmark.packId, bookmark.entryId);
        const pack = this.state.packs.find(item => item.id === bookmark.packId);
        return entry && pack && isVisible(entry, context) ? { entry, packId: pack.id, packName: pack.name, score: 0 } : null;
      }));
      if (id !== this.requestId) return;
      const results = rows.filter((row): row is SearchResult => row !== null);
      this.state.results = results.slice(offset, offset + 12); this.state.total = results.length; this.emit();
    } catch (error) { if (id === this.requestId) this.error(error); }
  }
  async clearHistory(): Promise<void> {
    if (!this.state.ready) return;
    try {
      const line = worldline(this.state.context);
      this.history = this.history.filter(row => row.worldline !== line); this.state.history = [];
      await this.storage.setValue(chatStorageKey(this.state.chatKey, 'history'), this.history); this.emit();
    } catch (error) { this.error(error); }
  }
  async saveSettings(settings: Settings, chat: ChatSettings): Promise<void> {
    if (!this.state.ready) return;
    const revision = this.chatRevision;
    try {
      const key = this.state.chatKey;
      this.clearResults(); this.state.settings = normalizeSettings(settings); this.state.chat = normalizeChat(chat);
      this.state.context = searchContext(this.state.chat, key); this.state.history = visibleHistory(this.history, this.state.context);
      await Promise.all([this.storage.setValue('settings', this.state.settings), this.storage.setValue(chatStorageKey(key), this.state.chat)]);
      if (revision === this.chatRevision) { this.state.notice = '设置已保存。'; this.emit(); }
    } catch (error) { if (revision === this.chatRevision) this.error(error); }
  }
  pause(): void { this.active = false; this.clearResults(); this.local.pause(); }
  dispose(): void {
    this.disposed = true; this.active = false; this.requestId++; this.chatRevision++;
    this.archiveRevision++; this.zim.detach(); this.online.dispose();
    this.pendingArchiveFile = undefined;
    this.unsubscribe?.(); this.local.dispose(); this.storage.dispose(); this.host.dispose(); this.listeners.clear();
  }
}
