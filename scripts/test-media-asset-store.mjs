import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
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
  await assert.rejects(store.importFile('a',{size:26*1024*1024,name:'big.pdf'}),/25|размер|size/i);
  await assert.rejects(store.importFile('a',file('GIF89a'+ 'a'.repeat(10*1024*1024))),/10|размер|size/i);
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
