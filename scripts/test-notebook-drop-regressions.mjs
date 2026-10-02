import test from 'node:test';
import assert from 'node:assert/strict';
import { Rect, Path } from 'fabric';
import { BoardNotebook } from '../src/lib/boardNotebook.js';
import { authorityFixture, createUiHarness, serialized } from './notebook-ui-node-harness.mjs';

async function harness() {
  const book=new BoardNotebook({boardObjectId:'book',left:20,top:20,width:300,height:300,notebookPages:[[],[],[]]});
  const {authority}=await authorityFixture([serialized(book)]);book.dispose();
  return createUiHarness({authority});
}
function move(ui,left,top) {
  const book=ui.book();book.set({left,top});book.setCoords();
  ui.scope.queueDeferredTransformPersistence([{id:'book',object:book,transform:{left,top},updatedAt:Date.now(),updatedBy:'teacher'}]);
}
test('notebook frame enters the local model synchronously at drag release',async()=>{
  const ui=await harness();
  try {move(ui,350,220);
    const model=ui.scope.notebookControllerRef.current.getState().snapshot.canvas.objects[0];
    assert.equal(model.left,350,'a page edit must never project the pre-drag frame');
    assert.equal(model.top,220);
  }finally{await ui.close();}
});
test('draw, next page, draw, move, next page keeps the new frame and page content',async()=>{
  const ui=await harness();
  try {
    for(let page=1;page<=2;page++){
      ui.canvas.setActiveObject(ui.book());await ui.scope.changeNotebookPage(page);
      const ink=new Path('M 50 60 L 120 80',{stroke:'black',fill:null});ink.boardObjectId=`ink-${page}`;ui.canvas.add(ink);
      await ui.scope.captureIntoNotebook(ink);await ui.flush();
    }
    move(ui,350,220);ui.canvas.setActiveObject(ui.book());await ui.scope.changeNotebookPage(3);await ui.scope.notebookControllerRef.current.whenPainted();
    assert.equal(ui.book().left,350);assert.equal(ui.book().top,220);assert.equal(ui.book().notebookPageNumber,3);
    assert.equal(ui.book().notebookPages[0].length,1);assert.equal(ui.book().notebookPages[1].length,1);
  }finally{await ui.close();}
});
test('publishing a notebook transform cannot wait on its own deferred flush',async()=>{
  const ui=await harness();let timer;
  try {move(ui,350,220);
    const flushed=ui.scope.flushDeferredTransformPersistence({force:true});
    const result=await Promise.race([Promise.resolve(flushed).then(()=> 'done'),new Promise(resolve=>{timer=setTimeout(()=>resolve('self-wait'),800);})]);
    assert.equal(result,'done','deferred transform publication waits for its own acknowledgement');
    await ui.flush();assert.equal(ui.scope.notebookControllerRef.current.pendingCount(),0);
  }finally{clearTimeout(timer);await ui.close();}
});

test('actual image insertion over the notebook stays a standalone image and never requests capture',async()=>{
  const {FabricImage,Point,util}=await import('fabric');
  const ui=await harness();let captures=0;
  try {
    const bitmap=util.createCanvasElement();bitmap.width=100;bitmap.height=100;bitmap.getContext('2d').fillRect(0,0,100,100);
    Object.assign(ui.scope,{FabricImage,Point,MIN_ZOOM:0.1,isAcceptedBoardFile:()=>true,
      getViewportSceneCenter:()=>new Point(160,160),createImagePlaceholder:point=>new Rect({left:point.x,top:point.y,width:10,height:10}),
      storeBoardImage:async()=>({url:bitmap.toDataURL(),storagePath:null}),loadImageElement:async()=>bitmap,
      publishBoardImage:submit=>submit(),selectInsertedObjects:objects=>ui.canvas.setActiveObject(objects[0]),
    });
    ui.scope.notebookHandlersRef.current.capture=async()=>{captures++;return true;};
    await ui.scope.addImageFiles([new File(['png-fixture'],'fixture.png',{type:'image/png'})]);await ui.flush();
    assert.equal(captures,0,'upload/paste must not clip an image before its later drag');
    assert.equal(ui.book().getPageObjects().length,0);
    const images=ui.canvas.getObjects().filter(object=>object instanceof FabricImage);
    assert.equal(images.length,1);assert.equal(images[0].clipPath,undefined);
    assert.equal(ui.history.at(-1).type,'add');
  }finally{await ui.close();}
});

test('dropping a moved selection captures intersecting members atomically and one undo restores the original selection',async()=>{
  const {ActiveSelection,Textbox,FabricImage,util}=await import('fabric');
  const book=new BoardNotebook({boardObjectId:'book',left:200,top:200,width:300,height:300,notebookPages:[[],[]]});
  const shape=new Rect({left:40,top:60,width:30,height:30,fill:'red',originX:'left',originY:'top'});shape.boardObjectId='shape';
  const text=new Textbox('whole text',{left:70,top:110,width:100,fontSize:16});text.boardObjectId='text';
  const bitmap=util.createCanvasElement();bitmap.width=80;bitmap.height=80;bitmap.getContext('2d').fillRect(0,0,80,80);
  const picture=new FabricImage(bitmap,{left:-20,top:80});picture.boardObjectId='picture';
  const outside=new Rect({left:-170,top:60,width:20,height:20});outside.boardObjectId='outside';
  const {authority}=await authorityFixture([book,shape,text,picture,outside].map(serialized));book.dispose();
  const ui=await createUiHarness({authority});
  try {
    const objects=ui.canvas.getObjects().filter(o=>o!==ui.book());
    const selection=new ActiveSelection(objects,{canvas:ui.canvas});ui.canvas.setActiveObject(selection);
    // Board captures before:transform records AFTER Fabric builds ActiveSelection.
    const before=ui.scope.getObjectRecords(objects);
    selection.set({left:selection.left+200,top:selection.top+180});selection.setCoords();
    const actions=ui.scope.incrementalNotebookActions;
    assert.equal(typeof actions.captureSelection,'function','missing multi-object notebook drop path');
    const entries=objects.map(object=>({object,notebook:object.boardObjectId==='outside'?null:ui.book(),pageNumber:1}));
    assert.equal(await ui.scope.captureNotebookSelection(objects,{before}),true);await ui.flush();
    assert.equal(ui.book().getPageObjects().length,3);assert.ok(ui.book().getPageObjects().some(o=>o.text==='whole text'));
    assert.equal(ui.canvas.getObjects().find(o=>o.boardObjectId==='outside').left,30);
    assert.ok(ui.canvas.getObjects().find(o=>o.boardObjectId==='picture')?.clipPath?.inverted);
    assert.equal(ui.history.length,1);assert.equal(ui.history[0].type,'compound');
    const undo=await ui.scope.commitConditionalHistoryOps(ui.history[0].nextHistoryOps);await ui.flush();
    assert.equal(ui.book().getPageObjects().length,0);assert.equal(ui.canvas.getObjects().length,5);
    assert.equal(ui.canvas.getObjects().find(o=>o.boardObjectId==='picture').left,-20);
    assert.equal(ui.canvas.getObjects().find(o=>o.boardObjectId==='shape').left,40);
    assert.equal(ui.canvas.getObjects().find(o=>o.boardObjectId==='outside').left,-170);
    assert.equal(ui.errors.length,0);
    await ui.scope.commitConditionalHistoryOps(undo.historyInverseOps);await ui.flush();
    assert.equal(ui.book().getPageObjects().length,3);
    assert.equal(ui.canvas.getObjects().find(o=>o.boardObjectId==='outside').left,30);
  }finally{await ui.close();}
});

test('a partly dropped published text becomes clipped images and undo restores editable text on both participants',async()=>{
  const {Textbox}=await import('fabric');
  const book=new BoardNotebook({boardObjectId:'book',left:200,top:200,width:300,height:300,notebookPages:[[]]});
  const source=new Textbox('boundary text',{left:40,top:100,width:180,fontSize:20,originX:'left',originY:'top'});source.boardObjectId='source';
  const {authority}=await authorityFixture([serialized(book),serialized(source)]);book.dispose();source.dispose();
  const receiver=await createUiHarness({authority,clientId:'student'});
  const writer=await createUiHarness({authority,deliver:async(result,id)=>{assert.equal(await receiver.receive(result,id),true);}});
  try {
    const text=writer.canvas.getObjects().find(o=>o.boardObjectId==='source'),before=writer.scope.getObjectRecords([text]);
    text.set({left:160,top:250});text.setCoords();
    assert.equal(await writer.scope.captureNotebookSelection([text],{before}),true);await writer.flush();
    for(const ui of [writer,receiver]){
      assert.equal(ui.book().getPageObjects().length,1);assert.equal(ui.book().getPageObjects()[0].type,'image');
      assert.equal(ui.canvas.getObjects().find(o=>o.boardObjectId==='source').type,'image');
    }
    const result=await writer.scope.commitConditionalHistoryOps(writer.history[0].nextHistoryOps);await writer.flush();
    assert.equal(result.changed,true);
    for(const ui of [writer,receiver]){
      assert.equal(ui.book().getPageObjects().length,0);
      const restored=ui.canvas.getObjects().find(o=>o.boardObjectId==='source');assert.equal(restored.type,'textbox');assert.equal(restored.text,'boundary text');assert.equal(restored.left,40);
      assert.deepEqual(ui.errors,[]);
    }
  }finally{await writer.close();await receiver.close();}
});

test('moving the notebook with other selected objects never captures those companions',async()=>{
  const ui=await harness();
  try {const shape=new Rect({left:60,top:60,width:30,height:30});shape.boardObjectId='companion';ui.canvas.add(shape);
    assert.equal(await ui.scope.captureNotebookSelection([ui.book(),shape]),false);
    assert.equal(ui.book().getPageObjects().length,0);assert.ok(ui.canvas.getObjects().includes(shape));
  }finally{await ui.close();}
});

test('a newer gesture during asynchronous drop preparation leaves every source intact',async()=>{
  const ui=await harness();let release;
  try {const shape=new Rect({left:60,top:60,width:30,height:30});shape.boardObjectId='source';ui.canvas.add(shape);
    const original=shape.clone.bind(shape);shape.clone=async(...args)=>{await new Promise(resolve=>release=resolve);return original(...args);};
    const work=ui.scope.incrementalNotebookActions.captureSelection([{object:shape,notebook:ui.book(),pageNumber:1}],{before:ui.scope.getObjectRecords([shape])});
    for(let i=0;i<20&&!release;i++)await Promise.resolve();assert.equal(typeof release,'function');
    shape.set({left:90});shape.setCoords();release();await assert.rejects(work,/Страница/);
    assert.ok(ui.canvas.getObjects().includes(shape));assert.equal(shape.left,90);assert.equal(ui.book().getPageObjects().length,0);assert.equal(ui.history.length,0);
  }finally{await ui.close();}
});

test('a drop waiting for an earlier write cannot consume a later source gesture',async()=>{
  const book=new BoardNotebook({boardObjectId:'book',left:200,top:200,width:300,height:300,notebookPages:[[]]});
  const shape=new Rect({left:50,top:60,width:30,height:30,originX:'left',originY:'top'});shape.boardObjectId='source';
  const {authority}=await authorityFixture([book,shape].map(serialized));book.dispose();shape.dispose();
  const ui=await createUiHarness({authority});let release;
  try {
    const source=ui.canvas.getObjects().find(o=>o.boardObjectId==='source'),before=ui.scope.getObjectRecords([source]);
    source.set({left:250,top:250});source.setCoords();
    ui.scope.deferredTransformFlushRef.current=()=>new Promise(resolve=>release=resolve);
    const drop=ui.scope.captureNotebookSelection([source],{before});
    for(let i=0;i<20&&!release;i++)await Promise.resolve();assert.equal(typeof release,'function');
    source.set({left:280});source.setCoords();release();
    await assert.rejects(drop,/изменил|Страница/);
    assert.ok(ui.canvas.getObjects().includes(source));assert.equal(source.left,280);
    assert.equal(ui.book().getPageObjects().length,0);assert.equal(ui.history.length,0);
  }finally{ui.scope.deferredTransformFlushRef.current=null;await ui.close();}
});

for(const conflict of ['placement','content'])test(`selection origin normalization never hides a real ${conflict} conflict`,async()=>{
  const {ActiveSelection}=await import('fabric');
  const book=new BoardNotebook({boardObjectId:'book',left:200,top:200,width:300,height:300,notebookPages:[[]]});
  const shape=new Rect({left:50,top:60,width:30,height:30,fill:'red',originX:'left',originY:'top'});shape.boardObjectId='source';
  const {authority}=await authorityFixture([book,shape].map(serialized));book.dispose();shape.dispose();
  const ui=await createUiHarness({authority});
  try {
    const source=ui.canvas.getObjects().find(o=>o.boardObjectId==='source');
    const selection=new ActiveSelection([source],{canvas:ui.canvas});ui.canvas.setActiveObject(selection);
    const before=ui.scope.getObjectRecords([source]);
    if(conflict==='placement')before[0].object.left-=10;else before[0].object.fill='blue';
    selection.set({left:selection.left+200,top:selection.top+180});selection.setCoords();
    await ui.scope.captureNotebookSelection([source],{before});await ui.flush();
    assert.equal(ui.book().getPageObjects().length,0);
    const saved=authority.getSnapshot().canvas.objects.find(o=>o.boardObjectId==='source');
    assert.equal(saved.left,50);assert.equal(saved.top,60);assert.equal(saved.fill,'red');
  }finally{await ui.close();}
});

test('an older page acknowledgement cannot restore frame geometry during a held native drag',async()=>{
  const actions=await import('../src/lib/notebookBoardActions.js');
  const ui=await harness(),events=new EventTarget();let cleanup;
  try {
    cleanup=actions.holdNotebookTransformProjection?.(ui.scope.notebookControllerRef.current,{eventTarget:events,pointerId:7,getPending:()=>ui.scope.notebookQueueRef.current});
    ui.book().set({left:350,top:220});ui.book().setCoords();
    // A previous stroke is acknowledged while the pointer still holds the frame.
    const c=ui.scope.notebookControllerRef.current;
    c.ack({actionId:'late-page-ack',clientId:'other',revision:1,changed:true,accepted:true,
      appliedOps:[{type:'notebook',version:1,id:'book',pageNumber:1,changes:[{type:'insert',object:{type:'Rect',boardObjectId:'late-child',left:0,top:0,width:10,height:10}}]}]});
    await c.whenPainted();
    assert.equal(ui.book().left,350,'acknowledging an older stroke overwrote the held drag');
    assert.equal(ui.book().top,220);
    // For this UI-only projection probe, release installs the new optimistic
    // geometry without publishing against the deliberately synthetic revision.
    c.pause('test synthetic revision');
    c.enqueue({ops:[{type:'patch',version:1,id:'book',patch:{left:350,top:220}}]});
    const end=new Event('pointerup');Object.defineProperty(end,'pointerId',{value:7});events.dispatchEvent(end);
    await new Promise(resolve=>setTimeout(resolve,10));await c.whenPainted();
    assert.equal(ui.book().left,350);assert.equal(ui.book().top,220);
    assert.equal(ui.book().getPageObjects().length,1);
  }finally{cleanup?.();await ui.close();}
});

for(const terminal of ['pointerup','pointercancel','blur'])test(`projection hold releases once after ${terminal}, not after another pointer`,async()=>{
  const {holdNotebookTransformProjection}=await import('../src/lib/notebookBoardActions.js');
  const events=new EventTarget();let depth=0,releaseCount=0,completeDrop;
  const work=new Promise(resolve=>completeDrop=resolve);
  const cleanup=holdNotebookTransformProjection({suspendProjection(){depth++;},resumeProjection(){depth--;releaseCount++;}},
    {eventTarget:events,pointerId:4,getPending:()=>work});
  const unrelated=new Event('pointerup');Object.defineProperty(unrelated,'pointerId',{value:9});events.dispatchEvent(unrelated);
  await new Promise(resolve=>setImmediate(resolve));assert.equal(depth,1);
  const end=new Event(terminal);Object.defineProperty(end,'pointerId',{value:4});events.dispatchEvent(end);
  await new Promise(resolve=>setImmediate(resolve));assert.equal(depth,1,'projection resumed before drop preparation completed');
  completeDrop();await new Promise(resolve=>setTimeout(resolve,10));assert.equal(depth,0);assert.equal(releaseCount,1);
  events.dispatchEvent(end);cleanup();assert.equal(releaseCount,1);
});

test('native capture release cannot project before later Fabric event listeners enqueue their work',async()=>{
  const {holdNotebookTransformProjection}=await import('../src/lib/notebookBoardActions.js');
  const events=new EventTarget();let depth=0;
  const cleanup=holdNotebookTransformProjection({suspendProjection(){depth++;},resumeProjection(){depth--;}},{eventTarget:events,pointerId:4});
  try {
    const end=new Event('pointerup');Object.defineProperty(end,'pointerId',{value:4});events.dispatchEvent(end);
    // Native browser dispatch may run microtasks BETWEEN event listeners.
    for(let i=0;i<5;i++)await Promise.resolve();
    assert.equal(depth,1,'capture-phase microtasks resumed projection before the Fabric release listener');
    await new Promise(resolve=>setTimeout(resolve,10));assert.equal(depth,0);
  }finally{cleanup();}
});
