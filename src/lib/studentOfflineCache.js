import { withLocalFileLifecycle } from './localFileLifecycle.js';
import { deleteCachedSnapshot } from './idb.js';
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
    const request = indexedDB.open(DB_NAME, 2);
    let settled = false;
    const fail = (error) => { if (settled) return; settled = true; clearTimeout(timer); reject(error); };
    const timer = setTimeout(() => fail(new Error('Offline storage did not respond')), 4000);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('snapshots')) db.createObjectStore('snapshots');
      if (!db.objectStoreNames.contains('commits')) {
        const commits = db.createObjectStore('commits', { keyPath: ['scope', 'revision'] });
        commits.createIndex('scope', 'scope');
      }
      db.createObjectStore('images');
      db.createObjectStore('pendingMediaCleanup');
      const links = db.createObjectStore('imageLinks', { keyPath: ['scope', 'hash'] });
      links.createIndex('scope', 'scope');
      links.createIndex('hash', 'hash');
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

const STORES = ['snapshots', 'commits', 'images', 'imageLinks', 'pendingMediaCleanup'];
const IMAGE_REF = 'alex-student-image:sha256:';
const requestValue = (request) => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

function visitSources(value, visit) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (key === 'src' && typeof child === 'string') visit(value, child);
    else if (child && typeof child === 'object') visitSources(child, visit);
  }
}

async function normalizeImages(record) {
  const value = clone(record), images = new Map(), sources = new Map();
  visitSources(value, (object, src) => {
    if (/^data:image\//i.test(src)) {
      if (!sources.has(src)) sources.set(src, []);
      sources.get(src).push(object);
    }
  });
  // Hash before opening a write transaction: crypto promises can outlive IDB.
  await Promise.all([...sources].map(async ([src, objects]) => {
    const hash = await sha256(src);
    images.set(hash, src);
    for (const object of objects) object.src = IMAGE_REF + hash;
  }));
  return { value, images };
}

async function writeTransaction(db, work) {
  const tx = db.transaction(STORES, 'readwrite'), done = transactionDone(tx);
  try { work(tx); } catch (error) {
    tx.abort();
    await done.catch(() => {});
    throw error;
  }
  return done;
}

function storeImages(tx, scope, images) {
  for (const [hash, src] of images) {
    tx.objectStore('images').put(src, hash);
    tx.objectStore('imageLinks').put({ scope, hash });
  }
}

// Visit every legacy record, including unopened lessons. A concurrent tab may
// have changed/deleted a record during hashing; only replace the exact version
// we read. Retrying the sweep on the next open is harmless after interruption.
let migratedDatabase = null;
async function readyDatabase() {
  const db = await openDatabase();
  if (migratedDatabase?.db === db) { await migratedDatabase.promise; return db; }
  const promise = (async () => {
    const read = db.transaction(['snapshots', 'commits'], 'readonly');
    const done = transactionDone(read);
    const inventories = await Promise.all(['snapshots', 'commits'].map(async (name) => ({
      name, keys: await requestValue(read.objectStore(name).getAllKeys()),
    })));
    await done;
    // Inventory keys only: never materialize every lesson's inline image data
    // together on memory-constrained tablets.
    for (const { name, keys } of inventories) for (const key of keys) {
      const readOne = db.transaction(name, 'readonly'), readDone = transactionDone(readOne);
      const original = await requestValue(readOne.objectStore(name).get(key));
      await readDone;
      if (!original) continue;
      const normalized = await normalizeImages(original);
      if (!normalized.images.size) continue;
      const tx = db.transaction(STORES, 'readwrite'), complete = transactionDone(tx);
      const store = tx.objectStore(name), current = store.get(key);
      current.onsuccess = () => {
        try {
          if (JSON.stringify(current.result) !== JSON.stringify(original)) return;
          storeImages(tx, name === 'snapshots' ? key : original.scope, normalized.images);
          if (name === 'snapshots') store.put(normalized.value, key);
          else store.put(normalized.value);
        } catch { tx.abort(); }
      };
      await complete;
    }
  })();
  migratedDatabase = { db, promise };
  try { await promise; } catch (error) { migratedDatabase = null; throw error; }
  return db;
}

export const studentOfflineStorage = {
  async replace(scope, record) {
    const normalized = await normalizeImages(record);
    const db = await readyDatabase();
    return withLocalFileLifecycle(() => writeTransaction(db, (tx) => {
      storeImages(tx, scope, normalized.images);
      tx.objectStore('snapshots').put(normalized.value, scope);
      const cursor = tx.objectStore('commits').index('scope').openCursor(IDBKeyRange.only(scope));
      cursor.onsuccess = () => { if (cursor.result) { cursor.result.delete(); cursor.result.continue(); } };
    }));
  },
  async append(scope, commit) {
    const normalized = await normalizeImages({ ...commit, scope });
    const db = await readyDatabase();
    return withLocalFileLifecycle(() => writeTransaction(db, (tx) => {
      const baseline = tx.objectStore('snapshots').get(scope);
      baseline.onsuccess = () => {
        if (!baseline.result) return; // A late commit must not resurrect a deleted archive.
        try {
          storeImages(tx, scope, normalized.images);
          tx.objectStore('commits').put(normalized.value);
        } catch { tx.abort(); }
      };
    }));
  },
  async read(scope) {
    const db = await readyDatabase();
    const tx = db.transaction(STORES, 'readonly');
    const done = transactionDone(tx);
    let baseline = null, commits = [];
    const hydrate = (value) => {
      visitSources(value, (object, src) => {
        if (!src.startsWith(IMAGE_REF)) return;
        const image = tx.objectStore('images').get(src.slice(IMAGE_REF.length));
        image.onsuccess = () => {
          if (typeof image.result !== 'string') { tx.abort(); return; }
          object.src = image.result;
        };
      });
    };
    const first = tx.objectStore('snapshots').get(scope);
    first.onsuccess = () => { baseline = first.result ?? null; hydrate(baseline); };
    const tail = tx.objectStore('commits').index('scope').getAll(IDBKeyRange.only(scope));
    tail.onsuccess = () => { commits = tail.result ?? []; hydrate(commits); };
    await done;
    return baseline ? { ...baseline, commits } : null;
  },
  async list() {
    const db = await readyDatabase();
    const tx = db.transaction('snapshots', 'readonly'), done = transactionDone(tx);
    const entries = [], cursor = tx.objectStore('snapshots').openCursor();
    cursor.onsuccess = () => {
      const row = cursor.result;
      if (!row) return;
      const value = row.value;
      entries.push({ scope: row.key, boardId: value.boardId ?? null,
        title: value.title ?? value.snapshot?.title ?? null,
        revision: value.revision, savedAt: value.savedAt });
      row.continue();
    };
    await done;
    return entries;
  },
  async pendingMediaCleanup() {
    const db = await readyDatabase();
    const tx = db.transaction('pendingMediaCleanup', 'readonly'), done = transactionDone(tx);
    const rows = await requestValue(tx.objectStore('pendingMediaCleanup').getAll());
    await done;
    return rows;
  },
  async finishMediaCleanup(boardId) {
    const db = await readyDatabase();
    return writeTransaction(db, (tx) => tx.objectStore('pendingMediaCleanup').delete(boardId ?? '__legacy__'));
  },
  async remove(scope) {
    const db = await readyDatabase();
    const tx = db.transaction(STORES, 'readwrite'), done = transactionDone(tx);
    const baseline = tx.objectStore('snapshots').get(scope);
    baseline.onsuccess = () => {
      try {
        if (baseline.result?.boardId) tx.objectStore('pendingMediaCleanup').put({ boardId: baseline.result.boardId }, baseline.result.boardId);
        else if (baseline.result) tx.objectStore('pendingMediaCleanup').put({ boardId: null, legacy: true }, '__legacy__');
      } catch { tx.abort(); }
    };
    tx.objectStore('snapshots').delete(scope);
    const commits = tx.objectStore('commits').index('scope').openCursor(IDBKeyRange.only(scope));
    commits.onsuccess = () => { if (commits.result) { commits.result.delete(); commits.result.continue(); } };
    const links = tx.objectStore('imageLinks');
    const cursor = links.index('scope').openCursor(IDBKeyRange.only(scope));
    cursor.onsuccess = () => {
      const row = cursor.result;
      if (!row) return;
      const hash = row.value.hash;
      row.delete();
      const count = links.index('hash').count(IDBKeyRange.only(hash));
      count.onsuccess = () => { if (count.result === 0) tx.objectStore('images').delete(hash); };
      row.continue();
    };
    return done;
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
        const record = { boardId, snapshot: clone(snapshot), revision, savedAt: now() };
        enqueue(async (key) => { await storage.replace(key, record); await deleteCachedSnapshot(boardId); });
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
