const DB_NAME = 'alex-board-cache';
const SNAPSHOT_STORE = 'snapshots';
const PENDING_STORE = 'pendingActions';
const CONFIRMED_STORE = 'confirmedActions';
const CLIPBOARD_STORE = 'clipboard';
const CROSS_BOARD_CLIPBOARD_KEY = 'cross-board-selection';
const DB_VERSION = 5;

function ensureIndex(store, name, keyPath, options = {}) {
  if (!store.indexNames.contains(name)) store.createIndex(name, keyPath, options);
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      const tx = request.transaction;

      if (!db.objectStoreNames.contains(SNAPSHOT_STORE)) db.createObjectStore(SNAPSHOT_STORE);

      const pendingStore = db.objectStoreNames.contains(PENDING_STORE)
        ? tx.objectStore(PENDING_STORE)
        : db.createObjectStore(PENDING_STORE, { keyPath: 'actionId' });
      ensureIndex(pendingStore, 'boardId', 'boardId', { unique: false });
      ensureIndex(pendingStore, 'createdAt', 'createdAt', { unique: false });
      ensureIndex(pendingStore, 'boardCreatedAt', ['boardId', 'createdAt'], { unique: false });

      const confirmedStore = db.objectStoreNames.contains(CONFIRMED_STORE)
        ? tx.objectStore(CONFIRMED_STORE)
        : db.createObjectStore(CONFIRMED_STORE, { keyPath: 'cacheKey' });
      ensureIndex(confirmedStore, 'boardId', 'boardId', { unique: false });
      ensureIndex(confirmedStore, 'revision', 'revision', { unique: false });
      ensureIndex(confirmedStore, 'createdAt', 'createdAt', { unique: false });
      ensureIndex(confirmedStore, 'boardRevision', ['boardId', 'revision'], { unique: false });

      if (!db.objectStoreNames.contains(CLIPBOARD_STORE)) db.createObjectStore(CLIPBOARD_STORE);
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

function getAllByBoard(storeName, boardId) {
  return openDatabase().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const request = store.index('boardId').getAll(IDBKeyRange.only(boardId));
    request.onsuccess = () => resolve(Array.isArray(request.result) ? request.result : []);
    request.onerror = () => reject(request.error);
  }));
}

function approximateBytes(value) {
  try {
    return JSON.stringify(value).length * 2;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
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
  if (!action?.actionId || !action?.boardId) return false;
  try {
    await withStore(PENDING_STORE, 'readwrite', (store) => store.put(action));
    return true;
  } catch {
    return false;
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

export async function removePendingActions(actionIds) {
  const ids = [...new Set((Array.isArray(actionIds) ? actionIds : []).filter(Boolean))];
  if (!ids.length) return;
  try {
    const db = await openDatabase();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(PENDING_STORE, 'readwrite');
      const store = tx.objectStore(PENDING_STORE);
      ids.forEach((id) => store.delete(id));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } catch {
    // Server state remains authoritative.
  }
}

export async function confirmPendingActions(entries) {
  const safeEntries = (Array.isArray(entries) ? entries : [])
    .filter((entry) => entry?.action?.actionId && entry?.action?.boardId);
  if (!safeEntries.length) return;

  try {
    const db = await openDatabase();
    await new Promise((resolve, reject) => {
      const tx = db.transaction([PENDING_STORE, CONFIRMED_STORE], 'readwrite');
      const pending = tx.objectStore(PENDING_STORE);
      const confirmed = tx.objectStore(CONFIRMED_STORE);

      safeEntries.forEach(({ action, result }) => {
        pending.delete(action.actionId);
        const revision = Number(result?.revision ?? action?.knownRevision ?? 0);
        const appliedOps = Array.isArray(result?.appliedOps) ? result.appliedOps : [];
        const appliedBackground = result?.appliedBackground ?? null;
        const changed = result?.changed !== false
          && (appliedOps.length > 0 || appliedBackground !== null);
        if (!changed) return;
        confirmed.put({
          cacheKey: `${action.boardId}:${revision}:${action.actionId}`,
          actionId: action.actionId,
          boardId: action.boardId,
          clientId: action.clientId ?? '',
          revision,
          ops: appliedOps,
          background: appliedBackground,
          createdAt: Number(action.createdAt ?? Date.now()),
          confirmedAt: Date.now(),
        });
      });

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } catch {
    // If IndexedDB is unavailable the server remains the durable source of truth.
  }
}

export async function confirmPendingAction(action, result) {
  return confirmPendingActions([{ action, result }]);
}

export async function getOldestPendingActions(boardId, limit = 24, maxBytes = 700_000) {
  const safeLimit = Math.max(1, Math.min(100, Number(limit ?? 24)));
  const safeMaxBytes = Math.max(32_000, Number(maxBytes ?? 700_000));
  try {
    const db = await openDatabase();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(PENDING_STORE, 'readonly');
      const store = tx.objectStore(PENDING_STORE);
      const index = store.index('boardCreatedAt');
      const range = IDBKeyRange.bound([boardId, Number.MIN_SAFE_INTEGER], [boardId, Number.MAX_SAFE_INTEGER]);
      const request = index.openCursor(range, 'next');
      const result = [];
      let bytes = 0;
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor || result.length >= safeLimit) {
          resolve(result);
          return;
        }
        const storedBytes = Number(cursor.value?.byteSize ?? 0);
        const nextBytes = storedBytes > 0 ? storedBytes : approximateBytes(cursor.value);
        if (result.length > 0 && bytes + nextBytes > safeMaxBytes) {
          resolve(result);
          return;
        }
        result.push(cursor.value);
        bytes += nextBytes;
        cursor.continue();
      };
      request.onerror = () => reject(request.error);
    });
  } catch {
    return [];
  }
}

export async function getPendingActions(boardId) {
  try {
    const actions = await getAllByBoard(PENDING_STORE, boardId);
    actions.sort((a, b) => Number(a.createdAt ?? 0) - Number(b.createdAt ?? 0));
    return actions;
  } catch {
    return [];
  }
}

export async function getConfirmedActionsAfter(boardId, revision = 0) {
  try {
    const db = await openDatabase();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(CONFIRMED_STORE, 'readonly');
      const store = tx.objectStore(CONFIRMED_STORE);
      const index = store.index('boardRevision');
      const range = IDBKeyRange.bound(
        [boardId, Number(revision ?? 0) + 1],
        [boardId, Number.MAX_SAFE_INTEGER],
      );
      const request = index.getAll(range);
      request.onsuccess = () => resolve((Array.isArray(request.result) ? request.result : [])
        .sort((a, b) => Number(a.revision ?? 0) - Number(b.revision ?? 0)
          || Number(a.createdAt ?? 0) - Number(b.createdAt ?? 0)));
      request.onerror = () => reject(request.error);
    });
  } catch {
    return [];
  }
}

export async function pruneConfirmedActionsThrough(boardId, revision) {
  try {
    const db = await openDatabase();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(CONFIRMED_STORE, 'readwrite');
      const store = tx.objectStore(CONFIRMED_STORE);
      const request = store.index('boardId').openCursor(IDBKeyRange.only(boardId));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        if (Number(cursor.value?.revision ?? 0) <= Number(revision ?? 0)) cursor.delete();
        cursor.continue();
      };
      request.onerror = () => reject(request.error);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } catch {
    // Cache compaction is optional.
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

export async function setCrossBoardClipboard(value) {
  try {
    await withStore(CLIPBOARD_STORE, 'readwrite', (store) => (
      value ? store.put(value, CROSS_BOARD_CLIPBOARD_KEY) : store.delete(CROSS_BOARD_CLIPBOARD_KEY)
    ));
    return true;
  } catch {
    return false;
  }
}

export async function getCrossBoardClipboard() {
  try {
    const db = await openDatabase();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(CLIPBOARD_STORE, 'readonly');
      const request = tx.objectStore(CLIPBOARD_STORE).get(CROSS_BOARD_CLIPBOARD_KEY);
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => reject(request.error);
    });
  } catch {
    return null;
  }
}

export async function clearBoardCache(boardId) {
  try {
    const db = await openDatabase();
    await new Promise((resolve, reject) => {
      const tx = db.transaction([SNAPSHOT_STORE, PENDING_STORE, CONFIRMED_STORE], 'readwrite');
      tx.objectStore(SNAPSHOT_STORE).delete(boardId);
      [PENDING_STORE, CONFIRMED_STORE].forEach((storeName) => {
        const store = tx.objectStore(storeName);
        const request = store.index('boardId').openCursor(IDBKeyRange.only(boardId));
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) return;
          cursor.delete();
          cursor.continue();
        };
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } catch {
    // Removing the board from the server/local library is still authoritative.
  }
}
