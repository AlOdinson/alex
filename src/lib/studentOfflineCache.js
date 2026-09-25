import { sha256 } from './ids.js';
import { applyAuthorityOpsInPlace } from './authoritySnapshot.js';

// Display-only, device-local archive. Never installed as the live replica or
// used to grant editing: a new runtime must still synchronize with the owner.
const DB_NAME = 'alex-board-student-view';
const validRevision = (value) => Number.isSafeInteger(value) && value >= 0;
const validSnapshot = (value) => value && Array.isArray(value.canvas?.objects);
const clone = (value) => structuredClone(value);
let database = null;

function openDatabase() {
  if (database) return database;
  database = new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) { reject(new Error('Offline storage unavailable')); return; }
    const request = indexedDB.open(DB_NAME, 1);
    let settled = false;
    const fail = (error) => { if (settled) return; settled = true; clearTimeout(timer); reject(error); };
    const timer = setTimeout(() => fail(new Error('Offline storage did not respond')), 4000);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore('snapshots');
      const commits = db.createObjectStore('commits', { keyPath: ['scope', 'revision'] });
      commits.createIndex('scope', 'scope');
    };
    request.onblocked = () => fail(new Error('Offline storage is blocked'));
    request.onerror = () => fail(request.error);
    request.onsuccess = () => {
      const db = request.result;
      if (settled) { db.close(); return; }
      settled = true; clearTimeout(timer);
      db.onversionchange = () => { db.close(); database = null; };
      db.onclose = () => { database = null; };
      resolve(db);
    };
  }).catch((error) => { database = null; throw error; });
  return database;
}

function transactionDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve(true);
    tx.onabort = () => reject(tx.error ?? new Error('Offline write aborted'));
    tx.onerror = () => reject(tx.error ?? new Error('Offline write failed'));
  });
}

export const studentOfflineStorage = {
  async replace(scope, record) {
    const db = await openDatabase();
    const tx = db.transaction(['snapshots', 'commits'], 'readwrite');
    const done = transactionDone(tx);
    tx.objectStore('snapshots').put(record, scope);
    const cursor = tx.objectStore('commits').index('scope').openCursor(IDBKeyRange.only(scope));
    cursor.onsuccess = () => { if (cursor.result) { cursor.result.delete(); cursor.result.continue(); } };
    return done;
  },
  async append(scope, commit) {
    const db = await openDatabase();
    const tx = db.transaction('commits', 'readwrite');
    const done = transactionDone(tx);
    tx.objectStore('commits').put({ ...commit, scope });
    return done;
  },
  async read(scope) {
    const db = await openDatabase();
    const tx = db.transaction(['snapshots', 'commits'], 'readonly');
    const done = transactionDone(tx);
    let baseline = null, commits = [];
    const first = tx.objectStore('snapshots').get(scope);
    first.onsuccess = () => { baseline = first.result ?? null; };
    const tail = tx.objectStore('commits').index('scope').getAll(IDBKeyRange.only(scope));
    tail.onsuccess = () => { commits = tail.result ?? []; };
    await done;
    return baseline ? { ...baseline, commits } : null;
  },
};

export async function studentOfflineScope(boardId, roomKey) {
  if (!String(boardId ?? '').trim() || !String(roomKey ?? '').trim()) return null;
  // A different URL secret must not expose another locally cached lesson. No
  // plaintext owner/share key is stored in the archive or diagnostics.
  return sha256(`alex-student-view:${boardId}:${roomKey}`);
}

export async function readStudentOfflineSnapshot(boardId, roomKey, { storage = studentOfflineStorage,
  yieldTask = () => new Promise((resolve) => setTimeout(resolve, 0)),
} = {}) {
  try {
    const scope = await studentOfflineScope(boardId, roomKey);
    if (!scope) return null;
    const data = await storage.read(scope);
    if (!validSnapshot(data?.snapshot) || !validRevision(data?.revision)) return null;
    const snapshot = clone(data.snapshot);
    let revision = data.revision;
    let savedAt = data.savedAt;
    const commits = (Array.isArray(data.commits) ? data.commits : []).sort((a, b) => a.revision - b.revision);
    let processed = 0;
    for (const commit of commits) {
      if (!validRevision(commit.revision)) break;
      if (commit.revision <= revision) continue;
      if (commit.revision !== revision + 1 || !Array.isArray(commit.ops)) break;
      applyAuthorityOpsInPlace(snapshot, commit.ops, commit.background ?? null);
      revision = commit.revision; savedAt = commit.savedAt;
      if (++processed % 50 === 0) await yieldTask();
    }
    return { snapshot, revision, savedAt };
  } catch { return null; } // Viewing-cache failure must not prevent live connection.
}

export function createStudentOfflineRecorder({ boardId, roomKey, storage = studentOfflineStorage,
  now = Date.now, onError = () => {},
} = {}) {
  const reportError = (error) => { try { onError(error); } catch { /* optional cache */ } };
  const scope = studentOfflineScope(boardId, roomKey).catch((error) => { reportError(error); return null; });
  // Independent of the network/authority apply queue. Store only a full received
  // baseline and incremental confirmed commits, never serialize Canvas per stroke.
  let queue = Promise.resolve();
  let closed = false;
  const enqueue = (work) => {
    if (closed || !roomKey) return;
    queue = queue.then(async () => { const key = await scope; if (key) await work(key); })
      .catch(reportError);
  };
  return {
    snapshot(snapshot, revision) {
      if (closed || !validSnapshot(snapshot) || !validRevision(revision)) return;
      try {
        const record = { snapshot: clone(snapshot), revision, savedAt: now() };
        enqueue((key) => storage.replace(key, record));
      } catch (error) { reportError(error); }
    },
    commit(commit) {
      if (closed || !validRevision(commit?.revision) || !Array.isArray(commit?.ops) || commit.changed === false) return;
      try {
        const record = { revision: commit.revision, ops: clone(commit.ops),
          background: commit.background ?? null, savedAt: now() };
        enqueue((key) => storage.append(key, record));
      } catch (error) { reportError(error); }
    },
    flush() { return queue; },
    close() { closed = true; }, // Already accepted confirmed writes may finish.
  };
}
