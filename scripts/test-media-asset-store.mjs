import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { IDBFactory } from 'fake-indexeddb';
import { createMediaAssetStore } from '../src/lib/mediaAssetStore.js';
import { createMediaMemoryBudget } from '../src/lib/mediaMemoryBudget.js';
const file = (data, name='test.pdf') => Object.assign(new Blob([data]), { name });
test('content identity, room membership and explicit persistence failure', async () => {
  const errors=[];
  const store=createMediaAssetStore({ indexedDB:null, crypto:webcrypto, onPersistenceError:e=>errors.push(e) });
  const a=await store.importFile('one',file('%PDF-1.7\nhello'));
  const b=await store.importFile('one',file('%PDF-1.7\nhello','other.pdf'));
  assert.equal(a.assetId,b.assetId); assert.equal(a.kind,'pdf'); assert.equal(a.persisted,false);
  assert.ok(errors.length); assert.equal(await store.get('two',a.assetId),null);
  await assert.rejects(store.register('two',a.assetId),/сохран/); assert.equal(await store.get('two',a.assetId),null);
  store.dispose();
});
test('sniffs supported bytes and rejects oversized files before reading', async () => {
  const store=createMediaAssetStore({indexedDB:null,crypto:webcrypto});
  assert.equal((await store.importFile('a',file('GIF89a1234','fake.pdf'))).kind,'gif');
  await assert.rejects(store.importFile('a',file('not a pdf')), /формат|format/i);
  await assert.rejects(store.importFile('a',{size:101*1024*1024,name:'big.pdf'}),/100|размер|size/i);
  await assert.rejects(store.importFile('a',file('GIF89a'+ 'a'.repeat(25*1024*1024))),/25|размер|size/i);
});

const database = idb => new Promise((resolve, reject) => {
  const request = idb.open('alex-board-media');
  request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
});
async function assetCount(idb) {
  const db = await database(idb);
  return new Promise(resolve => { const request = db.transaction('assets').objectStore('assets').count();
    request.onsuccess = () => { db.close(); resolve(request.result); }; });
}
test('one original survives deleting either board and disappears after the last board, across store instances', async () => {
  const indexedDB = new IDBFactory();
  const a = createMediaAssetStore({indexedDB, crypto:webcrypto});
  const b = createMediaAssetStore({indexedDB, crypto:webcrypto});
  const first = await a.importFile('one', file('%PDF-1.7\nshared', 'first.pdf'));
  const second = await b.importFile('two', file('%PDF-1.7\nshared', 'renamed.pdf'));
  assert.equal(first.assetId, second.assetId); assert.equal(await assetCount(indexedDB), 1);
  await a.deleteBoard('one');
  assert.equal(await b.get('one', first.assetId), null);
  assert.ok(await b.get('two', first.assetId)); assert.equal(await assetCount(indexedDB), 1);
  await b.deleteBoard('two');
  assert.equal(await a.get('two', first.assetId), null); assert.equal(await assetCount(indexedDB), 0);
  await a.deleteBoard('two');
  await assert.rejects(a.importFile('two', file('%PDF-1.7\nshared')), /удален/);
});
test('copy registration and deletion serialize without orphaning or losing another board original', async () => {
  const indexedDB = new IDBFactory(); const a=createMediaAssetStore({indexedDB,crypto:webcrypto});
  const b=createMediaAssetStore({indexedDB,crypto:webcrypto});
  const meta=await a.importFile('source',file('%PDF-1.7\ncopy'));
  await a.register('copy',meta.assetId);
  await Promise.all([a.deleteBoard('source'),b.register('third',meta.assetId)]);
  await a.deleteBoard('copy'); assert.ok(await b.get('third',meta.assetId));
  await b.deleteBoard('third'); assert.equal(await assetCount(indexedDB),0);
});
test('new limits accept a 100 MiB PDF and a 25 MiB GIF', async () => {
  const store=createMediaAssetStore({indexedDB:new IDBFactory(),crypto:webcrypto});
  for(const [header,size] of [['%PDF-',100*1024*1024],['GIF89a',25*1024*1024]]) {
    const metadata=await store.importFile('limits',file(new Blob([header,new Uint8Array(size-header.length)])));
    assert.equal(metadata.size,size); assert.equal(metadata.persisted,true);
  }
});
test('version one memberships migrate without losing shared originals', async () => {
  const indexedDB=new IDBFactory(),assetId='a'.repeat(64);
  await new Promise((resolve,reject)=>{const r=indexedDB.open('alex-board-media',1);
    r.onupgradeneeded=()=>{r.result.createObjectStore('assets').put({metadata:{assetId,kind:'pdf'},blob:new Blob(['%PDF-'])},assetId);
      const rooms=r.result.createObjectStore('rooms'); rooms.put(true,`old:${assetId}`); rooms.put(true,`copy:${assetId}`);};
    r.onsuccess=()=>{r.result.close();resolve();};r.onerror=()=>reject(r.error);});
  const store=createMediaAssetStore({indexedDB,crypto:webcrypto});
  assert.ok(await store.get('old',assetId));await store.deleteBoard('old');
  assert.ok(await store.get('copy',assetId)); await store.deleteBoard('copy');assert.equal(await assetCount(indexedDB),0);
});
test('memory LRU releases before reservation and never exceeds budget', () => {
  const calls=[]; const budget=createMediaMemoryBudget(64);
  budget.reserve('a',40,()=>calls.push('a')); budget.reserve('b',30,()=>calls.push('b'));
  assert.deepEqual(calls,['a']); assert.equal(budget.usedBytes(),30);
  assert.throws(()=>budget.reserve('huge',65,()=>{}),/memory|памят/i);
  budget.dispose(); assert.deepEqual(calls,['a','b']); assert.equal(budget.usedBytes(),0);
});
test('failed durable cross-room registration rejects without granting target access',async()=>{
 const store=createMediaAssetStore({indexedDB:null,crypto:webcrypto});
 const asset=await store.importFile('source',file('%PDF-1.7\nhello'));
 await assert.rejects(store.register('target',asset.assetId),/сохран|недоступ/i);
 assert.equal(await store.get('target',asset.assetId),null);
 assert.ok(await store.get('source',asset.assetId));store.dispose();
});
