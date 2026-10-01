import test from 'node:test';
import assert from 'node:assert/strict';
import { indexedDB, IDBKeyRange, IDBObjectStore } from 'fake-indexeddb';
globalThis.indexedDB = indexedDB;
globalThis.IDBKeyRange = IDBKeyRange;
const request = (req) => new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
const done = (tx) => new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); });
const src = 'data:image/png;base64,aGVsbG8=';
const snapshot = () => ({ boardId: 'lesson', snapshot: { title: 'Lesson', canvas: { objects: [{ type: 'group', objects: [{ type: 'image', src }] }] } }, revision: 0, savedAt: 123 });

// Seed an actual old schema before importing/opening the upgraded cache.
const opening = indexedDB.open('alex-board-student-view', 1);
opening.onupgradeneeded = () => {
  const db = opening.result;
  db.createObjectStore('snapshots');
  db.createObjectStore('commits', { keyPath: ['scope', 'revision'] }).createIndex('scope', 'scope');
};
const legacy = await request(opening);
const seed = legacy.transaction(['snapshots', 'commits'], 'readwrite');
seed.objectStore('snapshots').put(snapshot(), 'legacy-unvisited');
seed.objectStore('commits').put({ scope: 'legacy-unvisited', revision: 1, ops: [{ type: 'patch', patch: { src } }] });
await done(seed);
legacy.close();
const { studentOfflineStorage: storage } = await import('../src/lib/studentOfflineCache.js');
let db;
async function rows(name) {
  db ??= await request(indexedDB.open('alex-board-student-view', 2));
  return request(db.transaction(name).objectStore(name).getAll());
}

test('legacy migration failure rolls back assets and leaves the original readable for retry', async () => {
  const put = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (...args) {
    if (this.name === 'snapshots') throw new DOMException('Injected migration failure', 'QuotaExceededError');
    return put.apply(this, args);
  };
  try { await assert.rejects(storage.list()); }
  finally { IDBObjectStore.prototype.put = put; }
  assert.equal((await rows('images')).length, 0);
  assert.equal((await rows('imageLinks')).length, 0);
  assert.equal((await rows('snapshots'))[0].snapshot.canvas.objects[0].objects[0].src, src);
});

test('ten lessons share one image, hydrate nested objects and patches, and retain until final deletion', async () => {
  for (let i = 0; i < 10; i++) await storage.replace(`scope-${i}`, { ...snapshot(), boardId: `board-${i}` });
  assert.equal((await rows('images')).length, 1);
  assert.equal((await rows('imageLinks')).length, 11);
  assert.match((await rows('snapshots'))[0].snapshot.canvas.objects[0].objects[0].src, /^alex-student-image:sha256:/);
  // The unopened legacy lesson has been swept too.
  assert.match((await rows('commits'))[0].ops[0].patch.src, /^alex-student-image:sha256:/);
  await storage.append('scope-0', { revision: 1, ops: [{ type: 'patch', patch: { src } }] });
  const { studentOfflineStorage: reloaded } = await import('../src/lib/studentOfflineCache.js?reload');
  const hydrated = await reloaded.read('scope-0');
  assert.equal(hydrated.snapshot.canvas.objects[0].objects[0].src, src);
  assert.equal(hydrated.commits[0].ops[0].patch.src, src);
  // Object deletion/baseline compaction cannot drop the board's undo asset.
  await storage.replace('scope-0', { ...snapshot(), boardId: 'board-0', snapshot: { canvas: { objects: [] } } });
  assert.equal((await rows('imageLinks')).length, 11);
  assert.equal((await storage.list()).find(r => r.scope === 'scope-1').boardId, 'board-1');
  await storage.remove('legacy-unvisited');
  for (let i = 0; i < 9; i++) await storage.remove(`scope-${i}`);
  assert.equal((await rows('images')).length, 1);
  assert.equal((await storage.read('scope-9')).snapshot.canvas.objects[0].objects[0].src, src);
  await storage.remove('scope-9');
  assert.equal((await rows('images')).length, 0);
  assert.equal((await rows('imageLinks')).length, 0);
  assert.equal((await storage.list()).length, 0);
  assert.ok((await storage.pendingMediaCleanup()).some(row => row.boardId === 'board-9'));
  await storage.finishMediaCleanup('board-9');
  assert.ok(!(await storage.pendingMediaCleanup()).some(row => row.boardId === 'board-9'));
});

test('a failed snapshot write atomically rolls back new assets and links', async () => {
  const put = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (...args) {
    if (this.name === 'snapshots') throw new DOMException('Injected full disk', 'QuotaExceededError');
    return put.apply(this, args);
  };
  try { await assert.rejects(storage.replace('failed', snapshot()), /Injected full disk/); }
  finally { IDBObjectStore.prototype.put = put; }
  assert.equal((await rows('images')).length, 0);
  assert.equal((await rows('imageLinks')).length, 0);
  assert.equal(await storage.read('failed'), null);
});

test('an aborted deletion retains snapshot, image and membership', async () => {
  await storage.replace('keep', snapshot());
  const original = IDBObjectStore.prototype.delete;
  IDBObjectStore.prototype.delete = function (...args) {
    const result = original.apply(this, args);
    if (this.name === 'images') this.transaction.abort();
    return result;
  };
  try { await assert.rejects(storage.remove('keep')); }
  finally { IDBObjectStore.prototype.delete = original; }
  assert.equal((await rows('images')).length, 1);
  assert.equal((await rows('imageLinks')).length, 1);
  assert.equal((await storage.read('keep')).snapshot.canvas.objects[0].objects[0].src, src);
  await storage.remove('keep');
});

test('late commits cannot resurrect removed archives or create orphan image memberships', async () => {
  await storage.replace('late', snapshot());
  await storage.remove('late');
  await storage.append('late', { revision: 1, ops: [{ type: 'patch', patch: { src } }] });
  assert.equal(await storage.read('late'), null);
  assert.equal((await rows('images')).length, 0);
  assert.equal((await rows('imageLinks')).length, 0);
  assert.equal((await rows('commits')).length, 0);
  // A later explicit baseline remains allowed to recreate the lesson.
  await storage.replace('late', snapshot());
  assert.equal((await storage.read('late')).snapshot.canvas.objects[0].objects[0].src, src);
  await storage.remove('late');
});

test('removing a legacy archive journals cleanup with a durable sentinel', async () => {
  const record = snapshot();
  delete record.boardId;
  await storage.replace('unknown-board', record);
  await storage.remove('unknown-board');
  assert.deepEqual((await storage.pendingMediaCleanup()).find(row => row.legacy), { boardId: null, legacy: true });
  await storage.finishMediaCleanup(null);
  assert.equal((await storage.pendingMediaCleanup()).some(row => row.legacy), false);
});
