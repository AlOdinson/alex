import test from 'node:test';
import assert from 'node:assert/strict';
import { Path, Textbox, Rect } from 'fabric';
import { BoardNotebook } from '../src/lib/boardNotebook.js';
import { authorityFixture,createUiHarness,serialized } from './notebook-ui-node-harness.mjs';
const initial=()=>new BoardNotebook({boardObjectId:'book',left:20,top:20,width:300,height:300,notebookPages:Array.from({length:20},()=>[])});
const draw=async(ui,id,y=60)=>{const ink=new Path(`M 50 ${y} L 130 ${y+10}`,{stroke:'black',fill:null});ink.boardObjectId=id;ui.canvas.add(ink);return ui.scope.captureIntoNotebook(ink);};

test('actual Board gesture, queue, commit callback and projection retain 300 strokes while first ack is delayed',async()=>{
 const book=initial(),{authority}=await authorityFixture([serialized(book)]);book.dispose();let release,first=true;
 const ui=await createUiHarness({authority,beforeCommit:async()=>{if(first){first=false;await new Promise(r=>release=r);}}});
 try {for(let i=0;i<300;i++)assert.equal(await draw(ui,`stroke-${i}`,40+(i%40)*6),true);
  assert.equal(ui.book().getPageObjects().length,300);assert.equal(ui.scope.notebookControllerRef.current.pendingCount(),300);for(let i=0;i<1000&&!release;i++)await new Promise(r=>setImmediate(r));assert.equal(typeof release,'function');release();await ui.flush();
  assert.equal(ui.book().getPageObjects().length,300);assert.equal(ui.scope.revisionRef.current,authority.getRevision());assert.equal(ui.errors.length,0);
  assert.deepEqual(ui.book().notebookPages,authority.getSnapshot().canvas.objects[0].notebookPages);
 }finally{await ui.close();}
});
test('actual receiving callback applies one compound split and undo without replacing notebook identity',async()=>{
 const book=initial(),{authority}=await authorityFixture([serialized(book)]);book.dispose();let receiver;
 const writer=await createUiHarness({authority,clientId:'teacher',deliver:async(result,id)=>{if(receiver)assert.equal(await receiver.receive(result,id),true);}});
 receiver=await createUiHarness({authority,clientId:'student'});
 try {const original=receiver.book(),ink=new Path('M 0 100 L 100 100',{stroke:'black',strokeWidth:3,fill:null});ink.boardObjectId='split';writer.canvas.add(ink);await writer.scope.captureIntoNotebook(ink);await writer.flush();
  assert.equal(receiver.book(),original);assert.equal(receiver.book().getPageObjects().length,1);assert.equal(receiver.canvas.getObjects().length,2);
  const action=writer.history.at(-1);await writer.scope.commitConditionalHistoryOps(action.nextHistoryOps,'undo-split');await writer.flush();
  assert.equal(receiver.book(),original);assert.equal(receiver.book().getPageObjects().length,0);assert.equal(receiver.canvas.getObjects().length,1);assert.equal(writer.errors.length+receiver.errors.length,0);
 }finally{await writer.close();await receiver.close();}
});
test('actual snapshot recovery overlays pending ink without caching it as confirmed state',async()=>{
 const book=initial(),{authority}=await authorityFixture([serialized(book)]);book.dispose();let release,first=true;
 const ui=await createUiHarness({authority,beforeCommit:async()=>{if(first){first=false;await new Promise(r=>release=r);}}});
 try {await draw(ui,'pending');for(let i=0;i<20&&!release;i++)await new Promise(r=>setImmediate(r));
  await ui.scope.applyAuthoritativeSnapshot(authority.getSnapshot(),authority.getRevision());
  assert.equal(ui.book().getPageObjects().length,1);assert.equal(ui.savedCaches.at(-1).snapshot.canvas.objects[0].notebookPages[0].length,0);
  // Recovery may legitimately re-send the same action after its old request.
  release();await ui.flush();
 }finally{await ui.close();}
});


test('actual receiver retires only matching transient sessions after a notebook commit',async()=>{
 const book=initial(),{authority}=await authorityFixture([serialized(book)]);book.dispose();
 const receiver=await createUiHarness({authority,clientId:'student'});
 const writer=await createUiHarness({authority,deliver:result=>receiver.receive(result,'teacher')});
 try{
  const proxy=new Rect({width:10,height:10});proxy.boardObjectId='selection-preview';proxy.transientSelectionProxy=true;proxy.selectionTransactionId='tx';receiver.canvas.add(proxy);
  receiver.scope.remoteSelectionTransactionsRef.current.set('tx',{clientId:'teacher',sourceIds:['source'],phase:'awaiting-authoritative'});
  receiver.scope.remoteDrawSessionsRef.current.set('teacher:draw',{objectId:'source',sequence:5});
  receiver.scope.remoteDrawSessionsRef.current.set('other:draw',{objectId:'unrelated',sequence:1});
  await draw(writer,'source');await writer.flush();
  assert.equal(receiver.canvas.getObjects().includes(proxy),false,'no ghost selection proxy');
  assert.equal(receiver.scope.remoteSelectionTransactionsRef.current.get('tx').phase,'authoritative');
  assert.equal(receiver.scope.remoteDrawSessionsRef.current.has('teacher:draw'),false);
  assert.equal(receiver.scope.remoteDrawSessionsRef.current.has('other:draw'),true);
  assert.equal(receiver.errors.length+writer.errors.length,0);
 }finally{await writer.close();await receiver.close();}
});

test('actual projection failure disposes prepared notebook children before any split member changes',async()=>{
 const book=initial(),{authority}=await authorityFixture([serialized(book)]);book.dispose();const ui=await createUiHarness({authority});
 try{
  const target=structuredClone(serialized(ui.book()));const child=new Rect({width:8,height:8});child.boardObjectId='added';target.notebookPages[0]=[serialized(child)];child.dispose();
  let disposed=0;const prepare=ui.scope.prepareNotebookProjection;
  ui.scope.prepareNotebookProjection=async(...args)=>{const result=await prepare(...args);return {...result,dispose(){disposed++;result.dispose();}};};
  await assert.rejects(ui.scope.replayPendingActionsLocally([{ops:[{type:'upsert',object:target},{type:'upsert',object:{type:'UnregisteredType',boardObjectId:'outside'}}]}]),/восстановить/);
  assert.equal(ui.book().getPageObjects().length,0);assert.equal(ui.canvas.getObjects().length,1);assert.equal(disposed,1,'detached child preparation must be disposed');
 }finally{await ui.close();}
});

test('actual reconnect callback does not resume a retired controller',async()=>{
 const book=initial(),{authority}=await authorityFixture([serialized(book)]);book.dispose();const ui=await createUiHarness({authority});let release;
 try{
  const old=ui.scope.notebookControllerRef.current;let resumed=0;const resume=old.resume.bind(old);old.resume=()=>{resumed++;return resume();};
  ui.scope.realtimeRef.current.whenRuntimeReady=()=>new Promise(r=>release=r);
  const refreshing=ui.scope.ensureNotebookController({refresh:true});
  ui.scope.notebookControllerEpochRef.current++;old.dispose();ui.scope.notebookControllerRef.current=null;release();
  assert.equal(await refreshing,null);assert.equal(resumed,0);
 }finally{await ui.close();}
});

test('actual add handler keeps failed notebook input visible instead of silently publishing it outside',async()=>{
 const book=initial(),{authority}=await authorityFixture([serialized(book)]);book.dispose();const ui=await createUiHarness({authority});
 try{
  const ink=new Path('M 50 60 L 120 70',{stroke:'black',fill:null});ink.boardObjectId='source';ui.canvas.add(ink);
  const failure=new Error('Очередь заполнена');let upserts=0;
  ui.scope.notebookHandlersRef.current.capture=async()=>{throw failure;};ui.scope.sendRecordUpserts=()=>{upserts++;};
  await ui.scope.commitAddedObject(ink);
  assert.equal(upserts,0,'failed notebook action must not downgrade to an ordinary board write');assert.ok(ui.canvas.getObjects().includes(ink));
  assert.ok(ui.statuses.some(status=>String(status).includes('Очередь заполнена')));
 }finally{await ui.close();}
});

test('actual canvas recovery does not resume transmission after a failed load',async()=>{
 const book=initial(),{authority}=await authorityFixture([serialized(book)]);book.dispose();const ui=await createUiHarness({authority});
 try{
  const controller=ui.scope.notebookControllerRef.current;let resumed=0;const resume=controller.resume.bind(controller);controller.resume=()=>{resumed++;return resume();};
  const load=ui.scope.loadCanvasJsonProgressively;ui.scope.loadCanvasJsonProgressively=async()=>{throw Error('load failed');};
  await assert.rejects(ui.scope.applyAuthoritativeSnapshot(authority.getSnapshot(),authority.getRevision()),/load failed/);
  assert.equal(resumed,0,'failed restoration must keep transmission paused');
  ui.scope.loadCanvasJsonProgressively=load;await ui.scope.applyAuthoritativeSnapshot(authority.getSnapshot(),authority.getRevision());
  assert.equal(resumed,1);await draw(ui,'after-retry');await ui.flush();assert.equal(ui.book().getPageObjects().length,1);
 }finally{await ui.close();}
});

test('actual local rejection preserves a later stroke and the conflicting remote child',async()=>{
 const book=initial(),{authority}=await authorityFixture([serialized(book)]);book.dispose();let ui,calls=0,release;let foreignId;
 ui=await createUiHarness({authority,beforeCommit:async({ops})=>{
  calls++;if(calls===1)await new Promise(r=>release=r);
  if(calls===2){
   await ui.scope.authoritativeApplyQueueRef.current;
   const child=structuredClone(ops[0].changes[0].object);foreignId=child.boardObjectId;child.stroke='blue';
   const result=await authority.commitAction({actionId:'foreign',clientId:'other',baseRevision:authority.getRevision(),ops:[{type:'notebook',version:1,id:'book',pageNumber:1,changes:[{type:'insert',object:child,ifAbsent:true}]}]});
   assert.equal(await ui.receive(result,'other'),true);
  }
 }});
 try{
  for(let i=0;i<3;i++)await draw(ui,`local-${i}`,60+i*20);
  for(let i=0;i<1000&&!release;i++)await new Promise(r=>setImmediate(r));assert.equal(typeof release,'function');release();
  await ui.flush();
  assert.equal(ui.book().getPageObjects().length,3);assert.equal(ui.book().getPageObjects().find(child=>child.boardObjectId===foreignId).stroke,'blue');
  assert.equal(ui.scope.notebookControllerRef.current.pendingCount(),0);assert.deepEqual(ui.book().notebookPages,authority.getSnapshot().canvas.objects[0].notebookPages);
  assert.equal(ui.errors.length,1);assert.equal(ui.errors[0].code,'notebook_action_rejected');
 }finally{await ui.close();}
});


test('actual snapshot completion after canvas retirement cannot cache stale state',async()=>{
 const book=initial(),{authority}=await authorityFixture([serialized(book)]);book.dispose();const ui=await createUiHarness({authority});let release;
 try{
  ui.scope.loadCanvasJsonProgressively=()=>new Promise(r=>release=r);
  const loading=ui.scope.applyAuthoritativeSnapshot(authority.getSnapshot(),authority.getRevision());
  for(let i=0;i<20&&!release;i++)await new Promise(r=>setImmediate(r));
  ui.scope.fabricCanvasRef.current=null;ui.scope.boardReadyRef.current=false;release();await loading;
  assert.equal(ui.savedCaches.length,0);
 }finally{await ui.close();}
});


test('actual capture handler rejects a page switch that occurred during the physical stroke',async()=>{
 const book=initial(),{authority}=await authorityFixture([serialized(book)]);book.dispose();const ui=await createUiHarness({authority});
 try{
  const pages=ui.scope.snapshotNotebookGesturePages(ui.canvas),ink=new Path('M 50 60 L 120 70',{stroke:'black',fill:null});ink.boardObjectId='in-flight';ui.scope.bindNotebookGestureTarget(ink,pages);
  ui.canvas.setActiveObject(ui.book());await ui.scope.changeNotebookPage(2);await ui.flush();ui.canvas.add(ink);
  await assert.rejects(ui.scope.captureIntoNotebook(ink),/во время штриха/);
  assert.equal(ui.book().getPageObjects().length,0);assert.equal(ui.scope.notebookControllerRef.current.pendingCount(),0);assert.ok(ui.canvas.getObjects().includes(ink));
 }finally{await ui.close();}
});
