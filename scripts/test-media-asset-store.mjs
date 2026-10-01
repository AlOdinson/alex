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
test('ten boards reuse each durable PDF/GIF once and last membership cleans up', async () => {
  const indexedDB=new IDBFactory();
  const source=createMediaAssetStore({indexedDB,crypto:webcrypto});
  for (const bytes of ['%PDF-1.7\nshared lesson','GIF89ashared lesson']) {
    const meta=await source.importFile('lesson-0',file(bytes));
    for(let i=1;i<10;i++) {
      const store=createMediaAssetStore({indexedDB,crypto:webcrypto});
      assert.equal(await store.get(`lesson-${i}`,meta.assetId),null);
      const record=await store.reuse(`lesson-${i}`,meta.assetId);
      assert.equal(record.persisted,true); assert.equal(await record.blob.text(),bytes);
    }
    assert.equal(await assetCount(indexedDB),1);
    for(let i=0;i<9;i++) await source.releaseBoard(`lesson-${i}`);
    assert.ok(await source.get('lesson-9',meta.assetId));
    await source.releaseBoard('lesson-9'); assert.equal(await assetCount(indexedDB),0);
  }
});
test('reuse refuses tombstones and unavailable memory-only originals',async()=>{
  const indexedDB=new IDBFactory(),store=createMediaAssetStore({indexedDB,crypto:webcrypto});
  const meta=await store.importFile('source',file('%PDF-1.7\nreuse'));
  await store.deleteBoard('deleted');
  await assert.rejects(store.reuse('deleted',meta.assetId),{name:'DeletedBoardError'});
  assert.equal(await store.get('deleted',meta.assetId),null);
  assert.equal(await store.reuse('missing','a'.repeat(64)),null);
  const errors=[],offline=createMediaAssetStore({indexedDB:null,crypto:webcrypto,onPersistenceError:e=>errors.push(e)});
  const local=await offline.importFile('source',file('GIF89alocal'));
  assert.equal(await offline.reuse('target',local.assetId),null);
  assert.equal(await offline.get('target',local.assetId),null);assert.ok(errors.length>=2);
});
test('release allows a revisited lesson but cannot clear a permanent tombstone',async()=>{
  const indexedDB=new IDBFactory(),store=createMediaAssetStore({indexedDB,crypto:webcrypto});
  const bytes=file('%PDF-1.7\nrevisit');const meta=await store.importFile('lesson',bytes);
  await store.releaseBoard('lesson');assert.equal(await store.get('lesson',meta.assetId),null);
  assert.equal(await assetCount(indexedDB),0);
  await store.importFile('lesson',bytes);assert.ok(await store.get('lesson',meta.assetId));
  await store.deleteBoard('lesson');await store.releaseBoard('lesson');
  await assert.rejects(store.importFile('lesson',bytes),{name:'DeletedBoardError'});
});
test('release and reuse serialize and never remove another lesson original',async()=>{
  const indexedDB=new IDBFactory();
  const first=createMediaAssetStore({indexedDB,crypto:webcrypto}),second=createMediaAssetStore({indexedDB,crypto:webcrypto});
  const meta=await first.importFile('source',file('GIF89aconcurrent'));
  await first.reuse('anchor',meta.assetId);
  await Promise.all([first.releaseBoard('source'),second.reuse('new',meta.assetId)]);
  await first.releaseBoard('anchor');assert.ok(await second.get('new',meta.assetId));
  await second.releaseBoard('new');assert.equal(await assetCount(indexedDB),0);
});
test('failed release reports failure and retains the memory-only membership',async()=>{
  const store=createMediaAssetStore({indexedDB:null,crypto:webcrypto});
  const meta=await store.importFile('source',file('GIF89afallback'));
  await assert.rejects(store.releaseBoard('source'),/недоступ/);
  assert.ok(await store.get('source',meta.assetId));
});
test('durable board inventory follows membership cleanup and preserves unique board IDs',async()=>{
  const store=createMediaAssetStore({indexedDB:new IDBFactory(),crypto:webcrypto});
  const a=await store.importFile('one',file('GIF89afirst'));
  await store.importFile('one',file('%PDF-1.7\nsecond'));
  await store.reuse('two',a.assetId);
  assert.deepEqual((await store.listBoardIds()).sort(),['one','two']);
  await store.releaseBoard('one');assert.deepEqual(await store.listBoardIds(),['two']);
  await store.deleteBoard('two');assert.deepEqual(await store.listBoardIds(),[]);
  const unavailable=createMediaAssetStore({indexedDB:null,crypto:webcrypto});
  await assert.rejects(unavailable.listBoardIds(),/недоступ/);
});
test('media import waits for an active cross-database cleanup lifecycle lock',async()=>{
  const { withLocalFileLifecycle }=await import('../src/lib/localFileLifecycle.js');
  const store=createMediaAssetStore({indexedDB:new IDBFactory(),crypto:webcrypto});
  let unlock,entered;
  const started=new Promise(resolve=>{entered=resolve;});
  const cleanup=withLocalFileLifecycle(async()=>{entered();await new Promise(resolve=>{unlock=resolve;});});
  await started;
  let completed=false;
  const importing=store.importFile('new',file('GIF89aafter cleanup')).then(value=>{completed=true;return value;});
  await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(completed,false);assert.deepEqual(await store.listBoardIds(),[]);
  unlock();await cleanup;await importing;
  assert.deepEqual(await store.listBoardIds(),['new']);
});
