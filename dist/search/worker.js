import { openDatabase, STORE_NAMES } from '../library/storage.js';
import { searchCorpus } from './rank.js';
import { isRetiredPack } from '../library/source-policy.js';
function read(operation) {
    return new Promise((resolve, reject) => {
        operation.onsuccess = () => resolve(operation.result);
        operation.onerror = () => reject(operation.error ?? new Error('无法读取搜索索引'));
    });
}
async function loadCorpora() {
    const database = await openDatabase();
    try {
        // One fresh readonly snapshot per search prevents stale results after pack installation/removal.
        // Full content is never opened here; only prebuilt documents and entry metadata are read.
        const transaction = database.transaction([STORE_NAMES.manifests, STORE_NAMES.entries, STORE_NAMES.indexes]);
        const [manifests, entries, indexes] = await Promise.all([
            read(transaction.objectStore(STORE_NAMES.manifests).getAll()),
            read(transaction.objectStore(STORE_NAMES.entries).getAll()),
            read(transaction.objectStore(STORE_NAMES.indexes).getAll()),
        ]);
        const documents = new Map(indexes.map(index => [index.packId, index.documents]));
        const grouped = new Map();
        for (const entry of entries) {
            const group = grouped.get(entry.packId) ?? [];
            group.push(entry);
            grouped.set(entry.packId, group);
        }
        return manifests.filter(manifest => !isRetiredPack(manifest.id)).map(manifest => ({ packId: manifest.id, packName: manifest.name,
            entries: (grouped.get(manifest.id) ?? []).map(record => record.entry), documents: documents.get(manifest.id) ?? {} }));
    }
    finally {
        database.close();
    }
}
const scope = globalThis;
scope.onmessage = event => {
    const { kind, id, request } = event.data;
    if (kind !== 'search' || !Number.isSafeInteger(id))
        return;
    void loadCorpora().then(corpora => {
        scope.postMessage({ kind: 'success', id, response: searchCorpus(corpora, request) });
    }).catch(error => {
        scope.postMessage({ kind: 'error', id, message: error instanceof Error ? error.message : '本地搜索失败' });
    });
};
