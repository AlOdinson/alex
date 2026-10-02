import test from 'node:test';
import assert from 'node:assert/strict';
import { ActiveSelection, Path, Rect, Textbox, FabricImage, util } from 'fabric';
import { BoardNotebook } from '../src/lib/boardNotebook.js';
import { prepareNotebookProjection } from '../src/lib/notebookProjection.js';
import { createNotebookBoardActions } from '../src/lib/notebookBoardActions.js';
import { authorityFixture,createUiHarness,serialized,callback } from './notebook-ui-node-harness.mjs';
import { attachDropHarness } from './notebook-drop-node-harness.mjs';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function bookRecord(){const n=new BoardNotebook({boardObjectId:'book',left:200,top:100,width:300,height:300});const r=serialized(n);n.dispose();return r;}
async function setup(objects=[],options={}){const fixture=await authorityFixture([bookRecord(),...objects]);const ui=await createUiHarness({...fixture,...options});const input=attachDropHarness(ui);
 // Use the actual world-coordinate serializer used by Board for ActiveSelection members.
 ui.scope.incrementalNotebookActions=createNotebookBoardActions({getCanvas:()=>ui.canvas,getController:()=>ui.scope.ensureNotebookController(),clientId:'teacher',
  getRecords:ui.scope.getObjectRecords,recordAction:ui.scope.recordAction,acquireLease:(...a)=>ui.scope.acquireLocalSelectionLease(...a),ownsLease:(...a)=>ui.scope.ownsSelectionLease(...a),releaseLease:()=>{},
  mutate:work=>{ui.scope.applyingRemoteRef.current=true;try{return work();}finally{ui.scope.applyingRemoteRef.current=false;}},onError:error=>ui.errors.push(error)});
 return {...fixture,ui,input};}
function sourceRect(id,left,top){const r=new Rect({left,top,width:60,height:45,fill:'red',strokeWidth:0});r.boardObjectId=id;return r;}
function frame(object){return object.calcTransformMatrix().map(x=>Math.round(x*1e6)/1e6);}

for (const group of [false,true]) test(`released notebook ${group?'group ':''}move reaches model before immediate page flip`,async()=>{
 const {ui,input,authority}=await setup(group?[serialized(sourceRect('sibling',560,440))]:[]);
 try{
  for(const [id,page]of[['one',1],['two',2]]){
   ui.canvas.setActiveObject(ui.book());await ui.scope.changeNotebookPage(page);await ui.flush();
   const p=new Path(`M 240 ${130+page*20} L 290 ${140+page*20}`,{stroke:'black',fill:null});p.boardObjectId=id;ui.canvas.add(p);await ui.scope.captureIntoNotebook(p);await ui.flush();
  }
  const n=ui.book(),target=group?new ActiveSelection(ui.canvas.getObjects(),{canvas:ui.canvas}):n;
  ui.canvas.setActiveObject(target);input.begin(target);target.set({left:target.left+85,top:target.top+45});target.setCoords();
  const wanted=frame(n);input.release(target);
  ui.canvas.discardActiveObject();ui.canvas.setActiveObject(n);
  // The release must update the optimistic model synchronously, before page work.
  const model=ui.scope.notebookControllerRef.current.getState().snapshot.canvas.objects.find(x=>x.boardObjectId==='book');
  const modelFrame=new BoardNotebook({...model,notebookPages:[[]],notebookPageNumber:1});
  const actual=frame(modelFrame);modelFrame.dispose();assert.deepEqual(actual,wanted,'released move was left outside the notebook model');
  // Do not flush the deliberately held ordinary transform timer before flipping.
  await ui.scope.changeNotebookPage(3);await ui.flush();
  assert.deepEqual(frame(n),wanted,'page flip restored stale pre-drag coordinates');
  await input.settle();
  const saved=authority.getSnapshot().canvas.objects.find(x=>x.boardObjectId==='book');
  const reopened=await BoardNotebook.fromObject(saved);assert.deepEqual(frame(reopened),wanted);reopened.dispose();
  assert.deepEqual(ui.errors,[]);
 }finally{ui.scope.deferredTransformFlushRef.current=null;await input.settle();await ui.close();}
});

test('page-only hydration never invents a frame delta from a later move',async()=>{
 const n=new BoardNotebook({boardObjectId:'n',left:20,top:30});const child=serialized(sourceRect('page-two',-50,-50));
 const target={...serialized(n),notebookPages:[[],[child]],notebookPageNumber:2};
 let release;const blocked=new Promise(r=>release=r);const original=Rect.fromObject;
 Rect.fromObject=async function(...args){await blocked;return original.apply(this,args);};
 try{const pending=prepareNotebookProjection(n,target);n.set({left:350,top:230});n.setCoords();const wanted=frame(n);release();const prepared=await pending;
  assert.equal(prepared.apply(),true);assert.deepEqual(frame(n),wanted);assert.equal(n.notebookPageNumber,2);prepared.dispose();
 }finally{release();Rect.fromObject=original;n.dispose();}
});

test('moving a mixed multiselection absorbs only overlap in one undoable action',async()=>{
 const r=sourceRect('shape',10,150),t=new Textbox('Editable text',{left:30,top:220,width:90,fontSize:18});t.boardObjectId='text';
 const bitmap=util.createCanvasElement();bitmap.width=100;bitmap.height=60;bitmap.getContext('2d').fillRect(0,0,100,60);
 const image=new FabricImage(bitmap,{left:140,top:310});image.boardObjectId='picture';
 const away=sourceRect('away',520,480);
 const before=[r,t,image,away].map(serialized);[r,t,image,away].forEach(x=>x.dispose());
 const {ui,input,authority}=await setup(before);
 try{
  const sources=ui.canvas.getObjects().filter(o=>o.boardObjectId!=='book'),positions=new Map(sources.map(o=>[o.boardObjectId,frame(o)]));
  const target=new ActiveSelection(sources,{canvas:ui.canvas});ui.canvas.setActiveObject(target);input.begin(target);target.set({left:target.left+220,top:target.top});target.setCoords();input.release(target);
  await input.settle();
  assert.equal(ui.book().getPageObjects().length,3,'all eligible members must be captured');
  assert.equal(ui.canvas.getObjects().some(o=>o.boardObjectId==='shape'),false);assert.equal(ui.book().getPageObjects().find(o=>o.type==='textbox')?.text,'Editable text');
  // Image is fully within x=360..460; separate far-away member keeps its moved position.
  assert.equal(ui.canvas.getObjects().some(o=>o.boardObjectId==='picture'),false);
  assert.equal(ui.history.length,1,'one drag must produce one compound history action');
  assert.equal(authority.getSnapshot().canvas.objects.find(x=>x.boardObjectId==='book').notebookPages[0].length,3);
  let historyOps=ui.history[0].nextHistoryOps;
  const undone=await ui.scope.commitConditionalHistoryOps(historyOps);await ui.flush();
  assert.equal(ui.book().getPageObjects().length,0);
  for(const [id,matrix]of positions)assert.deepEqual(frame(ui.canvas.getObjects().find(o=>o.boardObjectId===id)),matrix,`undo ${id}`);
  const inverse=undone?.historyInverseOps;
  assert.ok(inverse?.length,'authority provides redo');await ui.scope.commitConditionalHistoryOps(inverse);await ui.flush();assert.equal(ui.book().getPageObjects().length,3);
  assert.deepEqual(ui.errors,[]);
 }finally{ui.scope.deferredTransformFlushRef.current=null;await input.settle();await ui.close();}
});

test('partially dropped text becomes complementary images and undo restores editable text at pre-move position',async()=>{
 const t=new Textbox('Boundary text',{left:0,top:150,width:150,fontSize:22});t.boardObjectId='text';const record=serialized(t);t.dispose();
 const {ui,input}=await setup([record]);
 try{const text=ui.canvas.getObjects().find(o=>o.boardObjectId==='text'),wanted=frame(text);ui.canvas.setActiveObject(text);input.begin(text);text.set({left:150});text.setCoords();input.release(text);await input.settle();
  assert.equal(ui.book().getPageObjects().length,1);assert.equal(ui.book().getPageObjects()[0].type,'image');
  const outside=ui.canvas.getObjects().find(o=>o.boardObjectId==='text');assert.equal(outside.type,'image');assert.equal(outside.clipPath.inverted,true);
  await ui.scope.commitConditionalHistoryOps(ui.history[0].nextHistoryOps);await ui.flush();const restored=ui.canvas.getObjects().find(o=>o.boardObjectId==='text');assert.equal(restored.type,'textbox');assert.equal(restored.text,'Boundary text');assert.deepEqual(frame(restored),wanted);assert.equal(ui.book().getPageObjects().length,0);
 }finally{ui.scope.deferredTransformFlushRef.current=null;await input.settle();await ui.close();}
});

test('initial static image upload remains whole even over notebook',async()=>{
 const {ui,input}=await setup();
 try{
  const s=ui.scope,bitmap=util.createCanvasElement();bitmap.width=100;bitmap.height=80;bitmap.getContext('2d').fillRect(0,0,100,80);
  Object.assign(s,{isAcceptedBoardFile:()=>true,getViewportSceneCenter:()=>({x:210,y:200}),
   createImagePlaceholder:point=>new Rect({left:point.x,top:point.y,width:20,height:20}),
   storeBoardImage:async()=>({storagePath:null,url:bitmap.toDataURL()}),loadImageElement:async()=>bitmap,
   MIN_ZOOM:0.05,publishBoardImage:async publish=>publish(),selectInsertedObjects:objects=>ui.canvas.setActiveObject(objects[0]),
  });
  s.sendRecordUpserts=callback('sendRecordUpserts',s);s.addImageFiles=callback('addImageFiles',s);s.realtimeRef.current.requestSync=async()=>{};
  await s.addImageFiles([new File([Buffer.from('not-a-media-header')],'fixture.png',{type:'image/png'})]);await input.settle();
  assert.equal(ui.book().getPageObjects().length,0,'initial upload must not capture the overlapping strip');
  const image=ui.canvas.getObjects().find(o=>o.type==='image');assert.ok(image,'whole image remains a board object');assert.equal(image.clipPath,undefined);
  // Initial selection itself is not a drop. A later actual movement is.
  input.begin(image);image.set({left:270,top:230});image.setCoords();input.release(image);await input.settle();assert.equal(ui.book().getPageObjects().length,1);
 }finally{ui.scope.deferredTransformFlushRef.current=null;await input.settle();await ui.close();}
});

test('resizing a standalone picture over notebook is not a deliberate move/drop',async()=>{
 const bitmap=util.createCanvasElement();bitmap.width=100;bitmap.height=60;
 const image=new FabricImage(bitmap,{left:180,top:180});image.boardObjectId='resize-only';const r=serialized(image);image.dispose();
 const {ui,input}=await setup([r]);
 try{const image=ui.canvas.getObjects().find(o=>o.boardObjectId==='resize-only');ui.canvas.setActiveObject(image);input.begin(image);image.set({scaleX:1.2,scaleY:1.2});image.setCoords();input.release(image,'scale');await input.settle();
  assert.equal(ui.book().getPageObjects().length,0,'resize is not the requested drop gesture');assert.ok(ui.canvas.getObjects().includes(image));assert.equal(image.clipPath,undefined);
 }finally{ui.scope.deferredTransformFlushRef.current=null;await input.settle();await ui.close();}
});

test('split multiselection preserves pixels, outside fragments and one-step undo/redo',async()=>{
 const r=sourceRect('split-shape',0,150),t=new Textbox('split text',{left:0,top:220,width:130,fontSize:20});t.boardObjectId='split-text';
 const bitmap=util.createCanvasElement();bitmap.width=100;bitmap.height=70;const context=bitmap.getContext('2d');context.fillStyle='blue';context.fillRect(0,0,100,70);
 const image=new FabricImage(bitmap,{left:0,top:300});image.boardObjectId='split-image';const before=[r,t,image].map(serialized);[r,t,image].forEach(o=>o.dispose());
 const {ui,input}=await setup(before);
 try{
  const c=ui.canvas,sources=c.getObjects().filter(o=>o.boardObjectId!=='book'),target=new ActiveSelection(sources,{canvas:c});c.setActiveObject(target);input.begin(target);target.set({left:target.left+180});target.setCoords();
  c.discardActiveObject();c.renderAll();const expected=Buffer.from(c.getContext().getImageData(0,0,800,700).data);
  c.setActiveObject(new ActiveSelection(sources,{canvas:c}));input.release(c.getActiveObject());await input.settle();c.discardActiveObject();c.renderAll();
  assert.equal(ui.book().getPageObjects().length,3);assert.equal(c.getObjects().length,4);
  const actual=Buffer.from(c.getContext().getImageData(0,0,800,700).data);
  // Clipping boundaries/text rasterization can change antialiasing, but not region placement.
  let errors=0;for(let i=0;i<actual.length;i+=4)if(Math.abs(actual[i]-expected[i])+Math.abs(actual[i+1]-expected[i+1])+Math.abs(actual[i+2]-expected[i+2])>90)errors++;
  assert.ok(errors<600,`split changed ${errors} pixels away from expected scene`);
  assert.equal(c.getObjects().find(o=>o.boardObjectId==='split-text').type,'image');
  const undone=await ui.scope.commitConditionalHistoryOps(ui.history[0].nextHistoryOps);await ui.flush();assert.equal(ui.book().getPageObjects().length,0);
  assert.equal(c.getObjects().find(o=>o.boardObjectId==='split-text').type,'textbox');
  await ui.scope.commitConditionalHistoryOps(undone.historyInverseOps);await ui.flush();assert.equal(ui.book().getPageObjects().length,3);assert.equal(c.getObjects().length,4);assert.deepEqual(ui.errors,[]);
 }finally{ui.scope.deferredTransformFlushRef.current=null;await input.settle();await ui.close();}
});

for(const invalidation of ['source-move','page-switch','notebook-move']) test(`async drop refuses ${invalidation} without removing originals`,async()=>{
 const r=sourceRect('waiting',10,150),initial=serialized(r);r.dispose();const {ui,input}=await setup([initial]);let release;
 try{
  const object=ui.canvas.getObjects().find(o=>o.boardObjectId==='waiting');const before=ui.scope.getObjectRecords([object]);object.set({left:240});object.setCoords();
  const clone=object.clone.bind(object);object.clone=async(...args)=>{await new Promise(resolve=>release=resolve);return clone(...args);};
  const pending=ui.scope.dropSelectionIntoNotebook([object],{before});for(let i=0;i<20&&!release;i++)await tick();assert.equal(typeof release,'function');
  if(invalidation==='source-move')object.set({left:20});
  if(invalidation==='page-switch')ui.book().notebookPageNumber=2;
  if(invalidation==='notebook-move')ui.book().set({left:450});
  release();await assert.rejects(pending,/измени|повторите/);assert.ok(ui.canvas.getObjects().includes(object));assert.equal(ui.book().getPageObjects().length,0);assert.equal(ui.history.length,0);
 }finally{release?.();ui.scope.notebookQueueRef.current=Promise.resolve();await ui.close();}
});

test('denied union lease leaves the entire source selection untouched',async()=>{
 const r=sourceRect('denied',10,150),initial=serialized(r);r.dispose();const {ui,input}=await setup([initial]);
 try{const object=ui.canvas.getObjects().find(o=>o.boardObjectId==='denied');const before=ui.scope.getObjectRecords([object]);object.set({left:240});object.setCoords();ui.scope.acquireLocalSelectionLease=async()=>false;
  await assert.rejects(ui.scope.dropSelectionIntoNotebook([object],{before}),/заняты/);assert.ok(ui.canvas.getObjects().includes(object));assert.equal(ui.book().getPageObjects().length,0);assert.equal(ui.history.length,0);
 }finally{ui.scope.notebookQueueRef.current=Promise.resolve();await ui.close();}
});

test('a notebook carried with selected objects does not absorb those objects',async()=>{
 const initial=serialized(sourceRect('carried',230,160));const {ui,input}=await setup([initial]);
 try{const target=new ActiveSelection(ui.canvas.getObjects(),{canvas:ui.canvas});ui.canvas.setActiveObject(target);input.begin(target);target.set({left:target.left+40});target.setCoords();input.release(target);await input.settle();
  assert.equal(ui.book().getPageObjects().length,0);assert.equal(ui.canvas.getObjects().length,2);assert.deepEqual(ui.errors,[]);
 }finally{ui.scope.deferredTransformFlushRef.current=null;await input.settle();await ui.close();}
});

test('notebook move and next page remain responsive before acknowledgement',async()=>{
 let release,first=true;const {ui,input}=await setup([],{beforeCommit:async()=>{if(first){first=false;await new Promise(resolve=>release=resolve);}}});
 try{const n=ui.book();ui.canvas.setActiveObject(n);input.begin(n);n.set({left:370,top:190});n.setCoords();const wanted=frame(n);input.release(n);
  await ui.scope.changeNotebookPage(2);await ui.scope.notebookControllerRef.current.whenPainted();assert.deepEqual(frame(n),wanted);assert.equal(n.notebookPageNumber,2);assert.equal(ui.scope.notebookControllerRef.current.pendingCount(),2);
  // Unblock subsequent commits while preserving the already pending promise.
  for(let i=0;i<20&&!release;i++)await tick();assert.equal(typeof release,'function');
 }finally{
  release?.();await ui.flush();await ui.close();
 }
});

test('teacher drop, student projection, undo and redo agree on a mixed group',async()=>{
 const r=sourceRect('shared-shape',30,180),t=new Textbox('shared text',{left:10,top:260,width:100,fontSize:16});t.boardObjectId='shared-text';
 const records=[r,t].map(serialized);[r,t].forEach(o=>o.dispose());let receiver;
 const {ui,input,authority}=await setup(records,{deliver:async(result,id)=>{if(receiver)await receiver.receive(result,id);}});
 receiver=await createUiHarness({authority,clientId:'student'});
 try{const c=ui.canvas,sources=c.getObjects().filter(o=>o.boardObjectId!=='book'),target=new ActiveSelection(sources,{canvas:c});c.setActiveObject(target);input.begin(target);target.set({left:target.left+210});target.setCoords();input.release(target);await input.settle();
  assert.equal(ui.book().getPageObjects().length,2);assert.deepEqual(receiver.book().notebookPages,ui.book().notebookPages);
  const undone=await ui.scope.commitConditionalHistoryOps(ui.history[0].nextHistoryOps);await ui.flush();assert.equal(receiver.book().getPageObjects().length,0);
  assert.equal(receiver.canvas.getObjects().find(o=>o.boardObjectId==='shared-text').type,'textbox');
  await ui.scope.commitConditionalHistoryOps(undone.historyInverseOps);await ui.flush();assert.deepEqual(receiver.book().notebookPages,ui.book().notebookPages);assert.deepEqual(ui.errors,[]);assert.deepEqual(receiver.errors,[]);
 }finally{ui.scope.deferredTransformFlushRef.current=null;await input.settle();await ui.close();await receiver.close();}
});

test('fully absorbed members do not change outside-fragment stacking against untouched objects',async()=>{
 const a=sourceRect('contained',50,140),b=sourceRect('split',-10,200),front=sourceRect('untouched-front',560,440);
 const records=[a,b,front].map(serialized);[a,b,front].forEach(o=>o.dispose());const {ui,input,authority}=await setup(records);
 try{const c=ui.canvas,sources=c.getObjects().filter(o=>['contained','split'].includes(o.boardObjectId)),target=new ActiveSelection(sources,{canvas:c});c.setActiveObject(target);input.begin(target);target.set({left:target.left+220});target.setCoords();input.release(target);await input.settle();
  assert.equal(ui.book().getPageObjects().length,2);
  const expected=authority.getSnapshot().canvas.objects.map(o=>o.boardObjectId);
  assert.deepEqual(c.getObjects().map(o=>o.boardObjectId),expected,'outside fragment must stay below the untouched foreground');
 }finally{ui.scope.deferredTransformFlushRef.current=null;await input.settle();await ui.close();}
});
