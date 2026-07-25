const DB_NAME = 'alex-board-cache';
const SNAPSHOT_STORE = 'snapshots';
const PENDING_STORE = 'pendingActions';
const DB_VERSION = 2;

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(SNAPSHOT_STORE)) {
        db.createObjectStore(SNAPSHOT_STORE);
      }
      if (!db.objectStoreNames.contains(PENDING_STORE)) {
        const store = db.createObjectStore(PENDING_STORE, { keyPath: 'actionId' });
        store.createIndex('boardId', 'boardId', { unique: false });
        store.createIndex('createdAt', 'createdAt', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore(storeName, mode, handler) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    let result;
    try {
      result = handler(store);
    } catch (error) {
      reject(error);
      return;
    }
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function getCachedSnapshot(boardId) {
  try {
    const db = await openDatabase();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(SNAPSHOT_STORE, 'readonly');
      const request = tx.objectStore(SNAPSHOT_STORE).get(boardId);
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => reject(request.error);
    });
  } catch {
    return null;
  }
}

export async function setCachedSnapshot(boardId, value) {
  try {
    await withStore(SNAPSHOT_STORE, 'readwrite', (store) => store.put(value, boardId));
  } catch {
    // IndexedDB may be blocked in private browsing. The live board still works.
  }
}

export async function enqueuePendingAction(action) {
  if (!action?.actionId || !action?.boardId) return;
  try {
    await withStore(PENDING_STORE, 'readwrite', (store) => store.put(action));
  } catch {
    // The online retry path still works when IndexedDB is unavailable.
  }
}

export async function removePendingAction(actionId) {
  if (!actionId) return;
  try {
    await withStore(PENDING_STORE, 'readwrite', (store) => store.delete(actionId));
  } catch {
    // Ignore cache failures after the server has already confirmed the action.
  }
}

export async function getPendingActions(boardId) {
  try {
    const db = await openDatabase();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(PENDING_STORE, 'readonly');
      const store = tx.objectStore(PENDING_STORE);
      const index = store.index('boardId');
      const request = index.getAll(IDBKeyRange.only(boardId));
      request.onsuccess = () => {
        const actions = Array.isArray(request.result) ? request.result : [];
        actions.sort((a, b) => Number(a.createdAt ?? 0) - Number(b.createdAt ?? 0));
        resolve(actions);
      };
      request.onerror = () => reject(request.error);
    });
  } catch {
    return [];
  }
}

export async function countPendingActions(boardId) {
  try {
    const db = await openDatabase();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(PENDING_STORE, 'readonly');
      const request = tx.objectStore(PENDING_STORE).index('boardId').count(IDBKeyRange.only(boardId));
      request.onsuccess = () => resolve(Number(request.result ?? 0));
      request.onerror = () => reject(request.error);
    });
  } catch {
    return 0;
  }
}
