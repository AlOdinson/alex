import test from 'node:test';
import assert from 'node:assert/strict';
import { Rect, classRegistry } from 'fabric';
import { authorityFixture,createUiHarness,boardFunction } from './notebook-ui-node-harness.mjs';
import { loadBoardCanvasJson } from '../src/lib/boardLoadPreparation.js';

// A cold-start optimisation must not insert cooperative tasks inside the old
// recovery caller's applyingRemote suppression window. Full recovery needs its
// own input admission/version reconciliation, not a silently widened window.
test('cold loader optimisation does not widen full-scene recovery input suppression',async()=>{
 const book={type:'BoardNotebook',boardObjectId:'book',notebookPageNumber:1,notebookPages:[[]],left:20,top:20};
 const {authority}=await authorityFixture([book]);const h=await createUiHarness({authority});
 let task,observed,started=false,committed=0;
 h.scope.markObject=()=>{committed++;};h.scope.sendRecordUpserts=()=>{};h.scope.recordAction=()=>{};
 h.scope.loadCanvasJsonProgressively=boardFunction('loadCanvasJsonProgressively',{loadBoardCanvasJson,
  serializedImagePayload:()=>null,createPendingImagePlaceholder:()=>{throw Error('unexpected image');},clamp:(x,a,b)=>Math.max(a,Math.min(b,x))});
 class RecoveryBoundaryProbe extends Rect {static type='RecoveryBoundaryProbe';static fromObject(value,options){
  if(!started){started=true;task=new Promise(resolve=>setTimeout(async()=>{
   observed=h.scope.applyingRemoteRef.current;
   const ink=new Rect({left:1200,top:1200,width:5,height:5,boardObjectId:'new-ink'});h.canvas.add(ink);
   await h.scope.commitAddedObject(ink);resolve();
  },0));}
  const until=performance.now()+.8;while(performance.now()<until){}
  return super.fromObject(value,options);
 }}
 classRegistry.setClass(RecoveryBoundaryProbe);
 try{
  const snapshot={version:2,background:'blank',canvas:{objects:[book,...Array.from({length:96},(_,i)=>({type:'RecoveryBoundaryProbe',boardObjectId:`f-${i}`,left:1500,top:i,width:2,height:2}))]}};
  await h.scope.applyAuthoritativeSnapshot(snapshot,1);await task;
  assert.equal(observed,false,'cooperative tasks exposed input while commitAddedObject ignores local work');
  assert.equal(committed,1,'new input did not reach the existing commit path');
  assert.ok(h.canvas._objects.some(o=>o.boardObjectId==='new-ink'));
 }finally{await h.close();authority.close?.();}
});

test('actual initial painter selects the bounded cold loader rather than the live recovery loader',async()=>{
 const {StaticCanvas}=await import('fabric');const canvas=new StaticCanvas(null,{width:100,height:100,renderOnAddRemove:false});
 let loads=0;
 const scope={disposed:false,canvas,BACKGROUNDS:new Set(['blank']),applyingRemoteRef:{current:false},fabricCanvasRef:{current:canvas},serializedObjectCacheRef:{current:new WeakMap()},revisionRef:{current:0},penTransformSpatialApiRef:{current:null},
  applyBackground(){},reconcileBoardScreenShare(){},rebuildObjectRegistry(){},applyObjectInteractivity(){},configureBrushAndMode(){},updateBackgroundTransform(){},retryPendingServerImages(){},
  loadCanvasJsonProgressively(){throw Error('cold opening selected live-recovery loader');},
  async loadInitialCanvasJsonProgressively(c,json){loads++;return loadBoardCanvasJson(c,json);},
 };
 try{await boardFunction('paintInitialSnapshot',scope)({background:'blank',canvas:{objects:[]}},7);assert.equal(loads,1);assert.equal(scope.revisionRef.current,7);assert.equal(scope.applyingRemoteRef.current,false);}
 finally{await canvas.dispose();}
});
