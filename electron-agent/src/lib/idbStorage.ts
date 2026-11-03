import type { StateStorage } from 'zustand/middleware';

/**
 * zustand persist 用的 IndexedDB 存储：一个库一个 kv 对象仓，值按字符串存。
 * 给 base64 图片这类放不进 localStorage（5~10MB 总配额）的内容用。
 * 没有 indexedDB（jsdom 单测）时退化成空操作：读不到、写了也不留。
 * 见 .agents/notes/implemented/feature/2026-10-19-composer-draft-full-restore.md
 */

const STORE = 'kv';

function hasIndexedDb(): boolean {
  return typeof indexedDB !== 'undefined' && indexedDB !== null;
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexedDB request failed'));
  });
}

function openDb(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexedDB open failed'));
    req.onblocked = () => reject(new Error('indexedDB open blocked'));
  });
}

export interface IndexedDbStateStorage extends StateStorage {
  /** 列出对象仓键，供按 owner 保存的数据读取兼容旧整表。 */
  getKeys(): Promise<string[]>;
  /** 升级旧桶时只补缺省值，不覆盖另一窗口已提交的新值。 */
  setItemIfAbsent(name: string, value: string): Promise<void>;
}

export function createIdbStorage(dbName: string): IndexedDbStateStorage {
  let dbPromise: Promise<IDBDatabase> | null = null;
  const db = () => {
    if (!dbPromise) {
      dbPromise = openDb(dbName).catch((error) => {
        dbPromise = null;
        throw error;
      });
    }
    return dbPromise;
  };
  const run = async <T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const store = (await db()).transaction(STORE, mode).objectStore(STORE);
    return request(fn(store));
  };

  if (!hasIndexedDb()) {
    return {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
      getKeys: async () => [],
      setItemIfAbsent: async () => {},
    };
  }

  return {
    setItemIfAbsent: async (name, value) => {
      try { await run('readwrite', (store) => store.add(value, name)); }
      catch { /* 已存在或不可写：绝不覆盖另一窗口已存的桶。 */ }
    },
    getKeys: async () => {
      try {
        const keys = await run<IDBValidKey[]>('readonly', (store) => store.getAllKeys());
        return keys.filter((key): key is string => typeof key === 'string');
      } catch { return []; }
    },
    getItem: async (name) => {
      try {
        const value = await run<unknown>('readonly', (store) => store.get(name));
        return typeof value === 'string' ? value : null;
      } catch {
        return null;
      }
    },
    setItem: async (name, value) => {
      try {
        await run('readwrite', (store) => store.put(value, name));
      } catch {
        /* 写不进去（配额、库被删）：下次再试，内存里的内容不受影响 */
      }
    },
    removeItem: async (name) => {
      try {
        await run('readwrite', (store) => store.delete(name));
      } catch {
        /* 同上 */
      }
    },
  };
}
