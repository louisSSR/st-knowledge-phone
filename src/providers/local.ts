import type { SearchProvider, SearchRequest, SearchResponse } from '../core/types.js';

interface PendingRequest { resolve: (response: SearchResponse) => void; reject: (error: Error) => void; timeout: ReturnType<typeof setTimeout>; }
type WorkerReply = { id: number; kind: 'success'; response: SearchResponse } | { id: number; kind: 'error'; message: string };

export class LocalLibraryProvider implements SearchProvider {
  readonly id = 'local-library';
  readonly name = '本地知识库';
  private worker: Worker | undefined;
  private serial = 0;
  private disposed = false;
  private pending = new Map<number, PendingRequest>();

  async isAvailable(): Promise<boolean> {
    return !this.disposed && typeof Worker !== 'undefined' && typeof indexedDB !== 'undefined';
  }

  private getWorker(): Worker {
    if (this.disposed) throw new Error('本地搜索已关闭');
    if (this.worker) return this.worker;
    const worker = new Worker(new URL('../search/worker.js', import.meta.url), { type: 'module', name: 'knowledge-phone-search' });
    worker.onmessage = (event: MessageEvent<WorkerReply>) => {
      const reply = event.data;
      const waiting = this.pending.get(reply.id);
      if (!waiting) return;
      clearTimeout(waiting.timeout);
      this.pending.delete(reply.id);
      if (reply.kind === 'success') waiting.resolve(reply.response);
      else waiting.reject(new Error(reply.message || '本地搜索失败'));
    };
    worker.onerror = () => this.stop(new Error('搜索 Worker 启动或运行失败'));
    worker.onmessageerror = () => this.stop(new Error('搜索 Worker 返回了无法读取的数据'));
    this.worker = worker;
    return worker;
  }

  search(request: SearchRequest): Promise<SearchResponse> {
    return new Promise((resolve, reject) => {
      let worker: Worker;
      try { worker = this.getWorker(); } catch (error) { reject(error); return; }
      const id = ++this.serial;
      const timeout = setTimeout(() => this.stop(new Error('本地搜索超时，请重试')), 15_000);
      this.pending.set(id, { resolve, reject, timeout });
      try { worker.postMessage({ kind: 'search', id, request }); }
      catch (error) { clearTimeout(timeout); this.pending.delete(id); reject(error); }
    });
  }

  private stop(error: Error): void {
    if (this.worker) {
      this.worker.onmessage = null;
      this.worker.onerror = null;
      this.worker.onmessageerror = null;
      this.worker.terminate();
    }
    this.worker = undefined;
    for (const pending of this.pending.values()) { clearTimeout(pending.timeout); pending.reject(error); }
    this.pending.clear();
  }

  pause(): void { this.stop(new Error('本地搜索已暂停')); }
  dispose(): void { this.disposed = true; this.stop(new Error('本地搜索已关闭')); }
}
