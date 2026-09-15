/**
 * Two-key IndexedDB store, used for exactly one thing: remembering the
 * FileSystemFileHandle of the library the user last had open.
 *
 * A handle cannot be put in localStorage — it is a live object, not a string —
 * but it *is* structured-cloneable, so IndexedDB can hold it. That is what lets
 * Chrome offer "Reopen <file>" after a restart with a single permission click
 * instead of a fresh file picker.
 *
 * Nothing about the user's actual library data is stored here. If this database
 * is cleared, the worst outcome is one extra trip through the file picker.
 */

const DB_NAME = 'kingfisher';
const STORE = 'handles';
const VERSION = 1;

function openDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is not available in this browser.'));
      return;
    }
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore(mode, fn) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req?.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export async function idbGet(key) {
  try {
    return await withStore('readonly', (store) => store.get(key));
  } catch {
    return undefined; // never let a storage quirk break startup
  }
}

export async function idbSet(key, value) {
  try {
    await withStore('readwrite', (store) => store.put(value, key));
    return true;
  } catch {
    return false;
  }
}

export async function idbDelete(key) {
  try {
    await withStore('readwrite', (store) => store.delete(key));
    return true;
  } catch {
    return false;
  }
}
