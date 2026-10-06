import test from 'node:test';
import assert from 'node:assert/strict';
import { getEnv } from 'fabric/node';
import { setEnv, StaticCanvas, Rect } from 'fabric';
import { callback, boardFunction, boardInterval } from './notebook-ui-node-harness.mjs';
setEnv(getEnv());
const ref=current=>({current});
function fixture() {
 const canvas=new StaticCanvas(null,{width:100,height:100,renderOnAddRemove:false}), events=[];
 const scope={canvas,Date:{now:()=>500000},clientIdRef:ref('local'),fabricCanvasRef:ref(canvas),
   transientCanvasObjectsRef:ref(new Set()),objectRegistryRef:ref(new Map()),selectionTransactionRegistryRef:ref(new Map()),creationSessionRegistryRef:ref(new Map()),
   remoteLocksRef:ref(new Map()),remoteTransformSessionsRef:ref(new Map()),remoteSelectionTransactionsRef:ref(new Map()),remoteDeletedObjectIdsRef:ref(new Map()),
   authoritativeSelectionTransactionsRef:ref(new Map()),authoritativeObjectStatesRef:ref(new Map()),remotePreviewChunksRef:ref(new Map()),remoteDrawSessionsRef:ref(new Map()),
   realtimeRef:ref({resumeVerification(){}}),setRemoteLocks(){},applyObjectInteractivityToObjects(){},registeredObjectsById:()=>[],
   setRemoteCursors(fn){scope.cursors=fn(scope.cursors);},cursors:[],removeRegisteredSelectionTransactionObjects:()=>[],
   scheduleTargetedReconciliation:ids=>events.push(ids),syncFromServer(){},removeTransientDrawPreviewsBySession:()=>[],normalizeRealtimeBaseRevision:x=>x,
   applySharpRenderingPolicy(){} };
 scope.creationSessionRegistryKey=boardFunction('creationSessionRegistryKey',scope);
 const register=callback('registerCanvasObject',scope),unregister=callback('unregisterCanvasObject',scope);
 scope.registerCanvasObject=register;
 canvas.on('object:added',({target})=>register(target));canvas.on('object:removed',({target})=>unregister(target));
 const cleanup=boardInterval('lockCleanupInterval',scope);
 return {canvas,scope,cleanup,events,register,rebuild:callback('rebuildObjectRegistry',scope)};
}
const object=(id,flags={})=>new Rect({width:2,height:2,boardObjectId:id,...flags});

test('periodic transient cleanup never enumerates 5000 durable objects', async()=>{
 const {canvas,cleanup,events}=fixture();
 for(let i=0;i<5000;i++)canvas.add(object(`stable-${i}`));
 const stale=object('stale',{transientPreview:true,previewReceivedAt:100000});
 const awaiting=object('awaiting',{transientPreview:true,transientAwaitingCommit:true,previewReceivedAt:100000});
 const proxy=object('proxy',{transientSelectionProxy:true,creationClientId:'remote',previewReceivedAt:100000});
 const own=object('own-proxy',{transientSelectionProxy:true,creationClientId:'local',previewReceivedAt:100000});
 const upload=object('upload',{transientPreview:true});
 canvas.add(stale,awaiting,proxy,own,upload);
 let reads=0;const all=canvas.getObjects.bind(canvas);canvas.getObjects=(...args)=>{reads++;return all(...args);};
 try {cleanup();assert.equal(reads,0,'timer must query tracked transients, not complete scene');
   assert.equal(stale.canvas,undefined);assert.equal(proxy.canvas,undefined);
   assert.equal(awaiting.canvas,canvas);assert.equal(own.canvas,canvas);assert.equal(upload.canvas,canvas);
   assert.ok(events.some(ids=>ids.includes('awaiting')));
 } finally {await canvas.dispose();}
});

test('unchanged cursors preserve React state identity on maintenance tick', async()=>{
 const {canvas,scope,cleanup}=fixture();const cursors=[{clientId:'remote',receivedAt:495000}];scope.cursors=cursors;
 try {cleanup();assert.equal(scope.cursors,cursors);
  scope.cursors=[...cursors,{clientId:'gone',receivedAt:400000}];cleanup();assert.deepEqual(scope.cursors,cursors);
 } finally {await canvas.dispose();}
});

test('registry updates retain only live transient membership across finalization, remove and rebuild',async()=>{
 const {canvas,scope,cleanup,register,rebuild}=fixture();const a=object('same',{transientPreview:true,previewReceivedAt:499000}),b=object('same',{transientPreview:true,previewReceivedAt:499000});
 try {canvas.add(a,b);assert.equal(scope.transientCanvasObjectsRef.current.size,2);
  a.transientPreview=false;register(a);assert.equal(scope.transientCanvasObjectsRef.current.has(a),false);
  canvas.remove(b);assert.equal(scope.transientCanvasObjectsRef.current.size,0);
  a.transientSelectionProxy=true;register(a);assert.equal(scope.transientCanvasObjectsRef.current.size,1);
  a.transientSelectionProxy=false;cleanup();assert.equal(scope.transientCanvasObjectsRef.current.size,0);
  a.transientPreview=true;rebuild();assert.equal(scope.transientCanvasObjectsRef.current.size,1);
 } finally {await canvas.dispose();}
});
