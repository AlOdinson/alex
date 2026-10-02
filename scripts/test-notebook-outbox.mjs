import test from 'node:test';
import assert from 'node:assert/strict';
import { indexedDB, IDBKeyRange, IDBObjectStore } from 'fake-indexeddb';
Object.assign(globalThis, { indexedDB, IDBKeyRange });
const api = await import('../src/lib/browserAuthorityStore.js');
const { createNotebookSession } = await import('../src/lib/notebookSession.js');
const { openBrowserBoardAuthority } = await import('../src/lib/browserBoardAuthority.js');
const create = scope => { assert.equal(typeof api.createNotebookOutbox, 'function', 'missing durable notebook outbox'); return api.createNotebookOutbox(scope); };
const action = id => ({ actionId: id, clientId: 'writer', baseRevision: 0, ops: [{ type: 'notebook', version: 1, id: 'book', pageNumber: 1,
  changes: [{ type: 'insert', ifAbsent: true, object: { type: 'Path', boardObjectId: id, path: [['M', 1, 1], ['L', 5, 5]] } }] }] });
const snapshot = () => ({ version: 2, background: 'grid', canvas: { objects: [{ type: 'BoardNotebook', boardObjectId: 'book', notebookPages: [[]], notebookPageNumber: 1 }] } });
const request = r => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });

test('outbox retains durable insertion order across reopen and retries never overwrite an identity', async () => {
  const scope = { boardId: 'queue', clientId: 'writer' }; const box = create(scope);
  await box.save(action('z-first')); await box.save(action('a-second')); await box.save(action('z-first'));
  const fresh = create(scope); assert.deepEqual((await fresh.list()).map(a => a.actionId), ['z-first', 'a-second']);
  const changed = action('z-first'); changed.ops[0].changes[0].object.path[0][1] = 99;
  await assert.rejects(fresh.save(changed), /identity|different/i);
  assert.equal((await fresh.list())[0].ops[0].changes[0].object.path[0][1], 1);
  await fresh.remove('z-first'); assert.deepEqual((await fresh.list()).map(a => a.actionId), ['a-second']);
});

test('outbox namespaces isolate writers and lessons including a student with no local owner board', async () => {
  const one = create({boardId:'shared',clientId:'writer'}), two=create({boardId:'other',clientId:'writer'}), three=create({boardId:'shared',clientId:'another'});
  await one.save(action('same')); await two.save(action('same')); await three.save({...action('same'),clientId:'another'});
  await one.clear(); assert.equal((await one.list()).length,0); assert.equal((await two.list()).length,1); assert.equal((await three.list()).length,1);
  await assert.rejects(three.save(action('wrong-client')), /client|writer/i);
});

test('outbox row limits and malformed/future operations fail without dropping existing intents', async () => {
  const box=create({boardId:'bounds',clientId:'writer',maxPending:2});
  await box.save(action('1'));await box.save(action('2'));await box.save(action('1'));
  await assert.rejects(box.save(action('3')), /full|limit/i); assert.equal((await box.list()).length,2);
  const future=action('future'); future.ops[0].version=2; await assert.rejects(box.save(future), /invalid|version|operation/i);
  assert.equal((await box.list()).length,2);
});

test('durable pending writes do not touch the lesson snapshot or committed history', async()=>{
  await api.createAuthorityBoard({boardId:'outbox-cost',snapshot:snapshot()});
  const box=create({boardId:'outbox-cost',clientId:'writer'}), visits=[];
  const original=IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put=function(value,...rest){visits.push(this.name);return original.call(this,value,...rest);};
  try{await box.save(action('only-pending'));}finally{IDBObjectStore.prototype.put=original;}
  assert.equal(visits.some(name=>['boards','snapshots','commits'].includes(name)),false);
  assert.equal((await api.getAuthorityBoard('outbox-cost')).revision,0);
});

test('real IndexedDB outbox plus authority deduplicates a lost acknowledgement across session reload',async()=>{
  await api.createAuthorityBoard({boardId:'session-reload',snapshot:snapshot()});
  const authority=await openBrowserBoardAuthority({boardId:'session-reload',enableNotebookOperations:true});
  let box=create({boardId:'session-reload',clientId:'writer'});
  const session=createNotebookSession({confirmedState:{snapshot:authority.getSnapshot(),revision:0},clientId:'writer',outbox:box,
    publish:async input=>{await authority.commitAction(input);throw new Error('lost acknowledgement');}});
  const handle=session.enqueue(action('durable'));await handle.durable;await assert.rejects(session.flush(),/lost acknowledgement/);
  session.dispose(); assert.equal(authority.getRevision(),1);
  box=create({boardId:'session-reload',clientId:'writer'});
  const restored=createNotebookSession({confirmedState:{snapshot:authority.getSnapshot(),revision:authority.getRevision(),notebookTombstones:authority.getNotebookTombstones()},
    clientId:'writer',outbox:box,initialPendingActions:await box.list(),publish:input=>authority.commitAction(input)});
  await restored.flush();assert.equal(authority.getRevision(),1);assert.equal((await box.list()).length,0);
  assert.equal(restored.getState().snapshot.canvas.objects[0].notebookPages[0].length,1);restored.dispose();
});

test('explicit whole-board deletion also removes its pending rows without affecting other lessons',async()=>{
  await api.createAuthorityBoard({boardId:'delete-pending',snapshot:snapshot()});
  const removed=create({boardId:'delete-pending',clientId:'writer'}), retained=create({boardId:'keep-pending',clientId:'writer'});
  await removed.save(action('same'));await retained.save(action('same'));
  await api.deleteAuthorityBoard('delete-pending');assert.equal((await removed.list()).length,0);assert.equal((await retained.list()).length,1);
});

test('intermediate v2 databases upgrade to durable outbox without rewriting their saved baseline',async()=>{
  await request(indexedDB.deleteDatabase('alex-board-authority'));
  const opening=indexedDB.open('alex-board-authority',2);
  opening.onupgradeneeded=()=>{
    const db=opening.result;db.createObjectStore('boards',{keyPath:'boardId'});db.createObjectStore('snapshots',{keyPath:'boardId'});
  };
  const db=await request(opening);const tx=db.transaction(['boards','snapshots'],'readwrite');
  const complete=new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});
  tx.objectStore('boards').put({boardId:'intermediate',revision:0,snapshotRevision:0});
  tx.objectStore('snapshots').put({boardId:'intermediate',snapshot:snapshot()});await complete;db.close();
  const box=create({boardId:'intermediate',clientId:'writer'});await box.save(action('after-upgrade'));
  assert.deepEqual((await api.getAuthorityBoard('intermediate')).snapshot,snapshot());assert.equal((await box.list()).length,1);
});
