import { emptyContext, extractContext } from './context/extractor.js';
import { PhoneStorage } from './library/storage.js';
import { MAX_PACK_BYTES, parsePack } from './library/pack.js';
import { isVisible } from './search/filters.js';
import { SearchService } from './search/service.js';
import { LocalLibraryProvider } from './providers/local.js';
import { chatStorageKey, defaultChat, normalizeChat, normalizeSettings, searchContext, visibleHistory, worldline } from './settings/settings.js';
export class Controller {
    host;
    storage = new PhoneStorage();
    local = new LocalLibraryProvider();
    service = new SearchService([this.local]);
    listeners = new Set();
    unsubscribe;
    active = false;
    disposed = false;
    initialized = false;
    starting;
    requestId = 0;
    chatRevision = 0;
    history = [];
    eventQueue = Promise.resolve();
    state;
    constructor(host) {
        this.host = host;
        const chat = defaultChat();
        this.state = {
            ready: false, busy: false, notice: '', hostLabel: host.label, chatKey: '', settings: normalizeSettings(),
            chat, context: searchContext(chat, ''), packs: [], query: '', types: [], results: [], total: 0, suggestions: [],
            page: 'home', reader: null, history: [], bookmarks: [],
        };
    }
    getState() { return this.state; }
    subscribe(callback) {
        this.listeners.add(callback);
        callback(this.state);
        return () => this.listeners.delete(callback);
    }
    emit() { if (!this.disposed)
        for (const listener of this.listeners)
            listener(this.state); }
    error(error) {
        this.state.notice = error instanceof Error ? error.message : '操作未完成，请重试。';
        this.state.busy = false;
        this.emit();
    }
    async start() {
        if (this.disposed)
            return;
        this.active = true;
        if (this.starting)
            return this.starting;
        this.starting = this.resume().finally(() => { this.starting = undefined; });
        return this.starting;
    }
    async resume() {
        try {
            if (!this.initialized) {
                this.state.settings = normalizeSettings(await this.storage.getValue('settings'));
                this.state.packs = await this.storage.listPacks();
                await this.switchChat(this.host.snapshot());
                if (this.disposed)
                    return;
                this.unsubscribe = this.host.subscribe((kind, snapshot) => {
                    if (kind === 'chat' || snapshot.chatKey !== this.state.chatKey) {
                        const revision = ++this.chatRevision;
                        this.resetChat(snapshot);
                        this.eventQueue = this.eventQueue.then(() => this.switchChat(snapshot, revision)).catch(error => this.error(error));
                    }
                    else {
                        const revision = this.chatRevision;
                        this.eventQueue = this.eventQueue.then(async () => {
                            if (revision === this.chatRevision)
                                await this.updateContext(snapshot, kind === 'reconcile');
                        }).catch(error => this.error(error));
                    }
                });
                this.initialized = true;
                // Subscribe before a second snapshot so switches during initial DB reads
                // are reconciled, and subsequent switches use the normal epoch guard.
                const current = this.host.snapshot();
                if (current.chatKey !== this.state.chatKey)
                    await this.switchChat(current);
                else if (this.state.ready)
                    await this.updateContext(current);
            }
            await this.eventQueue;
            // Reopening while a chat is loading must not persist resetChat defaults.
            if (this.state.ready)
                await this.updateContext(this.host.snapshot());
            if (this.active && this.state.ready && ['search', 'library', 'bookmarks'].includes(this.state.page))
                await this.navigate(this.state.page);
            this.emit();
        }
        catch (error) {
            this.error(error);
        }
    }
    clearResults() {
        this.requestId++;
        this.state.results = [];
        this.state.suggestions = [];
        this.state.total = 0;
        this.state.reader = null;
        this.state.busy = false;
    }
    resetChat(snapshot) {
        this.clearResults();
        this.state.query = '';
        this.state.chatKey = snapshot.chatKey;
        this.state.types = [];
        this.state.ready = false;
        this.state.notice = '';
        this.state.history = [];
        this.history = [];
        this.state.bookmarks = [];
        this.state.chat = defaultChat();
        this.state.context = searchContext(this.state.chat, snapshot.chatKey);
        this.emit();
    }
    async switchChat(snapshot, revision = ++this.chatRevision) {
        if (this.disposed || revision !== this.chatRevision)
            return;
        this.resetChat(snapshot);
        const [chat, history, bookmarks] = await Promise.all([
            this.storage.getValue(chatStorageKey(snapshot.chatKey)),
            this.storage.getValue(chatStorageKey(snapshot.chatKey, 'history')),
            this.storage.getValue(chatStorageKey(snapshot.chatKey, 'bookmarks')),
        ]);
        if (this.disposed || revision !== this.chatRevision)
            return;
        if (!this.initialized && this.host.snapshot().chatKey !== snapshot.chatKey)
            return;
        this.state.chat = normalizeChat(chat);
        this.history = history ?? [];
        this.state.bookmarks = bookmarks ?? [];
        await this.updateContext(snapshot);
        if (this.disposed || revision !== this.chatRevision)
            return;
        this.state.ready = true;
        this.emit();
        if (this.initialized && this.active && ['search', 'library', 'bookmarks'].includes(this.state.page))
            void this.navigate(this.state.page);
    }
    async updateContext(snapshot, reconcile = false) {
        if (snapshot.chatKey !== this.state.chatKey || this.disposed)
            return;
        const revision = this.chatRevision;
        const before = worldline(this.state.context);
        this.state.chat.context = extractContext(snapshot.messages, reconcile ? emptyContext() : this.state.chat.context);
        this.state.context = searchContext(this.state.chat, snapshot.chatKey);
        this.state.history = visibleHistory(this.history, this.state.context);
        const contextChanged = before !== worldline(this.state.context);
        if (contextChanged)
            this.clearResults();
        await this.storage.setValue(chatStorageKey(snapshot.chatKey), structuredClone(this.state.chat));
        if (this.disposed || revision !== this.chatRevision)
            return;
        this.emit();
        if (contextChanged && this.active && this.state.ready && ['search', 'bookmarks', 'library'].includes(this.state.page))
            void this.navigate(this.state.page);
    }
    async navigate(page, offset = 0) {
        if (!this.state.ready)
            return;
        this.clearResults();
        this.state.page = page;
        this.state.notice = '';
        this.emit();
        if (page === 'bookmarks')
            await this.loadBookmarks(offset);
        else if (page === 'search')
            await this.search(this.state.query, this.state.types);
        else if (page === 'library')
            await this.runSearch('', [], 0, false);
    }
    async search(query, types = [], offset = 0) {
        if (!this.state.ready)
            return;
        this.state.page = 'search';
        await this.runSearch(query, types, offset, offset === 0);
    }
    async runSearch(query, types, offset, record) {
        const id = ++this.requestId;
        const key = this.state.chatKey;
        this.state.query = query.trim().slice(0, 200);
        this.state.types = types;
        this.state.busy = true;
        this.state.notice = '';
        this.state.reader = null;
        this.state.results = [];
        this.state.suggestions = [];
        this.emit();
        try {
            const response = await this.service.search({ query: this.state.query, context: this.state.context, types, offset, limit: 12 });
            if (id !== this.requestId || !this.active || key !== this.state.chatKey)
                return;
            this.state.results = response.results;
            this.state.total = response.total;
            this.state.suggestions = response.suggestions;
            this.state.busy = false;
            if (record && this.state.query)
                await this.recordHistory();
            if (id === this.requestId)
                this.emit();
        }
        catch (error) {
            if (id === this.requestId)
                this.error(error);
        }
    }
    async recordHistory() {
        const line = worldline(this.state.context);
        const row = { schemaVersion: 1, id: crypto.randomUUID(), query: this.state.query,
            worldDate: this.state.context.worldDate, worldline: line, source: 'manual', viewed: [], createdAt: Date.now() };
        this.history = [row, ...this.history.filter(item => item.query !== row.query || item.worldline !== line)].slice(0, 200);
        this.state.history = visibleHistory(this.history, this.state.context);
        await this.storage.setValue(chatStorageKey(this.state.chatKey, 'history'), this.history);
    }
    async read(result) {
        if (!this.state.ready)
            return;
        const key = this.state.chatKey;
        const id = ++this.requestId;
        try {
            const entry = await this.storage.getEntry(result.packId, result.entry.id);
            if (id !== this.requestId || key !== this.state.chatKey)
                return;
            if (!entry || !isVisible(entry, this.state.context))
                throw new Error('这份资料不在当前世界时间或地点内，或知识包已卸载。');
            const content = await this.storage.readContent(result.packId, entry.contentRef);
            if (id !== this.requestId || !this.active || key !== this.state.chatKey)
                return;
            this.state.reader = { result: { ...result, entry }, content: content ?? '正文暂不可用。' };
            const history = this.history.find(row => row.query === this.state.query && row.worldline === worldline(this.state.context));
            if (history) {
                history.viewed = [...new Set([...history.viewed, `${result.packId}/${entry.id}`])].slice(0, 20);
                await this.storage.setValue(chatStorageKey(key, 'history'), this.history);
            }
            if (id === this.requestId)
                this.emit();
        }
        catch (error) {
            if (id === this.requestId)
                this.error(error);
        }
    }
    closeReader() { this.requestId++; this.state.reader = null; this.emit(); }
    async changeLibrary(action) {
        this.state.busy = true;
        this.state.notice = '';
        this.emit();
        try {
            await action();
            this.local.pause();
            this.clearResults();
            this.state.packs = await this.storage.listPacks();
            this.state.notice = '知识包已更新，全部保存在本机浏览器。';
            if (this.state.page === 'library')
                await this.runSearch('', [], 0, false);
            else if (this.state.page === 'bookmarks')
                await this.loadBookmarks();
            this.state.busy = false;
            this.emit();
        }
        catch (error) {
            this.error(error);
        }
    }
    async install(file) {
        await this.changeLibrary(async () => {
            if (file.size > MAX_PACK_BYTES)
                throw new Error('初版支持最大 10 MB 的知识包，请拆分后安装。');
            const pack = parsePack(JSON.parse(await file.text()));
            await this.storage.install(pack);
        });
    }
    async installSample() {
        await this.changeLibrary(async () => {
            const response = await fetch(new URL('../packs/original-demo.pack.json', import.meta.url));
            if (!response.ok)
                throw new Error('随附示范知识包读取失败，请检查扩展目录。');
            await this.storage.install(parsePack(await response.json()));
        });
    }
    async uninstall(id) { await this.changeLibrary(() => this.storage.uninstall(id)); }
    async toggleBookmark(result) {
        if (!this.state.ready)
            return;
        const chatKey = this.state.chatKey;
        const revision = this.chatRevision;
        try {
            const key = `${result.packId}/${result.entry.id}`;
            if (!isVisible(result.entry, this.state.context))
                throw new Error('当前时间线无法收藏这份资料。');
            const exists = this.state.bookmarks.some(bookmark => bookmark.key === key);
            if (!exists && this.state.bookmarks.length >= 200)
                throw new Error('初版每个聊天最多收藏 200 条，请先移除部分收藏。');
            const bookmarks = exists ? this.state.bookmarks.filter(bookmark => bookmark.key !== key) : [
                ...this.state.bookmarks, { schemaVersion: 1, key, packId: result.packId, entryId: result.entry.id, createdAt: Date.now() },
            ];
            this.state.bookmarks = bookmarks;
            this.emit();
            await this.storage.setValue(chatStorageKey(chatKey, 'bookmarks'), bookmarks);
            if (revision !== this.chatRevision)
                return;
            if (this.state.page === 'bookmarks')
                await this.loadBookmarks();
            else
                this.emit();
        }
        catch (error) {
            if (revision === this.chatRevision)
                this.error(error);
        }
    }
    async loadBookmarks(offset = 0) {
        const id = ++this.requestId;
        const context = this.state.context;
        try {
            const rows = await Promise.all(this.state.bookmarks.slice(0, 200).map(async (bookmark) => {
                const entry = await this.storage.getEntry(bookmark.packId, bookmark.entryId);
                const pack = this.state.packs.find(item => item.id === bookmark.packId);
                return entry && pack && isVisible(entry, context) ? { entry, packId: pack.id, packName: pack.name, score: 0 } : null;
            }));
            if (id !== this.requestId)
                return;
            const results = rows.filter((row) => row !== null);
            this.state.results = results.slice(offset, offset + 12);
            this.state.total = results.length;
            this.emit();
        }
        catch (error) {
            if (id === this.requestId)
                this.error(error);
        }
    }
    async clearHistory() {
        if (!this.state.ready)
            return;
        try {
            const line = worldline(this.state.context);
            this.history = this.history.filter(row => row.worldline !== line);
            this.state.history = [];
            await this.storage.setValue(chatStorageKey(this.state.chatKey, 'history'), this.history);
            this.emit();
        }
        catch (error) {
            this.error(error);
        }
    }
    async saveSettings(settings, chat) {
        if (!this.state.ready)
            return;
        const revision = this.chatRevision;
        try {
            const key = this.state.chatKey;
            this.clearResults();
            this.state.settings = normalizeSettings(settings);
            this.state.chat = normalizeChat(chat);
            this.state.context = searchContext(this.state.chat, key);
            this.state.history = visibleHistory(this.history, this.state.context);
            await Promise.all([this.storage.setValue('settings', this.state.settings), this.storage.setValue(chatStorageKey(key), this.state.chat)]);
            if (revision === this.chatRevision) {
                this.state.notice = '设置已保存。';
                this.emit();
            }
        }
        catch (error) {
            if (revision === this.chatRevision)
                this.error(error);
        }
    }
    pause() { this.active = false; this.clearResults(); this.local.pause(); }
    dispose() {
        this.disposed = true;
        this.active = false;
        this.requestId++;
        this.chatRevision++;
        this.unsubscribe?.();
        this.local.dispose();
        this.storage.dispose();
        this.host.dispose();
        this.listeners.clear();
    }
}
