/** A deadline identifies the failed operation; it does not mean the archive was lost. */
export class ZimTimeoutError extends Error {
    action;
    timeoutMs;
    constructor(action, timeoutMs) {
        const stage = {
            init: '引擎初始化', 'st-count': '资料库目录读取', 'st-search': '全文搜索',
            'st-suggest': '标题搜索', 'st-read': '原文读取', 'st-stats': '状态读取',
        };
        super(`ZIM ${stage[action] ?? '操作'}超时（${Math.ceil(timeoutMs / 1000)} 秒）。已保留所选文件，请再次尝试；无需重新下载或选择资料库。`);
        this.action = action;
        this.timeoutMs = timeoutMs;
        this.name = 'ZimTimeoutError';
    }
}
/** One file per worker. Closing/replacing it releases its file handle, WASM heap and caches. */
export class ZimEngine {
    worker = null;
    pending = new Set();
    generation = 0;
    searchGeneration = 0;
    opened = false;
    file = null;
    uuid = '';
    opening = null;
    isOpen() { return this.opened && this.worker !== null; }
    /** The selected File remains usable for recovery in this page, without copying it. */
    recoverable() { return this.file !== null; }
    async open(file) {
        this.close();
        const generation = this.generation;
        if (!/\.zim$/i.test(file.name))
            throw new Error('请选择完整的 .zim 文件；分卷请先使用 Kiwix 合并。');
        if (file.size < 80)
            throw new Error('ZIM 文件不完整（文件头不足 80 字节）。');
        const signature = new Uint8Array(await file.slice(0, 24).arrayBuffer());
        if (signature.length !== 24 || signature[0] !== 0x5a || signature[1] !== 0x49 || signature[2] !== 0x4d || signature[3] !== 4) {
            throw new Error('这不是有效的 ZIM 文件，或文件尚未下载完整。');
        }
        // The archive UUID occupies bytes 8–23 (OpenZIM libzim/src/fileheader.cpp).
        const hex = Array.from(signature.slice(8, 24), byte => byte.toString(16).padStart(2, '0')).join('');
        const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
        if (generation !== this.generation)
            throw new Error('资料库打开操作已取消。');
        this.file = file;
        this.uuid = uuid;
        return this.beginOpening();
    }
    /** A failed request is never replayed. A later request may reopen the retained file once. */
    async ensureOpen() {
        if (this.isOpen())
            return;
        if (!this.file)
            throw new Error('请先选择一个 ZIM 资料库。');
        await (this.opening ?? this.beginOpening());
    }
    beginOpening() {
        if (!this.file)
            return Promise.reject(new Error('请先选择一个 ZIM 资料库。'));
        const task = this.initialize(this.file, this.uuid, this.generation);
        this.opening = task;
        const clear = () => { if (this.opening === task)
            this.opening = null; };
        void task.then(clear, clear);
        return task;
    }
    async initialize(file, uuid, generation) {
        const worker = new Worker(new URL('../../vendor/libzim/bridge.js', import.meta.url));
        this.worker = worker;
        worker.addEventListener('error', () => {
            this.interruptWorker(worker, new Error('ZIM 引擎运行失败。已保留所选文件，请再次尝试。'));
        });
        worker.addEventListener('messageerror', () => {
            this.interruptWorker(worker, new Error('ZIM 引擎返回了无法读取的数据。已保留所选文件，请再次尝试。'));
        });
        try {
            // Structured cloning a File shares its backing store. We never call file.arrayBuffer().
            await this.request('init', { files: [file] }, 120_000);
            if (generation !== this.generation || this.worker !== worker)
                throw new Error('资料库打开操作已取消。');
            const articleCount = await this.request('st-count');
            if (generation !== this.generation || this.worker !== worker)
                throw new Error('资料库打开操作已取消。');
            this.opened = true;
            return { name: file.name, size: file.size, articleCount, uuid };
        }
        catch (error) {
            this.interruptWorker(worker, error instanceof Error ? error : new Error(String(error)));
            throw error;
        }
    }
    async search(query, options = {}) {
        return this.find('st-search', query, options);
    }
    /** Title index lookup, useful for exact terms and prefix completion. */
    async suggest(query, options = {}) {
        return this.find('st-suggest', query, options);
    }
    async read(path) {
        if (!path || path.length > 8192 || path.includes('\0'))
            throw new Error('无效的 ZIM 条目路径。');
        const generation = this.generation;
        await this.ensureOpen();
        if (generation !== this.generation)
            throw new Error('资料库读取操作已取消。');
        return this.request('st-read', { path });
    }
    /** Worker-local counters for acceptance tests; these count reads, not unique file bytes. */
    async diagnostics() {
        const generation = this.generation;
        await this.ensureOpen();
        if (generation !== this.generation)
            throw new Error('资料库状态读取已取消。');
        return this.request('st-stats');
    }
    close(error = new Error('资料库已关闭。')) {
        this.generation += 1;
        this.file = null;
        this.uuid = '';
        this.opening = null;
        if (this.worker)
            this.interruptWorker(this.worker, error);
    }
    /** Synchronous WASM cannot abort a running search; discard that worker, retain the File. */
    cancelSearch() {
        this.searchGeneration += 1;
        const worker = this.worker;
        if (worker && [...this.pending].some(item => item.worker === worker && ['st-search', 'st-suggest'].includes(item.action))) {
            this.interruptWorker(worker, new Error('ZIM 搜索已取消，相关在途操作已中断；所选文件仍保留。'));
        }
    }
    interruptWorker(worker, error) {
        if (this.worker !== worker)
            return;
        this.opened = false;
        this.worker = null;
        worker.terminate();
        for (const item of [...this.pending])
            if (item.worker === worker)
                item.reject(error);
    }
    async find(action, query, options) {
        const text = query.trim();
        if (!text)
            return [];
        if (text.length > 500)
            throw new Error('查询过长，请缩短到 500 个字符以内。');
        const limit = options.limit ?? 20;
        const offset = options.offset ?? 0;
        if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0 || offset > 900) {
            throw new Error('查询分页超出范围：每页 1–100 条，最多访问前 1000 条。');
        }
        // Upstream exposes only a count, so bounded pagination is applied in the worker.
        const generation = this.generation, searchGeneration = this.searchGeneration;
        await this.ensureOpen();
        if (generation !== this.generation || searchGeneration !== this.searchGeneration)
            throw new Error('ZIM 搜索已取消。');
        return this.request(action, { text, limit, offset });
    }
    request(action, payload = {}, timeout = 90_000) {
        const worker = this.worker;
        if (!worker)
            return Promise.reject(new Error('资料库已关闭。'));
        return new Promise((resolve, reject) => {
            const channel = new MessageChannel();
            let settled = false;
            const finish = (error, value) => {
                if (settled)
                    return;
                settled = true;
                clearTimeout(timer);
                channel.port1.close();
                channel.port2.close();
                this.pending.delete(pending);
                if (error)
                    reject(error);
                else
                    resolve(value);
            };
            const fail = (error) => finish(error);
            const timer = setTimeout(() => {
                // A queued old timer must never stop a replacement worker.
                if (settled || this.worker !== worker)
                    return;
                const error = new ZimTimeoutError(action, timeout);
                finish(error);
                this.interruptWorker(worker, new Error('ZIM 引擎因其他操作超时而重启，此操作已中断；所选文件仍保留，请再次尝试。'));
            }, timeout);
            const pending = { action, worker, reject: fail };
            this.pending.add(pending);
            channel.port1.onmessage = event => {
                const response = event.data;
                if (response && typeof response === 'object' && typeof response.error === 'string')
                    finish(new Error(response.error));
                else
                    finish(undefined, response);
            };
            channel.port1.onmessageerror = () => finish(new Error('无法接收 ZIM 查询结果。'));
            try {
                worker.postMessage({ action, ...payload }, [channel.port2]);
            }
            catch (error) {
                finish(error instanceof Error ? error : new Error(String(error)));
            }
        });
    }
}
