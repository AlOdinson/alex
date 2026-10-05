import test from 'node:test';
import assert from 'node:assert/strict';
import { createNotebookSession } from '../src/lib/notebookSession.js';
import { createNotebookBoardController } from '../src/lib/notebookBoardController.js';
import { createNotebookCommitBridge } from '../src/lib/notebookCommitBridge.js';
import { openBrowserBoardAuthority } from '../src/lib/browserBoardAuthority.js';

const base = (count = 5000) => ({revision:0, snapshot:{version:2,background:'blank',canvas:{objects:[
 ...Array.from({length:count},(_,i)=>({type:'Path',boardObjectId:`neighbor-${i}`,left:i,top:i,path:[['M',0,0],['L',2,3]]})),
 {type:'BoardNotebook',boardObjectId:'book',notebookPages:[[],[]],notebookPageNumber:1},
]}}});
const ops = id => [{type:'notebook',version:1,id:'book',pageNumber:1,updatedAt:10,updatedBy:'writer',
 changes:[{type:'insert',object:{type:'Path',boardObjectId:id,path:[['M',0,0],['L',10,10]]},ifAbsent:true}],atomicGroup:id},
 {type:'delete',id:`source-${id}`,mutationId:id,atomicGroup:id}];
const clean = input => input.map(op=>op.type==='notebook'?{...op,changes:op.changes.map(({ifAbsent,...change})=>({...change,zIndex:0}))}:op);
const pending = () => new Promise(()=>{});

// A structural probe, not a timing benchmark. These are the operations that
// currently enumerate full board arrays. It never changes their return values.
async function countFullArrayWork(run, size=5001) {
 const counts={};const original=new Map();
 for(const key of ['map','filter','slice','forEach','some','find','indexOf',Symbol.iterator]){
  const fn=Array.prototype[key];original.set(key,fn);
  Array.prototype[key]=function(...args){if(this.length===size)counts[String(key)]=(counts[String(key)]??0)+1;return fn.apply(this,args);};
 }
 try{await run();}finally{for(const [key,fn] of original)Array.prototype[key]=fn;}
 return counts;
}

test('one notebook insert plus source retirement does not enumerate 5000 unrelated model records',async()=>{
 const s=createNotebookSession({confirmedState:base(),publish:pending});s.pause();
 const counts=await countFullArrayWork(()=>s.enqueue({actionId:'ink',ops:ops('ink')}));
 assert.deepEqual(counts,{},'local preflight/history/advance still enumerate the whole board');
 const all=s.getState().snapshot.canvas.objects;
 assert.equal(all.length,5001);assert.equal(all.at(-1).notebookPages[0].length,1);s.dispose();
});

test('confirmed notebook delta, controller and commit bridge do not rebuild a whole-board index',async()=>{
 const remembered=[];let revision=0;
 const c=createNotebookBoardController({confirmedState:base(),publish:pending,paint:async()=>true});c.pause();
 c.enqueue({actionId:'ink',ops:ops('ink')});await c.whenPainted();
 const bridge=createNotebookCommitBridge({getController:()=>c,getRevision:()=>revision,setRevision:v=>revision=v,
 remember:records=>remembered.push(...records)});
 const counts=await countFullArrayWork(async()=>{
  bridge.ack({actionId:'ink',clientId:'writer',revision:1,ops:clean(ops('ink')),changed:true},{managed:true});
  await bridge.settle();
 });
 assert.deepEqual(counts,{},'confirmation still enumerates every record');
 assert.equal(revision,1);assert.equal(remembered.find(r=>r.type==='upsert').zIndex,5000);
 assert.ok(remembered.some(r=>r.type==='delete'&&r.id==='source-ink'));c.dispose();
});

test('serial browser authority evaluates, prepares history and applies notebook ink without full-board arrays',async()=>{
 const state=base();
 const authority=await openBrowserBoardAuthority({boardId:'test',enableNotebookOperations:true,
  loadBoard:async()=>({...state,snapshotRevision:0}),loadCommitsAfter:async()=>[],loadActionOutcome:async()=>null,
  persistCommit:async(_id,commit)=>({commit}),persistNoopOutcome:async(_id,result)=>({result})});
 let result;
 const counts=await countFullArrayWork(async()=>{result=await authority.commitAction({actionId:'ink',clientId:'writer',baseRevision:0,ops:ops('ink')});});
 assert.deepEqual(counts,{},'serial authority still enumerates every record');
 assert.equal(result.revision,1);assert.equal(result.historyInverseOps[0].changes[0].id,'ink');
 assert.equal(authority.getSnapshot().canvas.objects.at(-1).notebookPages[0].length,1);
 assert.equal(authority.getTombstones()['source-ink'].mutationId,'ink');
});

test('bounded verification reads use addressed records after every notebook commit',async()=>{
 const state=base();
 const authority=await openBrowserBoardAuthority({boardId:'verification-test',enableNotebookOperations:true,
  loadBoard:async()=>({...state,snapshotRevision:0,verificationVersion:1}),loadCommitsAfter:async()=>[],loadActionOutcome:async()=>null,
  persistCommit:async(_id,commit)=>({commit}),persistNoopOutcome:async(_id,result)=>({result})});
 const view=authority.getVerificationView();const stamp=view.capture();
 const counts=await countFullArrayWork(async()=>{
  await authority.commitAction({actionId:'verify-ink',clientId:'writer',baseRevision:0,ops:ops('verify-ink')});
  assert.equal(view.isCurrent(stamp),false);assert.equal(view.count(),5001);
  assert.equal(view.read('book').zIndex,5000);assert.equal(view.read('book').object.notebookPages[0].length,1);
  assert.deepEqual(view.page(4999,2).ids,['neighbor-4999','book']);
  assert.equal(view.readOlder(2,{reset:true}).ids.length,2);
 });
 assert.deepEqual(counts,{},'verifier rebuilt the complete model on a child edit');authority.closeVerification();
});
