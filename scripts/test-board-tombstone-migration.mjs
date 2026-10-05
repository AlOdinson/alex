import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory, IDBKeyRange, IDBObjectStore } from 'fake-indexeddb';
import * as store from '../src/lib/browserAuthorityStore.js';

Object.assign(globalThis, { IDBKeyRange });
const name = 'alex-board-authority';
const req = r => new Promise((yes, no) => { r.onsuccess = () => yes(r.result); r.onerror = () => no(r.error); });
const complete = tx => new Promise((yes, no) => { tx.oncomplete = yes; tx.onabort = tx.onerror = () => no(tx.error); });
const snapshot = { version: 2, background: 'blank', canvas: { objects: [{ type: 'Path', boardObjectId: 'kept', path: [['M', 0, 0], ['L', 9, 4]] }] } };
const deleted = count => Object.fromEntries(Array.from({ length: count }, (_, i) => [`old-${i}`, { clientId: 'teacher', actionId: `gone-${i}`, mutationId: `m-${i}`, revision: i + 1 }]));
const metadata = (boardId, tombstones) => ({ boardId, ownerKey: 'owner', title: 'Saved lesson', revision: 12, snapshotRevision: 12, tombstones });

async function seed({ boardId = 'legacy', count = 300 } = {}) {
  globalThis.indexedDB = new IDBFactory();
  const opening = indexedDB.open(name, 3);
  opening.onupgradeneeded = () => {
    const db = opening.result;
    db.createObjectStore('boards', { keyPath: 'boardId' });
    db.createObjectStore('snapshots', { keyPath: 'boardId' });
    const commits = db.createObjectStore('commits', { keyPath: 'actionKey' });
    commits.createIndex('boardRevision', ['boardId', 'revision'], { unique: true }); commits.createIndex('boardId', 'boardId');
    db.createObjectStore('assets', { keyPath: 'assetKey' }).createIndex('boardId', 'boardId');
    db.createObjectStore('notebookTombstones', { keyPath: ['boardId', 'childKey'] }).createIndex('boardId', 'boardId');
    const outbox = db.createObjectStore('notebookOutbox', { keyPath: 'sequence', autoIncrement: true });
    outbox.createIndex('pendingAction', ['boardId', 'clientId', 'actionId'], { unique: true });
    outbox.createIndex('boardClient', ['boardId', 'clientId']); outbox.createIndex('boardId', 'boardId');
  };
  const db = await req(opening), tx = db.transaction([...db.objectStoreNames], 'readwrite'), done = complete(tx);
  const tombstones = deleted(count);
  tx.objectStore('boards').add(metadata(boardId, tombstones));
  tx.objectStore('snapshots').add({ boardId, snapshot });
  tx.objectStore('commits').add({ boardId, revision: 12, actionKey: `${boardId}:saved`, actionId: 'saved', ops: [] });
  tx.objectStore('assets').add({ boardId, assetKey: 'old-image', bytes: new Uint8Array([1, 2, 3]) });
  tx.objectStore('notebookTombstones').add({ boardId, childKey: 'book:1:child', value: { mutationId: 'child-del' } });
  tx.objectStore('notebookOutbox').add({ boardId, clientId: 'writer', actionId: 'unsent', action: { ops: [] } });
  await done; db.close(); return { tombstones, boardId };
}
async function rows(table) {
  const db = await req(indexedDB.open(name));
  try { return await req(db.transaction(table).objectStore(table).getAll()); } finally { db.close(); }
}
async function edit(table, value) {
  const db = await req(indexedDB.open(name));
  try { const tx = db.transaction(table, 'readwrite'), done = complete(tx); tx.objectStore(table).put(value); await done; } finally { db.close(); }
}
function migrate(...args) {
  assert.equal(typeof store.migrateAuthorityBoardTombstones, 'function', 'safe incremental tombstone migration is missing');
  return store.migrateAuthorityBoardTombstones(...args);
}

for (const count of [0, 300, 10000]) test(`v3 migration copies ${count} deletions in bounded transactions and preserves lesson/outbox`, async () => {
  const { tombstones, boardId } = await seed({ count });
  const protectedStores = ['snapshots', 'notebookOutbox', 'notebookTombstones', 'commits', 'assets'];
  const before = await Promise.all(protectedStores.map(rows)), batches = [];
  assert.deepEqual((await store.getAuthorityBoard(boardId)).tombstones, tombstones);
  await migrate(boardId, { batchSize: 128, onProgress: event => batches.push(event) });
  const loaded = await store.getAuthorityBoard(boardId), meta = await store.getAuthorityBoardMetadata(boardId);
  assert.deepEqual(loaded.tombstones, tombstones); assert.deepEqual(loaded.snapshot, snapshot);
  assert.equal(loaded.revision, 12); assert.equal(meta.tombstoneStorageVersion, 1);
  assert.equal(Object.hasOwn(meta, 'tombstones'), false, 'hot metadata still holds the full table');
  const actual = await rows('boardTombstones'); assert.equal(actual.length, count);
  assert.deepEqual(Object.fromEntries(actual.map(row => [row.objectId, row.value])), tombstones);
  assert.equal((await rows('boardTombstoneMigrations')).length, 0);
  assert.deepEqual((await rows('boardTombstoneBackups'))[0].tombstones, tombstones);
  assert.deepEqual(await Promise.all(protectedStores.map(rows)), before);
  assert.ok(batches.every((event, i) => event.copied - (batches[i - 1]?.copied ?? 0) <= 128));
  const countBefore = actual.length; await migrate(boardId);
  assert.equal((await rows('boardTombstones')).length, countBefore);
});

test('quota failure in a later copy transaction keeps old data and resumes without duplicate rows', async () => {
  const { tombstones, boardId } = await seed();
  const put = IDBObjectStore.prototype.put; let copies = 0;
  IDBObjectStore.prototype.put = function(value, ...args) {
    if (this.name === 'boardTombstones' && ++copies === 130) throw new DOMException('disk full', 'QuotaExceededError');
    return put.call(this, value, ...args);
  };
  try { await assert.rejects(migrate(boardId), { name: 'QuotaExceededError' }); }
  finally { IDBObjectStore.prototype.put = put; }
  assert.deepEqual((await store.getAuthorityBoard(boardId)).tombstones, tombstones);
  assert.equal((await rows('boardTombstoneMigrations'))[0].cursor, 128);
  assert.equal((await rows('boardTombstones')).length, 128, 'failed batch was partly committed');
  await migrate(boardId); assert.deepEqual((await store.getAuthorityBoard(boardId)).tombstones, tombstones);
  assert.equal((await rows('boardTombstones')).length, 300);
});

test('failure at the final switch leaves the original table readable and the staged copy retryable', async () => {
  const { tombstones, boardId } = await seed();
  const put = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function(value, ...args) {
    if (this.name === 'boards' && value.tombstoneStorageVersion === 1) throw new DOMException('switch full', 'QuotaExceededError');
    return put.call(this, value, ...args);
  };
  try { await assert.rejects(migrate(boardId), { name: 'QuotaExceededError' }); }
  finally { IDBObjectStore.prototype.put = put; }
  assert.deepEqual((await rows('boards'))[0].tombstones, tombstones);
  assert.equal((await rows('boardTombstoneMigrations'))[0].cursor, 300);
  await migrate(boardId); assert.deepEqual((await store.getAuthorityBoard(boardId)).tombstones, tombstones);
});

test('interrupted migration blocks new-format commits until its copy is safely complete', async () => {
  const { tombstones, boardId } = await seed(); const controller = new AbortController();
  await assert.rejects(migrate(boardId, { signal: controller.signal, onProgress: () => controller.abort() }), { name: 'AbortError' });
  assert.deepEqual((await store.getAuthorityBoard(boardId)).tombstones, tombstones);
  await store.persistAuthorityCommit(boardId, { actionId: 'next', clientId: 'writer', revision: 13, ops: [{ type: 'delete', id: 'late' }] });
  const loaded = await store.getAuthorityBoard(boardId);
  assert.equal(loaded.revision, 13); assert.equal(loaded.tombstones.late.actionId, 'next');
  assert.deepEqual(Object.fromEntries(Object.entries(loaded.tombstones).filter(([id]) => id !== 'late')), tombstones);
  assert.equal(Object.hasOwn(await store.getAuthorityBoardMetadata(boardId), 'tombstones'), false);
});

test('two migration callers share progress without losing deletions', async () => {
  const { tombstones, boardId } = await seed({ count: 1000 });
  await Promise.all([migrate(boardId, { batchSize: 51 }), migrate(boardId, { batchSize: 73 })]);
  assert.deepEqual((await store.getAuthorityBoard(boardId)).tombstones, tombstones);
  assert.equal((await rows('boardTombstones')).length, 1000);
  assert.equal((await rows('boardTombstoneBackups')).length, 1);
});

test('a changed old table during migration is rejected rather than discarded', async () => {
  const { boardId } = await seed(); const controller = new AbortController();
  await assert.rejects(migrate(boardId, { signal: controller.signal, onProgress: () => controller.abort() }), { name: 'AbortError' });
  const [board] = await rows('boards'); board.tombstones.unexpected = { actionId: 'new' }; await edit('boards', board);
  await assert.rejects(migrate(boardId), /migration|changed|измен|перенос/i);
  assert.equal((await store.getAuthorityBoard(boardId)).tombstones.unexpected.actionId, 'new');
  assert.equal(Object.hasOwn((await rows('boards'))[0], 'tombstones'), true);
});

test('held v3 tab prevents upgrade safely; legacy writers cannot reopen with v3 after upgrade', async () => {
  const { boardId } = await seed(); const old = await req(indexedDB.open(name, 3));
  try { await assert.rejects(store.getAuthorityBoard(boardId), /вклад|заблок/i); } finally { old.close(); }
  // The abandoned upgrade can be aborted asynchronously; the next open must recover.
  await migrate(boardId);
  await assert.rejects(req(indexedDB.open(name, 3)), { name: 'VersionError' });
  assert.deepEqual((await store.getAuthorityBoard(boardId)).snapshot, snapshot);
});

test('board deletion during a paused migration cannot recreate rows or the board', async () => {
  const { boardId } = await seed(); const controller = new AbortController();
  await assert.rejects(migrate(boardId, { signal: controller.signal, onProgress: () => controller.abort() }), { name: 'AbortError' });
  await store.deleteAuthorityBoard(boardId);
  await assert.rejects(migrate(boardId), /not found|не найден/i);
  assert.equal(await store.getAuthorityBoard(boardId), null);
  for (const table of ['boardTombstones', 'boardTombstoneMigrations', 'boardTombstoneBackups']) assert.deepEqual(await rows(table), []);
});

test('a corrupted saved migration cursor or recovery copy cannot switch the original data', async () => {
  for (const corruption of ['cursor','backup']) {
    const { tombstones, boardId } = await seed(); const controller = new AbortController();
    await assert.rejects(migrate(boardId,{signal:controller.signal,onProgress:()=>controller.abort()}),{name:'AbortError'});
    const table = corruption === 'cursor' ? 'boardTombstoneMigrations' : 'boardTombstoneBackups';
    const [record] = await rows(table);
    if (corruption === 'cursor') record.cursor = 10000; else record.tombstones['old-1'].mutationId = 'wrong';
    await edit(table,record);
    await assert.rejects(migrate(boardId),/migration/i);
    assert.deepEqual((await store.getAuthorityBoard(boardId)).tombstones,tombstones);
  }
});

test('future deletion storage cannot be silently interpreted or downgraded', async () => {
  const { boardId } = await seed(); const [board] = await rows('boards');
  board.tombstoneStorageVersion = 2; await edit('boards',board);
  await assert.rejects(migrate(boardId),error=>error.code==='tombstone_update_required');
  await assert.rejects(store.getAuthorityBoard(boardId),error=>error.code==='tombstone_update_required');
  await assert.rejects(store.persistAuthorityCommit(boardId,{actionId:'bad',revision:13,ops:[]}),error=>error.code==='tombstone_update_required');
  assert.equal((await rows('boards'))[0].tombstoneStorageVersion,2);
});

test('future-format snapshot writes and imports cannot erase or downgrade unknown deletion data', async () => {
  const { boardId } = await seed(); const [board] = await rows('boards');
  board.tombstoneStorageVersion = 2; await edit('boards',board);
  await assert.rejects(store.saveAuthoritySnapshot(boardId,{version:2,canvas:{objects:[]}},12),error=>error.code==='tombstone_update_required');
  assert.deepEqual((await rows('snapshots'))[0].snapshot,snapshot);
  await assert.rejects(store.createAuthorityBoard({boardId:'future-import',tombstoneStorageVersion:2}),error=>error.code==='tombstone_update_required');
  assert.equal((await rows('boards')).length,1);
});
