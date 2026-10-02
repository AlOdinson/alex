import test from 'node:test';
import assert from 'node:assert/strict';
import { createNotebookBoardController } from '../src/lib/notebookBoardController.js';
const api=await import('../src/lib/notebookCommitBridge.js').catch(()=>({}));
const create=options=>{assert.equal(typeof api.createNotebookCommitBridge,'function','missing revision-ordered UI commit bridge');return api.createNotebookCommitBridge(options);};
const baseline={revision:0,snapshot:{canvas:{objects:[{type:'BoardNotebook',boardObjectId:'n',notebookPages:[[]],notebookPageNumber:1}]}}};
const op={type:'notebook',version:1,id:'n',pageNumber:1,changes:[{type:'insert',ifAbsent:true,object:{type:'Rect',boardObjectId:'a',width:10}}]};
test('UI revision and folded record wait for both the missing commit and completed projection',async()=>{
 let revision=0,release;const remembered=[];
 const controller=createNotebookBoardController({confirmedState:baseline,clientId:'me',publish:()=>new Promise(()=>{}),paint:()=>new Promise(resolve=>release=()=>resolve(true))});
 const bridge=create({getController:()=>controller,getRevision:()=>revision,setRevision:r=>revision=r,remember:(ops,r)=>remembered.push({ops,r})});
 try {
  bridge.ack({actionId:'ink',clientId:'me',revision:2,ops:[op]},{managed:true});
  await new Promise(r=>setImmediate(r));release();await bridge.settle();assert.equal(revision,0);assert.equal(remembered.length,0);
  bridge.ack({actionId:'outside',clientId:'other',revision:1,ops:[{type:'upsert',object:{type:'Rect',boardObjectId:'outside'}}]},{paint:false});
  await new Promise(r=>setImmediate(r));assert.equal(revision,0);release();await bridge.settle();assert.equal(revision,2);assert.equal(remembered[0].ops[0].object.notebookPages[0][0].boardObjectId,'a');
 }finally{controller.dispose();}
});
test('retired Canvas cannot advance the replacement Board revision after an asynchronous paint',async()=>{
 let revision=0,active,release;const controller=createNotebookBoardController({confirmedState:baseline,publish:()=>new Promise(()=>{}),paint:()=>new Promise(r=>release=()=>r(true))});active=controller;
 const bridge=create({getController:()=>active,getRevision:()=>revision,setRevision:r=>revision=r,remember:()=>{throw Error('retired board');}});
 bridge.ack({actionId:'ink',clientId:'me',revision:1,ops:[op]},{managed:true});const done=bridge.settle();await new Promise(r=>setImmediate(r));active=null;controller.dispose();release();assert.equal(await done,false);assert.equal(revision,0);
});
