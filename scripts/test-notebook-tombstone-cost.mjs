import test from 'node:test';
import assert from 'node:assert/strict';
import { createNotebookSession } from '../src/lib/notebookSession.js';
import { openBrowserBoardAuthority } from '../src/lib/browserBoardAuthority.js';
import { evaluateAuthorityAction } from '../src/lib/authorityOperationEvaluator.js';
import { createBoardTombstoneIndex } from '../src/lib/boardTombstoneIndex.js';
const tombstones=()=>Object.fromEntries(Array.from({length:10000},(_,i)=>[`retired-${i}`,{clientId:'writer',actionId:`a${i}`,mutationId:`m${i}`,revision:i}]));
const snapshot=()=>({version:2,background:'blank',canvas:{objects:[{type:'BoardNotebook',boardObjectId:'book',notebookPageNumber:1,notebookPages:[[]]}]}});
const operations=id=>[{type:'notebook',version:1,id:'book',pageNumber:1,changes:[{type:'insert',object:{type:'Path',boardObjectId:id,path:[['M',0,0],['L',2,3]]},ifAbsent:true}],atomicGroup:id},
 {type:'delete',id:`source-${id}`,mutationId:id,atomicGroup:id}];
function observeCopies(){
 const original=globalThis.structuredClone, unwrapped=new WeakMap();let count=0,armed=false;
 const wrap=value=>{
  if(!value||typeof value!=='object')return value;
  if(Object.hasOwn(value,'retired-9999')){const proxy=new Proxy(value,{ownKeys(target){if(armed)count++;return Reflect.ownKeys(target);}});unwrapped.set(proxy,value);return proxy;}
  if(Object.hasOwn(value,'tombstones'))value.tombstones=wrap(value.tombstones);
  return value;
 };
 globalThis.structuredClone=(value,...args)=>{const raw=unwrapped.get(value)??value;if(armed&&raw&&Object.hasOwn(raw,'retired-9999'))count++;return wrap(original(raw,...args));};
 return {start(){armed=true;count=0;},count:()=>count,dispose(){globalThis.structuredClone=original;}};
}

test('conditional restoration reads the addressed deletion from an indexed table',()=>{
 const deleted=createBoardTombstoneIndex(tombstones());
 const result=evaluateAuthorityAction({snapshot:snapshot(),tombstones:deleted,ops:[{type:'upsert',object:{type:'Path',boardObjectId:'retired-9999'},restore:true,ifDeletedBy:'writer',ifDeletedMutationId:'m9999'}]});
 assert.equal(result.appliedOps.length,1);assert.deepEqual(result.skippedConflicts,[]);
 const conflict=evaluateAuthorityAction({snapshot:snapshot(),tombstones:deleted,ops:[{type:'upsert',object:{type:'Path',boardObjectId:'retired-9999'},restore:true,ifDeletedBy:'other',ifDeletedMutationId:'m9999'}]});
 assert.equal(conflict.appliedOps.length,0);assert.equal(conflict.skippedConflicts.length,1);
});

test('local notebook capture does not enumerate the ten-thousand-entry deletion table',()=>{
 const watch=observeCopies();let s;
 try{
  s=createNotebookSession({confirmedState:{revision:0,snapshot:snapshot(),tombstones:tombstones()},publish:()=>new Promise(()=>{})});s.pause();watch.start();
  s.enqueue({actionId:'ink',ops:operations('ink')});
  assert.equal(watch.count(),0,'local preview copied the accumulated table');
  assert.equal(s.getState().snapshot.canvas.objects[0].notebookPages[0].length,1);
 }finally{s?.dispose();watch.dispose();}
});

test('serial authority keeps unrelated deletion records shared while applying a real notebook action',async()=>{
 const watch=observeCopies();let authority;
 try{
  authority=await openBrowserBoardAuthority({boardId:'cost',enableNotebookOperations:true,loadBoard:async()=>({boardId:'cost',revision:0,snapshotRevision:0,snapshot:snapshot(),tombstones:tombstones()}),
    loadCommitsAfter:async()=>[],loadActionOutcome:async()=>null,persistCommit:async(_,commit)=>({commit})});
  watch.start();const result=await authority.commitAction({actionId:'ink',clientId:'writer',baseRevision:0,ops:operations('ink')});
  assert.equal(result.changed,true);assert.equal(watch.count(),0,'authority copied the accumulated table');
 }finally{authority?.closeVerification();watch.dispose();}
});
