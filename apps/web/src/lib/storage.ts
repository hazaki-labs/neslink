// ROMs and save states live only in this browser (IndexedDB); nothing is uploaded.

const DB_NAME = "neslink";
const DB_VERSION = 1;

export interface StoredRom {
  hash: string;
  name: string;
  size: number;
  addedAt: number;
  data: Uint8Array<ArrayBuffer>;
}

export interface StoredSave {
  /** `${romHash}:${slot}` */
  id: string;
  romHash: string;
  slot: number;
  savedAt: number;
  state: Uint8Array<ArrayBuffer>;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore("roms", { keyPath: "hash" });
      db.createObjectStore("saves", { keyPath: "id" }).createIndex("romHash", "romHash");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      dbPromise = null;
      reject(request.error);
    };
  });
  return dbPromise;
}

async function run<T>(
  store: "roms" | "saves",
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const request = fn(db.transaction(store, mode).objectStore(store));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export const listRoms = async () =>
  (await run<StoredRom[]>("roms", "readonly", (s) => s.getAll())).sort((a, b) => b.addedAt - a.addedAt);
export const getRom = (hash: string) => run<StoredRom | undefined>("roms", "readonly", (s) => s.get(hash));
export const putRom = (rom: StoredRom) => run("roms", "readwrite", (s) => s.put(rom));
export const deleteRom = (hash: string) => run("roms", "readwrite", (s) => s.delete(hash));

export const getSave = (romHash: string, slot: number) =>
  run<StoredSave | undefined>("saves", "readonly", (s) => s.get(`${romHash}:${slot}`));
export const putSave = (save: Omit<StoredSave, "id">) =>
  run("saves", "readwrite", (s) => s.put({ ...save, id: `${save.romHash}:${save.slot}` }));
