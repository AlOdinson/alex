import test from 'node:test';
import assert from 'node:assert/strict';
import { indexedDB, IDBKeyRange, IDBObjectStore } from 'fake-indexeddb';
Object.assign(globalThis, { indexedDB, IDBKeyRange });
const store = await import('../src/lib/browserAuthorityStore.js');
const { openBrowserBoardAuthority } = await import('../src/lib/browserBoardAuthority.js');
const { notebookChildKey } = await import('../src/lib/notebookOperations.js');
const { applyReplicaCommit, installReplicaSnapshot, getReplicaState } = await import('../src/lib/browserReplicaStore.js');
const { createStudentOfflineRecorder, readStudentOfflineSnapshot } = await import('../src/lib/studentOfflineCache.js');
const req = request => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
});
const done = tx => new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = tx.onerror = () => reject(tx.error); });
const child = id => ({ type: 'Path', boardObjectId: id, path: [['M', 1, 2], ['L', 3, 4]], stroke: '#000' });
const notebook = () => ({ type: 'BoardNotebook', boardObjectId: 'book', notebookPages: Array.from({length:20},()=>[]), notebookPageNumber: 20 });
const baseline = () => ({ version: 2, background: 'grid', canvas: { objects: [notebook()] } });
const op = (changes, pageNumber = 20) => ({ type: 'notebook', version: 1, id: 'book', pageNumber, changes });
const insert = id => op([{ type: 'insert', object: child(id), ifAbsent: true }]);
const commit = (revision, operation, actionId = `a${revision}`) => ({ actionId, clientId: 'teacher', revision, baseRevision: revision - 1, committedAt: 123 + revision, ops: [operation] });

// Seed the actual old schema before the production API first opens it.
test('legacy schema migrates snapshot atomically, without losing existing board or journal', async () => {
  const db = await req(indexedDB.open('alex-board-authority', 1));
  // DB already exists only if another test accidentally opened production first.
  db.close();
  await req(indexedDB.deleteDatabase('alex-board-authority'));
  const opening = indexedDB.open('alex-board-authority', 1);
  opening.onupgradeneeded = () => {
    const db = opening.result;
    db.createObjectStore('boards', {keyPath:'boardId'});
    const commits = db.createObjectStore('commits', {keyPath:'actionKey'});
    commits.createIndex('boardRevision',['boardId','revision'],{unique:true}); commits.createIndex('boardId','boardId');
    const assets=db.createObjectStore('assets',{keyPath:'assetKey'}); assets.createIndex('boardId','boardId');
  };
  const old = await req(opening), tx = old.transaction(['boards','commits'],'readwrite'), completion = done(tx);
  const snapshot = baseline();
  tx.objectStore('boards').add({boardId:'legacy',snapshot,revision:0,snapshotRevision:0,tombstones:{},ownerKey:'owner',title:'Saved lesson'});
  await completion; old.close();
  const loaded=await store.getAuthorityBoard('legacy');
  assert.deepEqual(loaded.snapshot,snapshot);
  assert.equal(loaded.title,'Saved lesson');
  const current=await req(indexedDB.open('alex-board-authority'));
  assert.equal(current.version,3, 'new schema separates immutable baseline and durable pending intents');
  assert.ok(current.objectStoreNames.contains('snapshots'));
  const read=current.transaction(['boards','snapshots'],'readonly');
  const metadata=await req(read.objectStore('boards').get('legacy'));
  assert.equal(Object.hasOwn(metadata,'snapshot'),false);
  assert.deepEqual((await req(read.objectStore('snapshots').get('legacy'))).snapshot,snapshot);
  current.close();
  await assert.rejects(req(indexedDB.open('alex-board-authority',1)), {name:'VersionError'});
});

test('ordinary child commit reads/writes neither immutable baseline nor hidden page content', async () => {
  const snapshot=baseline();
  snapshot.canvas.objects[0].notebookPages[0]=Array.from({length:300},(_,i)=>child(`hidden-${i}`));
  await store.createAuthorityBoard({boardId:'write-cost',snapshot});
  const calls=[]; const get=IDBObjectStore.prototype.get, put=IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.get=function(key){calls.push(['get',this.name]);return get.call(this,key);};
  IDBObjectStore.prototype.put=function(value,...args){calls.push(['put',this.name,Object.hasOwn(value??{},'snapshot')]);return put.call(this,value,...args);};
  try { await store.persistAuthorityCommit('write-cost',commit(1,insert('one'))); }
  finally { IDBObjectStore.prototype.get=get; IDBObjectStore.prototype.put=put; }
  assert.equal(calls.some(([kind,name,hasSnapshot])=>name==='snapshots' || kind==='put'&&hasSnapshot),false,JSON.stringify(calls));
  const loaded=await store.getAuthorityBoard('write-cost');
  assert.deepEqual(loaded.snapshot,snapshot);
  assert.equal(loaded.notebookVersion,1);
  assert.equal((await store.getAuthorityCommitsAfter('write-cost',0)).length,1);
  assert.equal(typeof store.getAuthorityBoardMetadata,'function');
  assert.equal(Object.hasOwn(await store.getAuthorityBoardMetadata('write-cost'),'snapshot'),false);
});

test('child tombstones survive close/reopen and guard undo using deleting action identity', async () => {
  await store.createAuthorityBoard({boardId:'restore',snapshot:baseline()});
  let authority=await openBrowserBoardAuthority({boardId:'restore',enableNotebookOperations:true});
  const first=await authority.commitAction({actionId:'add',clientId:'teacher',baseRevision:0,ops:[insert('kept')]});
  assert.equal(first.changed,true);
  const deletion=await authority.commitAction({actionId:'remove',clientId:'teacher',baseRevision:1,ops:first.historyInverseOps});
  assert.equal(deletion.changed,true);
  assert.equal(authority.getSnapshot().canvas.objects[0].notebookPages[19].length,0);
  const loaded=await store.getAuthorityBoard('restore');
  assert.equal(loaded.notebookTombstones[notebookChildKey('book',20,'kept')].mutationId,'remove');
  authority=await openBrowserBoardAuthority({boardId:'restore',enableNotebookOperations:true});
  const restored=await authority.commitAction({actionId:'restore',clientId:'teacher',baseRevision:2,ops:deletion.historyInverseOps});
  assert.equal(restored.changed,true);
  assert.equal(authority.getSnapshot().canvas.objects[0].notebookPages[19][0].boardObjectId,'kept');
  assert.deepEqual((await store.getAuthorityBoard('restore')).notebookTombstones,{});
  const duplicate=await authority.commitAction({actionId:'restore',clientId:'teacher',ops:deletion.historyInverseOps});
  assert.equal(duplicate.duplicate,true);
  assert.equal(authority.getRevision(),3);
});

test('failed journal persistence rolls back revision, child tombstones and format marker',async()=>{
  await store.createAuthorityBoard({boardId:'rollback',snapshot:baseline()});
  const put=IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put=function(value,...args){if(this.name==='boards'&&value.boardId==='rollback') throw new Error('test abort');return put.call(this,value,...args);};
  try { await assert.rejects(store.persistAuthorityCommit('rollback',commit(1,op([{type:'delete',id:'x'}]))),/test abort/); }
  finally {IDBObjectStore.prototype.put=put;}
  const loaded=await store.getAuthorityBoard('rollback');
  assert.equal(loaded.revision,0); assert.notEqual(loaded.notebookVersion,1);
  assert.deepEqual(loaded.notebookTombstones,{});
  assert.deepEqual(await store.getAuthorityCommitsAfter('rollback',0),[]);
});

test('enabled child journal replays identically in authority, replica and offline view', async () => {
  await store.createAuthorityBoard({boardId:'replay',snapshot:baseline()});
  const authority=await openBrowserBoardAuthority({boardId:'replay',enableNotebookOperations:true});
  installReplicaSnapshot('replay',baseline(),0);
  const recorder=createStudentOfflineRecorder({boardId:'replay',roomKey:'test-room'});
  recorder.snapshot(baseline(),0);
  for(let i=1;i<=8;i++) {
    const result=await authority.commitAction({actionId:`replay-${i}`,clientId:'teacher',baseRevision:i-1,ops:[insert(`r${i}`)]});
    assert.equal(result.changed,true);
    assert.equal(applyReplicaCommit('replay',result).applied,true);
    assert.equal(applyReplicaCommit('replay',result).duplicate,true);
    recorder.commit(result);
  }
  await recorder.flush(); recorder.close();
  const reopened=await openBrowserBoardAuthority({boardId:'replay',enableNotebookOperations:true});
  const offline=await readStudentOfflineSnapshot('replay','test-room');
  assert.equal(offline.revision,8);
  assert.deepEqual(offline.snapshot.canvas,getReplicaState('replay').snapshot.canvas);
  assert.deepEqual(reopened.getSnapshot().canvas,authority.getSnapshot().canvas);
  assert.deepEqual(offline.snapshot.canvas,authority.getSnapshot().canvas);
});

test('snapshot save and deletion maintain separate baseline and tombstone lifecycle', async()=>{
  await store.createAuthorityBoard({boardId:'delete-separate',snapshot:baseline()});
  await store.persistAuthorityCommit('delete-separate',commit(1,op([{type:'delete',id:'old'}])));
  const newer=baseline(); newer.background='blank';
  await store.saveAuthoritySnapshot('delete-separate',newer,1);
  assert.deepEqual((await store.getAuthorityBoard('delete-separate')).snapshot,newer);
  await store.saveAuthoritySnapshot('delete-separate',baseline(),0);
  assert.deepEqual((await store.getAuthorityBoard('delete-separate')).snapshot,newer);
  await store.deleteAuthorityBoard('delete-separate');
  const db=await req(indexedDB.open('alex-board-authority'));
  assert.ok(db.objectStoreNames.contains('notebookTombstones'));
  const tx=db.transaction(['snapshots','notebookTombstones'],'readonly');
  assert.equal(await req(tx.objectStore('snapshots').get('delete-separate')),undefined);
  assert.deepEqual(await req(tx.objectStore('notebookTombstones').index('boardId').getAll('delete-separate')),[]);
  db.close();
});

test('inline images in child journals deduplicate across lessons and survive until final reference removal', async()=>{
  const {studentOfflineStorage:storage}=await import('../src/lib/studentOfflineCache.js');
  const source='data:image/png;base64,bm90ZWJvb2stam91cm5hbA==';
  for(const scope of ['notebook-image-a','notebook-image-b']) {
    await storage.replace(scope,{boardId:scope,revision:0,snapshot:baseline()});
    await storage.append(scope,{revision:1,ops:[op([{type:'insert',ifAbsent:true,object:{type:'Image',boardObjectId:'image',src:source}}])]});
  }
  const db=await req(indexedDB.open('alex-board-student-view'));
  const images=()=>req(db.transaction('images','readonly').objectStore('images').getAll());
  assert.equal((await images()).filter(value=>value===source).length,1);
  await storage.append('notebook-image-a',{revision:2,ops:[op([{type:'delete',id:'image'}])]});
  assert.equal((await images()).filter(value=>value===source).length,1);
  await storage.remove('notebook-image-a');
  assert.equal((await storage.read('notebook-image-b')).commits[0].ops[0].changes[0].object.src,source);
  await storage.remove('notebook-image-b');
  assert.equal((await images()).filter(value=>value===source).length,0);db.close();
});

test('aborted schema upgrade leaves the original v1 lesson recoverable and retryable',async()=>{
  const {IDBFactory}=await import('fake-indexeddb');
  const originalFactory=globalThis.indexedDB;
  globalThis.indexedDB=new IDBFactory();
  const opening=globalThis.indexedDB.open('alex-board-authority',1);
  opening.onupgradeneeded=()=>{
    const db=opening.result;
    db.createObjectStore('boards',{keyPath:'boardId'});
    const commits=db.createObjectStore('commits',{keyPath:'actionKey'});
    commits.createIndex('boardRevision',['boardId','revision'],{unique:true});commits.createIndex('boardId','boardId');
    db.createObjectStore('assets',{keyPath:'assetKey'}).createIndex('boardId','boardId');
  };
  const old=await req(opening),tx=old.transaction('boards','readwrite'),saved=done(tx);
  tx.objectStore('boards').add({boardId:'upgrade-failure',revision:0,snapshotRevision:0,snapshot:baseline(),tombstones:{}});
  await saved;old.close();
  const put=IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put=function(...args){
    if(this.name==='snapshots')throw new DOMException('Injected migration disk failure','QuotaExceededError');
    return put.apply(this,args);
  };
  try {
    await assert.rejects(store.getAuthorityBoard('upgrade-failure'));
    IDBObjectStore.prototype.put=put;
    const unchanged=await req(globalThis.indexedDB.open('alex-board-authority',1));
    assert.equal(unchanged.version,1);
    const record=await req(unchanged.transaction('boards','readonly').objectStore('boards').get('upgrade-failure'));
    assert.deepEqual(record.snapshot,baseline());unchanged.close();
    assert.deepEqual((await store.getAuthorityBoard('upgrade-failure')).snapshot,baseline());
  } finally {IDBObjectStore.prototype.put=put;globalThis.indexedDB=originalFactory;}
});

test('importing a future notebook format cannot silently downgrade its stored version',async()=>{
  await assert.rejects(store.createAuthorityBoard({boardId:'future-import',snapshot:baseline(),notebookVersion:2}),/version|format|update/i);
  assert.equal(await store.getAuthorityBoard('future-import'),null);
});
