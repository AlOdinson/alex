import test from 'node:test';
import assert from 'node:assert/strict';
import {getEnv} from 'fabric/node';
import {setEnv,StaticCanvas,Path,Rect,Shadow} from 'fabric';
import * as notebookApi from '../src/lib/boardNotebook.js';
import {createNotebookBoardActions} from '../src/lib/notebookBoardActions.js';
setEnv(getEnv());
const ink=()=>new Path('M 140 170 Q 160 190 190 175',{boardObjectId:'released-source',stroke:'black',strokeWidth:3,fill:null});
function setup(options={}) {
 const canvas=new StaticCanvas(null,{width:800,height:700,renderOnAddRemove:false});
 const book=new notebookApi.BoardNotebook({boardObjectId:'book',left:70,top:80,...options});
 const source=ink();canvas.add(book,source);
 const sent=[],history=[];
 const controller={enqueue(action){sent.push(action);return{actionId:action.actionId,inverseOps:[],settled:new Promise(()=>{})};},pendingObjectIds:()=>new Set(['book'])};
 const actions=createNotebookBoardActions({getCanvas:()=>canvas,getController:async()=>controller,clientId:'owner',
  acquireLease:async()=>true,ownsLease:()=>true,releaseLease(){},recordAction:action=>history.push(action),
  getRecords(){throw Error('contained fresh stroke used general record/z-index scan');}});
 return{canvas,book,source,controller,actions,sent,history,close:()=>canvas.dispose()};
}
test('fresh contained stroke reuses the released Path, serializes it once, and keeps deletion identity',async()=>{
 const e=setup();let serialized=0;
 const oldId=e.source.boardObjectId,world=e.source.calcTransformMatrix().slice(),toObject=e.source.toObject;
 e.source.toObject=function(...args){serialized++;return toObject.apply(this,args);};
 e.source.clone=()=>{throw Error('fresh contained ink was cloned');};
 try {
  assert.equal(await e.actions.capture(e.book,e.source),true);
  assert.strictEqual(e.book.getPageObjects()[0],e.source);
  assert.equal(serialized,1,'new path was serialized repeatedly');
  assert.notEqual(e.source.boardObjectId,oldId);
  assert.ok(e.source.calcTransformMatrix().every((v,i)=>Math.abs(v-world[i])<1e-8));
  assert.equal(e.sent[0].ops[1].id,oldId);assert.equal(e.sent[0].ops[1].type,'delete');
  assert.equal(e.sent[0].ops[0].changes[0].object.boardObjectId,e.source.boardObjectId);
  assert.equal(Object.isFrozen(e.source.path),false,'record freezing froze live path points');
  assert.equal(e.history.length,1);
 }finally{await e.close();}
});
test('queue rejection leaves the original stroke identity and geometry intact',async()=>{
 const e=setup(),before=e.source.toObject(['boardObjectId']);
 e.controller.enqueue=()=>{throw Error('notebook queue full');};
 try {
  await assert.rejects(e.actions.capture(e.book,e.source),/queue full/);
  assert.ok(e.canvas.getObjects().includes(e.source));assert.equal(e.book.getPageObjects().length,0);
  assert.deepEqual(e.source.toObject(['boardObjectId']),before);assert.equal(e.history.length,0);
 }finally{await e.close();}
});
test('a moved source during the lease wait is not consumed or disposed',async()=>{
 const e=setup();let resolve;const wait=new Promise(r=>resolve=r);
 const actions=createNotebookBoardActions({getCanvas:()=>e.canvas,getController:async()=>{await wait;return e.controller;},
  acquireLease:async()=>true,ownsLease:()=>true,releaseLease(){},getRecords:()=>[],recordAction(){}});
 try {
  const task=actions.capture(e.book,e.source);await Promise.resolve();e.source.set({left:240});e.source.setCoords();resolve();
  await assert.rejects(task,/Страница/);assert.ok(e.canvas.getObjects().includes(e.source));assert.equal(e.source.boardObjectId,'released-source');
  assert.equal(e.book.getPageObjects().length,0);
 }finally{await e.close();}
});
test('contained preparation excludes published, clipped, partial-eraser, shadowed and non-Path objects',()=>{
 const prepare=notebookApi.prepareContainedNotebookStroke;
 assert.equal(typeof prepare,'function');
 const e=setup();
 try {
  assert.equal(prepare(e.book,e.source,{published:true}),null);
  assert.equal(prepare(e.book,e.source,{pageNumber:2}),null);
  e.source.clipPath=new Rect({width:10,height:10});assert.equal(prepare(e.book,e.source),null);e.source.clipPath=null;
  e.source.shadow=new Shadow('1px 1px 2px black');assert.equal(prepare(e.book,e.source),null);e.source.shadow=null;
  e.source.globalCompositeOperation='destination-out';assert.equal(prepare(e.book,e.source),null);e.source.globalCompositeOperation='source-over';
  assert.equal(prepare(e.book,new Rect({left:100,top:100,width:20,height:20})),null);
  e.source.set({left:0});e.source.setCoords();assert.equal(prepare(e.book,e.source),null);
 }finally{e.close();}
});
for (const scale of [.5,1.4,2])test(`contained capture preserves world placement at notebook scale ${scale}`,async()=>{
 const e=setup({scaleX:scale,scaleY:scale});const before=e.source.calcTransformMatrix().slice();
 try{assert.equal(await e.actions.capture(e.book,e.source),true);assert.ok(e.source.calcTransformMatrix().every((v,i)=>Math.abs(v-before[i])<1e-7));}
 finally{await e.close();}
});
