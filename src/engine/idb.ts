/**
 * IndexedDB minimale: serve per ciò che non sta in localStorage (immagini, versioni delle lavagne).
 * Senza IndexedDB (navigazione privata di alcuni browser, test) si ripiega su una mappa in memoria:
 * l'app funziona, ma quei dati durano quanto la pagina.
 */

const DB = "whiteboard";
const VERSION = 1;
export type Store = "assets" | "versions";

let dbP: Promise<IDBDatabase | null> | null = null;
const memory = new Map<Store, Map<string, unknown>>();

function open(): Promise<IDBDatabase | null> {
  if (dbP) return dbP;
  dbP = new Promise((resolve) => {
    if (typeof indexedDB === "undefined") return resolve(null);
    try {
      const req = indexedDB.open(DB, VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("assets")) db.createObjectStore("assets");
        if (!db.objectStoreNames.contains("versions")) db.createObjectStore("versions");
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbP;
}

function mem(store: Store): Map<string, unknown> {
  let m = memory.get(store);
  if (!m) memory.set(store, (m = new Map()));
  return m;
}

function run<T>(store: Store, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T | undefined> {
  return open().then(
    (db) =>
      new Promise<T | undefined>((resolve, reject) => {
        if (!db) return resolve(undefined);
        const tx = db.transaction(store, mode);
        const req = fn(tx.objectStore(store));
        tx.oncomplete = () => resolve(req.result as T);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      }),
  );
}

export async function idbGet<T>(store: Store, key: string): Promise<T | undefined> {
  if (!(await open())) return mem(store).get(key) as T | undefined;
  return run<T>(store, "readonly", (s) => s.get(key));
}

export async function idbPut(store: Store, key: string, value: unknown): Promise<void> {
  if (!(await open())) {
    mem(store).set(key, value);
    return;
  }
  await run(store, "readwrite", (s) => s.put(value, key));
}

export async function idbDelete(store: Store, key: string): Promise<void> {
  if (!(await open())) {
    mem(store).delete(key);
    return;
  }
  await run(store, "readwrite", (s) => s.delete(key));
}

/** Chiavi che iniziano con `prefix` (ordinate). */
export async function idbKeys(store: Store, prefix: string): Promise<string[]> {
  if (!(await open())) return [...mem(store).keys()].filter((k) => k.startsWith(prefix)).sort();
  const range = IDBKeyRange.bound(prefix, prefix + "￿");
  const keys = await run<IDBValidKey[]>(store, "readonly", (s) => s.getAllKeys(range));
  return (keys ?? []).map(String).sort();
}
