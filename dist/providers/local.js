export class LocalLibraryProvider {
    id = 'local-library';
    name = '本地知识库';
    worker;
    serial = 0;
    disposed = false;
    pending = new Map();
    async isAvailable() {
        return !this.disposed && typeof Worker !== 'undefined' && typeof indexedDB !== 'undefined';
    }
    getWorker() {
        if (this.disposed)
            throw new Error('本地搜索已关闭');
        if (this.worker)
            return this.worker;
        const worker = new Worker(new URL('../search/worker.js', import.meta.url), { type: 'module', name: 'knowledge-phone-search' });
        worker.onmessage = (event) => {
            const reply = event.data;
            const waiting = this.pending.get(reply.id);
            if (!waiting)
                return;
            clearTimeout(waiting.timeout);
            this.pending.delete(reply.id);
            if (reply.kind === 'success')
                waiting.resolve(reply.response);
            else
                waiting.reject(new Error(reply.message || '本地搜索失败'));
        };
        worker.onerror = () => this.stop(new Error('搜索 Worker 启动或运行失败'));
        worker.onmessageerror = () => this.stop(new Error('搜索 Worker 返回了无法读取的数据'));
        this.worker = worker;
        return worker;
    }
    search(request) {
        return new Promise((resolve, reject) => {
            let worker;
            try {
                worker = this.getWorker();
            }
            catch (error) {
                reject(error);
                return;
            }
            const id = ++this.serial;
            const timeout = setTimeout(() => this.stop(new Error('本地搜索超时，请重试')), 15_000);
            this.pending.set(id, { resolve, reject, timeout });
            try {
                worker.postMessage({ kind: 'search', id, request });
            }
            catch (error) {
                clearTimeout(timeout);
                this.pending.delete(id);
                reject(error);
            }
        });
    }
    stop(error) {
        if (this.worker) {
            this.worker.onmessage = null;
            this.worker.onerror = null;
            this.worker.onmessageerror = null;
            this.worker.terminate();
        }
        this.worker = undefined;
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timeout);
            pending.reject(error);
        }
        this.pending.clear();
    }
    pause() { this.stop(new Error('本地搜索已暂停')); }
    dispose() { this.disposed = true; this.stop(new Error('本地搜索已关闭')); }
}
