/** Native ZIM access through pinned OpenZIM libzim, entirely inside a dedicated worker. */
export interface ZimMetadata {
  name: string;
  size: number;
  articleCount: number;
  uuid: string;
  /** Not exposed by the pinned upstream binding; absence means unknown. */
  date?: string;
  hasFullTextIndex?: boolean;
}

export interface ZimHit {
  path: string;
  title: string;
  /** Plain text, extracted by the archive's own search index, never generated. */
  snippet?: string;
}

export interface ZimPage { mimeType: string; data: Uint8Array }
export interface ZimSearchOptions { limit?: number; offset?: number }
export interface ZimDiagnostics { readCalls: number; bytesRead: number; largestRead: number; wasmHeapBytes: number }

/** One file per worker. Closing/replacing it releases its file handle, WASM heap and caches. */
export class ZimEngine {
  private worker: Worker | null = null;
  private pending = new Set<(error: Error) => void>();
  private generation = 0;
  private opened = false;

  isOpen(): boolean { return this.opened && this.worker !== null; }

  async open(file: File): Promise<ZimMetadata> {
    this.close();
    const generation = this.generation;
    if (!/\.zim$/i.test(file.name)) throw new Error('请选择完整的 .zim 文件；分卷请先使用 Kiwix 合并。');
    if (file.size < 80) throw new Error('ZIM 文件不完整（文件头不足 80 字节）。');
    const signature = new Uint8Array(await file.slice(0, 24).arrayBuffer());
    if (signature.length !== 24 || signature[0] !== 0x5a || signature[1] !== 0x49 || signature[2] !== 0x4d || signature[3] !== 4) {
      throw new Error('这不是有效的 ZIM 文件，或文件尚未下载完整。');
    }
    // The archive UUID occupies bytes 8–23 (OpenZIM libzim/src/fileheader.cpp).
    const hex = Array.from(signature.slice(8, 24), byte => byte.toString(16).padStart(2, '0')).join('');
    const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    if (generation !== this.generation) throw new Error('资料库打开操作已取消。');
    const worker = new Worker(new URL('../../vendor/libzim/bridge.js', import.meta.url));
    this.worker = worker;
    worker.addEventListener('error', () => {
      if (this.worker === worker) this.close(new Error('ZIM 引擎运行失败；请重新选择资料库。'));
    });
    worker.addEventListener('messageerror', () => {
      if (this.worker === worker) this.close(new Error('ZIM 引擎返回了无法读取的数据。'));
    });
    try {
      // Structured cloning a File shares its backing store. We never call file.arrayBuffer().
      await this.request('init', { files: [file] }, 120_000);
      const articleCount = await this.request<number>('st-count');
      this.opened = true;
      return { name: file.name, size: file.size, articleCount, uuid };
    } catch (error) {
      if (generation === this.generation) this.close();
      throw error;
    }
  }

  async search(query: string, options: ZimSearchOptions = {}): Promise<ZimHit[]> {
    return this.find('st-search', query, options);
  }

  /** Title index lookup, useful for exact terms and prefix completion. */
  async suggest(query: string, options: ZimSearchOptions = {}): Promise<ZimHit[]> {
    return this.find('st-suggest', query, options);
  }

  async read(path: string): Promise<ZimPage> {
    this.assertOpened();
    if (!path || path.length > 8192 || path.includes('\0')) throw new Error('无效的 ZIM 条目路径。');
    return this.request<ZimPage>('st-read', { path });
  }

  /** Worker-local counters for acceptance tests; these count reads, not unique file bytes. */
  async diagnostics(): Promise<ZimDiagnostics> {
    this.assertOpened();
    return this.request<ZimDiagnostics>('st-stats');
  }

  close(error = new Error('资料库已关闭。')): void {
    this.generation += 1;
    this.opened = false;
    this.worker?.terminate();
    this.worker = null;
    for (const reject of [...this.pending]) reject(error);
    this.pending.clear();
  }

  private assertOpened(): void {
    if (!this.worker || !this.opened) throw new Error('请先选择一个 ZIM 资料库。');
  }

  private async find(action: string, query: string, options: ZimSearchOptions): Promise<ZimHit[]> {
    this.assertOpened();
    const text = query.trim();
    if (!text) return [];
    if (text.length > 500) throw new Error('查询过长，请缩短到 500 个字符以内。');
    const limit = options.limit ?? 20;
    const offset = options.offset ?? 0;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0 || offset > 900) {
      throw new Error('查询分页超出范围：每页 1–100 条，最多访问前 1000 条。');
    }
    // Upstream exposes only a count, so bounded pagination is applied in the worker.
    return this.request<ZimHit[]>(action, { text, limit, offset });
  }

  private request<T = unknown>(action: string, payload: Record<string, unknown> = {}, timeout = 90_000): Promise<T> {
    const worker = this.worker;
    if (!worker) return Promise.reject(new Error('资料库已关闭。'));
    return new Promise<T>((resolve, reject) => {
      const channel = new MessageChannel();
      let settled = false;
      const finish = (error?: Error, value?: T) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        channel.port1.close();
        channel.port2.close();
        this.pending.delete(fail);
        if (error) reject(error); else resolve(value as T);
      };
      const fail = (error: Error) => finish(error);
      const timer = setTimeout(() => this.close(new Error('ZIM 查询超时。请重新选择资料库后重试。')), timeout);
      this.pending.add(fail);
      channel.port1.onmessage = event => {
        const response = event.data;
        if (response && typeof response === 'object' && typeof response.error === 'string') finish(new Error(response.error));
        else finish(undefined, response as T);
      };
      channel.port1.onmessageerror = () => finish(new Error('无法接收 ZIM 查询结果。'));
      try { worker.postMessage({ action, ...payload }, [channel.port2]); }
      catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
    });
  }
}
