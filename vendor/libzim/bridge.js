/* SPDX-License-Identifier: GPL-3.0-or-later
 * Application-owned bridge to the unmodified OpenZIM javascript-libzim v0.95.
 * Keep this classic worker beside libzim-wasm.wasm: upstream resolves it against self.location.
 */
'use strict';

const readStats = { readCalls: 0, bytesRead: 0, largestRead: 0 };
const nativeRead = FileReaderSync.prototype.readAsArrayBuffer;
FileReaderSync.prototype.readAsArrayBuffer = function (blob) {
  const data = nativeRead.call(this, blob);
  readStats.readCalls += 1;
  readStats.bytesRead += data.byteLength;
  readStats.largestRead = Math.max(readStats.largestRead, data.byteLength);
  return data;
};

let initializationPort = null;
const rejectInitialization = event => {
  if (!initializationPort) return;
  event.preventDefault();
  initializationPort.postMessage({ error: '无法打开 ZIM：文件可能损坏、不完整，或格式不受当前引擎支持。' });
  initializationPort.close();
  initializationPort = null;
};
// WASM initialization can reject asynchronously without raising Worker.onerror in the parent.
self.addEventListener('unhandledrejection', rejectInitialization);
self.addEventListener('error', rejectInitialization);

// Register before upstream: only our operations are intercepted; init uses upstream WORKERFS.
self.addEventListener('message', event => {
  const { action, path, text, limit = 20, offset = 0 } = event.data || {};
  if (action === 'init') { initializationPort = event.ports[0]; return; }
  if (typeof action !== 'string' || !action.startsWith('st-')) return;
  event.stopImmediatePropagation();
  const port = event.ports[0];
  try {
    if (action === 'st-count') { initializationPort = null; return port.postMessage(Module.getArticleCount()); }
    if (action === 'st-stats') return port.postMessage({ ...readStats, wasmHeapBytes: Module.HEAPU8?.byteLength ?? 0 });
    if (action === 'st-read') {
      let entry, item, blob;
      try {
        entry = Module.getEntryByPath(path);
        if (!entry) throw new Error('该条目不存在于当前资料库。');
        item = entry.getItem(true);
        blob = item.getData();
        const content = blob.getContent();
        if (content.byteLength > 64 * 1024 * 1024) throw new Error('该单个条目超过 64 MB，请使用 Kiwix 阅读。');
        const data = new Uint8Array(content);
        const mimeType = item.getMimetype();
        port.postMessage({ data, mimeType }, [data.buffer]);
      } finally {
        blob?.delete(); item?.delete(); entry?.delete();
      }
      return;
    }
    if (action === 'st-search' || action === 'st-suggest') {
      const count = Math.min(1000, offset + limit);
      let vector;
      try {
        vector = action === 'st-search' ? Module.searchWithSnippets(text, count) : Module.suggest(text, count);
        const hits = [];
        for (let i = offset; i < vector.size() && hits.length < limit; i += 1) {
          const result = vector.get(i);
          try {
            const hit = { path: result.getPath(), title: result.getTitle() };
            if (action === 'st-search') {
              // Snippets contain upstream highlighting HTML. Consumers receive inert plain text.
              try { hit.snippet = result.getSnippet().replace(/<[^>]*>/g, '').slice(0, 1200); } catch { /* optional upstream feature */ }
            }
            hits.push(hit);
          } finally { result.delete(); }
        }
        port.postMessage(hits);
      } finally { vector?.delete(); }
      return;
    }
    throw new Error('不支持的 ZIM 操作。');
  } catch (error) {
    port.postMessage({ error: error instanceof Error ? error.message : 'ZIM 读取失败，请重新选择资料库。' });
  } finally { port.close(); }
});

importScripts('./libzim-wasm.js');
