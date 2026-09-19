import { parsePack } from './pack.js';
export const DB_NAME = 'st-knowledge-phone';
export const DB_VERSION = 1;
export const STORE_NAMES = { manifests: 'manifests', indexes: 'indexes', entries: 'entries', content: 'content', values: 'values' };
function request(operation) {
    return new Promise((resolve, reject) => {
        operation.onsuccess = () => resolve(operation.result);
        operation.onerror = () => reject(operation.error ?? new Error('读取本地知识库失败'));
    });
}
function completion(transaction) {
    return new Promise((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onabort = () => reject(transaction.error ?? new Error('本地知识库事务已中止'));
    });
}
export function openDatabase() {
    return new Promise((resolve, reject) => {
        let blocked = false;
        const opening = indexedDB.open(DB_NAME, DB_VERSION);
        opening.onupgradeneeded = () => {
            const database = opening.result;
            database.createObjectStore(STORE_NAMES.manifests, { keyPath: 'id' });
            database.createObjectStore(STORE_NAMES.indexes, { keyPath: 'packId' });
            for (const name of [STORE_NAMES.entries, STORE_NAMES.content]) {
                database.createObjectStore(name, { keyPath: 'key' }).createIndex('byPackId', 'packId', { unique: false });
            }
            database.createObjectStore(STORE_NAMES.values);
        };
        opening.onsuccess = () => {
            const database = opening.result;
            if (blocked) {
                database.close();
                return;
            }
            database.onversionchange = () => database.close();
            resolve(database);
        };
        opening.onerror = () => reject(opening.error ?? new Error('无法打开 IndexedDB'));
        opening.onblocked = () => { blocked = true; reject(new Error('知识库升级被其他页面占用，请关闭旧页面后重试')); };
    });
}
/** Clear this extension's data atomically without waiting for other tabs to close. */
export async function clearDatabase() {
    const database = await openDatabase();
    try {
        await new Promise((resolve, reject) => {
            const names = Array.from(database.objectStoreNames);
            const transaction = database.transaction(names, 'readwrite');
            transaction.oncomplete = () => resolve();
            transaction.onabort = () => reject(transaction.error ?? new Error('清理本地知识库的事务已中止'));
            try {
                for (const name of names)
                    transaction.objectStore(name).clear();
            }
            catch (error) {
                transaction.abort();
                reject(error);
            }
        });
    }
    finally {
        database.close();
    }
}
export class PhoneStorage {
    database;
    disposed = false;
    db() {
        if (this.disposed)
            return Promise.reject(new Error('本地知识库已关闭'));
        this.database ??= openDatabase().catch(error => { this.database = undefined; throw error; });
        return this.database;
    }
    async listPacks() {
        const database = await this.db();
        return request(database.transaction(STORE_NAMES.manifests).objectStore(STORE_NAMES.manifests).getAll());
    }
    async install(input) {
        const pack = parsePack(input);
        const database = await this.db();
        const transaction = database.transaction([STORE_NAMES.manifests, STORE_NAMES.indexes, STORE_NAMES.entries, STORE_NAMES.content], 'readwrite');
        const finished = completion(transaction);
        transaction.objectStore(STORE_NAMES.manifests).add(pack.manifest);
        transaction.objectStore(STORE_NAMES.indexes).add({ packId: pack.manifest.id, documents: pack.index.documents });
        for (const entry of pack.entries) {
            transaction.objectStore(STORE_NAMES.entries).add({ key: [pack.manifest.id, entry.id], packId: pack.manifest.id, entryId: entry.id, entry });
            transaction.objectStore(STORE_NAMES.content).add({ key: [pack.manifest.id, entry.contentRef], packId: pack.manifest.id, text: pack.content[entry.contentRef] });
        }
        try {
            await finished;
        }
        catch (error) {
            if (error instanceof DOMException && error.name === 'ConstraintError')
                throw new Error('同 ID 知识包已安装，请先卸载');
            throw error;
        }
    }
    async uninstall(id) {
        const database = await this.db();
        const transaction = database.transaction([STORE_NAMES.manifests, STORE_NAMES.indexes, STORE_NAMES.entries, STORE_NAMES.content], 'readwrite');
        const finished = completion(transaction);
        transaction.objectStore(STORE_NAMES.manifests).delete(id);
        transaction.objectStore(STORE_NAMES.indexes).delete(id);
        for (const name of [STORE_NAMES.entries, STORE_NAMES.content]) {
            const store = transaction.objectStore(name);
            const cursor = store.index('byPackId').openKeyCursor(IDBKeyRange.only(id));
            cursor.onsuccess = () => { if (cursor.result) {
                store.delete(cursor.result.primaryKey);
                cursor.result.continue();
            } };
        }
        await finished;
    }
    async readContent(packId, contentRef) {
        const database = await this.db();
        const result = await request(database.transaction(STORE_NAMES.content).objectStore(STORE_NAMES.content).get([packId, contentRef]));
        if (!result)
            throw new Error('正文不可用；知识包可能已被卸载');
        return result.text;
    }
    async getEntry(packId, entryId) {
        const database = await this.db();
        const result = await request(database.transaction(STORE_NAMES.entries).objectStore(STORE_NAMES.entries).get([packId, entryId]));
        return result?.entry;
    }
    async getValue(key) {
        const database = await this.db();
        return request(database.transaction(STORE_NAMES.values).objectStore(STORE_NAMES.values).get(key));
    }
    async setValue(key, value) {
        const database = await this.db();
        const transaction = database.transaction(STORE_NAMES.values, 'readwrite');
        const finished = completion(transaction);
        transaction.objectStore(STORE_NAMES.values).put(value, key);
        await finished;
    }
    dispose() {
        this.disposed = true;
        void this.database?.then(database => database.close()).catch(() => undefined);
        this.database = undefined;
    }
}
