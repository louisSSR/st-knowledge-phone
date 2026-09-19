import type { KnowledgeEntry, KnowledgePack, PackManifest } from '../core/types.js';
import { parsePack } from './pack.js';

export const DB_NAME = 'st-knowledge-phone';
export const DB_VERSION = 1;
export const STORE_NAMES = { manifests: 'manifests', indexes: 'indexes', entries: 'entries', content: 'content', values: 'values' } as const;
export interface StoredEntry { key: [string, string]; packId: string; entryId: string; entry: KnowledgeEntry; }
export interface StoredIndex { packId: string; documents: Record<string, string>; }

function request<T>(operation: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    operation.onsuccess = () => resolve(operation.result);
    operation.onerror = () => reject(operation.error ?? new Error('读取本地知识库失败'));
  });
}

function completion(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error('本地知识库事务已中止'));
  });
}

export function openDatabase(): Promise<IDBDatabase> {
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
      if (blocked) { database.close(); return; }
      database.onversionchange = () => database.close();
      resolve(database);
    };
    opening.onerror = () => reject(opening.error ?? new Error('无法打开 IndexedDB'));
    opening.onblocked = () => { blocked = true; reject(new Error('知识库升级被其他页面占用，请关闭旧页面后重试')); };
  });
}

export class PhoneStorage {
  private database: Promise<IDBDatabase> | undefined;
  private disposed = false;

  private db(): Promise<IDBDatabase> {
    if (this.disposed) return Promise.reject(new Error('本地知识库已关闭'));
    this.database ??= openDatabase().catch(error => { this.database = undefined; throw error; });
    return this.database;
  }

  async listPacks(): Promise<PackManifest[]> {
    const database = await this.db();
    return request(database.transaction(STORE_NAMES.manifests).objectStore(STORE_NAMES.manifests).getAll());
  }

  async install(input: KnowledgePack): Promise<void> {
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
    try { await finished; }
    catch (error) {
      if (error instanceof DOMException && error.name === 'ConstraintError') throw new Error('同 ID 知识包已安装，请先卸载');
      throw error;
    }
  }

  async uninstall(id: string): Promise<void> {
    const database = await this.db();
    const transaction = database.transaction([STORE_NAMES.manifests, STORE_NAMES.indexes, STORE_NAMES.entries, STORE_NAMES.content], 'readwrite');
    const finished = completion(transaction);
    transaction.objectStore(STORE_NAMES.manifests).delete(id);
    transaction.objectStore(STORE_NAMES.indexes).delete(id);
    for (const name of [STORE_NAMES.entries, STORE_NAMES.content]) {
      const store = transaction.objectStore(name);
      const cursor = store.index('byPackId').openKeyCursor(IDBKeyRange.only(id));
      cursor.onsuccess = () => { if (cursor.result) { store.delete(cursor.result.primaryKey); cursor.result.continue(); } };
    }
    await finished;
  }

  async readContent(packId: string, contentRef: string): Promise<string> {
    const database = await this.db();
    const result = await request<{ text: string } | undefined>(database.transaction(STORE_NAMES.content).objectStore(STORE_NAMES.content).get([packId, contentRef]));
    if (!result) throw new Error('正文不可用；知识包可能已被卸载');
    return result.text;
  }

  async getEntry(packId: string, entryId: string): Promise<KnowledgeEntry | undefined> {
    const database = await this.db();
    const result = await request<StoredEntry | undefined>(database.transaction(STORE_NAMES.entries).objectStore(STORE_NAMES.entries).get([packId, entryId]));
    return result?.entry;
  }

  async getValue<T>(key: string): Promise<T | undefined> {
    const database = await this.db();
    return request(database.transaction(STORE_NAMES.values).objectStore(STORE_NAMES.values).get(key));
  }

  async setValue(key: string, value: unknown): Promise<void> {
    const database = await this.db();
    const transaction = database.transaction(STORE_NAMES.values, 'readwrite');
    const finished = completion(transaction);
    transaction.objectStore(STORE_NAMES.values).put(value, key);
    await finished;
  }

  dispose(): void {
    this.disposed = true;
    void this.database?.then(database => database.close()).catch(() => undefined);
    this.database = undefined;
  }
}
