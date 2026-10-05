import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory, IDBKeyRange, IDBObjectStore, IDBIndex } from 'fake-indexeddb';
import * as store from '../src/lib/browserAuthorityStore.js';
Object.assign(globalThis, { IDBKeyRange });
const snapshot = { version: 2, background: 'blank', canvas: { objects: [] } };
const commit = (revision, ops, actionId = `action-${revision}`) => ({ actionId, clientId: 'writer', revision, ops });
const req = r => new Promise((yes, no) => { r.onsuccess = () => yes(r.result); r.onerror = () => no(r.error); });
async function all(table) {
  const db = await req(indexedDB.open('alex-board-authority'));
  try { return await req(db.transaction(table).objectStore(table).getAll()); } finally { db.close(); }
}
async function board(count = 10000) {
  globalThis.indexedDB = new IDBFactory();
  const tombstones = Object.fromEntries(Array.from({ length: count }, (_, i) => [`old-${i}`, { actionId: `deleted-${i}`, clientId: 'writer', revision: i }]));
  await store.createAuthorityBoard({ boardId: 'cost', snapshot, tombstones }); return tombstones;
}

test('one committed source deletion writes one row, never reads or rewrites the prior ten thousand deletions', async () => {
  await board(); const calls = [], restore = [];
  for (const proto of [IDBObjectStore.prototype, IDBIndex.prototype]) for (const method of ['get', 'getAll', 'put', 'add', 'delete']) {
    const original = proto[method]; if (!original) continue;
    proto[method] = function(value, ...args) {
      calls.push({ method, table: this.objectStore?.name ?? this.name, bytes: JSON.stringify(value)?.length ?? 0,
        full: value && typeof value === 'object' && Object.hasOwn(value, 'tombstones') });
      return original.call(this, value, ...args);
    };
    restore.push(() => { proto[method] = original; });
  }
  try { await store.persistAuthorityCommit('cost', commit(1, [{ type: 'delete', id: 'new-source' }])); }
  finally { restore.reverse().forEach(fn => fn()); }
  assert.equal(calls.filter(c => c.method === 'put' && c.table === 'boardTombstones').length, 1, JSON.stringify(calls));
  assert.equal(calls.some(c => c.full), false, 'rewrote the old table in the metadata row');
  assert.equal(calls.some(c => ['boardTombstoneBackups', 'snapshots'].includes(c.table)), false);
  assert.equal(calls.some(c => c.table === 'boardTombstones' && ['get', 'getAll'].includes(c.method)), false);
  assert.ok(calls.filter(c => ['put', 'add'].includes(c.method)).every(c => c.bytes < 2000), JSON.stringify(calls));
  assert.equal(Object.keys((await store.getAuthorityBoard('cost')).tombstones).length, 10001);
});

test('a journal failure rolls back deletion rows, revision and notebook child deletions together', async () => {
  const original = await board(10), add = IDBObjectStore.prototype.add;
  IDBObjectStore.prototype.add = function(value, ...args) {
    if (this.name === 'commits') throw new DOMException('disk full', 'QuotaExceededError');
    return add.call(this, value, ...args);
  };
  const ops = [{ type: 'delete', id: 'new-source' }, { type: 'notebook', version: 1, id: 'book', pageNumber: 1, changes: [{ type: 'delete', id: 'child' }] }];
  try { await assert.rejects(store.persistAuthorityCommit('cost', commit(1, ops)), { name: 'QuotaExceededError' }); }
  finally { IDBObjectStore.prototype.add = add; }
  const loaded = await store.getAuthorityBoard('cost'); assert.deepEqual(loaded.tombstones, original);
  assert.deepEqual(loaded.notebookTombstones, {}); assert.equal(loaded.revision, 0); assert.deepEqual(await store.getAuthorityCommitsAfter('cost'), []);
});

test('source upsert removes exactly its deletion and duplicate confirmation changes nothing after reopen', async () => {
  const original = await board(20), op = { type: 'upsert', object: { type: 'Path', boardObjectId: 'old-3', path: [] } };
  await store.persistAuthorityCommit('cost', commit(1, [op]));
  delete original['old-3'];
  assert.deepEqual((await store.getAuthorityBoard('cost')).tombstones, original);
  const duplicate = await store.persistAuthorityCommit('cost', commit(1, [op])); assert.equal(duplicate.duplicate, true);
  assert.deepEqual((await store.getAuthorityBoard('cost')).tombstones, original);
  assert.equal((await all('boardTombstones')).length, 19);
});

test('failure while importing parent deletions aborts the new board and its snapshot together', async () => {
  globalThis.indexedDB = new IDBFactory(); const put = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function(value, ...args) {
    if (this.name === 'boardTombstones') throw new DOMException('import full', 'QuotaExceededError');
    return put.call(this, value, ...args);
  };
  try { await assert.rejects(store.createAuthorityBoard({ boardId:'failed', snapshot, tombstones:{ old:{ actionId:'delete' } } }), { name:'QuotaExceededError' }); }
  finally { IDBObjectStore.prototype.put = put; }
  assert.equal(await store.getAuthorityBoard('failed'),null);
  assert.deepEqual(await all('snapshots'),[]); assert.deepEqual(await all('boardTombstones'),[]);
});

test('metadata-only commit never rewrites deletion records', async () => {
  await board(100); const writes = [], put = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function(value, ...args) { writes.push(this.name); return put.call(this,value,...args); };
  try { await store.persistAuthorityCommit('cost', { ...commit(1, []), background:'dots' }); }
  finally { IDBObjectStore.prototype.put = put; }
  assert.deepEqual(writes,['boards']); assert.equal((await all('boardTombstones')).length,100);
});
