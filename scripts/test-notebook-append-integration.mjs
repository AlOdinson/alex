import test from 'node:test';
import assert from 'node:assert/strict';
import {Path} from 'fabric';
import {BoardNotebook} from '../src/lib/boardNotebook.js';
import {authorityFixture,createUiHarness,serialized} from './notebook-ui-node-harness.mjs';

test('actual Board capture, durable confirmation and projection keep the old page geometry cached',async()=>{
 const book=new BoardNotebook({boardObjectId:'book',left:20,top:20});
 for(let i=0;i<100;i++)book.addPageObject(new Path(`M -180 ${-150+i*3} L 80 ${-147+i*3}`,{boardObjectId:`old${i}`,stroke:'black',strokeWidth:2,fill:null}));
 const {authority}=await authorityFixture([serialized(book)]);book.dispose();
 const ui=await createUiHarness({authority});
 try{
  ui.canvas.renderAll();let oldRenders=0;
  for(const child of ui.book().getPageObjects()){const render=child.render;child.render=function(...args){oldRenders++;return render.apply(this,args);};}
  const ink=new Path('M 140 340 L 200 345',{stroke:'black',strokeWidth:3,fill:null,boardObjectId:'new-source'});ui.canvas.add(ink);
  assert.equal(await ui.scope.captureIntoNotebook(ink),true);await ui.flush();ui.canvas.renderAll();
  assert.equal(oldRenders,0,'confirmation rebuilt the page after a safe append');
  assert.equal(ui.book().getPageObjects().length,101);assert.equal(ui.errors.length,0);
  assert.deepEqual(ui.book().notebookPages,authority.getSnapshot().canvas.objects[0].notebookPages);
  const undo=ui.history.at(-1).nextHistoryOps;
  await ui.scope.commitConditionalHistoryOps(undo,'undo-cache-stroke');await ui.flush();ui.canvas.renderAll();
  assert.equal(ui.book().getPageObjects().length,100);assert.ok(oldRenders<100,'undo must not repaint every old child');
  const undone=ui.canvas.getContext().getImageData(0,0,800,700).data;
  ui.book().dirty=true;ui.canvas.renderAll();
  assert.equal(Buffer.compare(Buffer.from(undone),Buffer.from(ui.canvas.getContext().getImageData(0,0,800,700).data)),0,'undo damage differs from full rendering');
  assert.equal(ui.errors.length,0);
 }finally{await ui.close();}
});

test('receiving one new interior stroke reuses cached geometry and keeps notebook identity',async()=>{
 const book=new BoardNotebook({boardObjectId:'book',left:20,top:20});
 for(let i=0;i<100;i++)book.addPageObject(new Path(`M -180 ${-150+i*3} L 80 ${-147+i*3}`,{boardObjectId:`old${i}`,stroke:'black',strokeWidth:2,fill:null}));
 const {authority}=await authorityFixture([serialized(book)]);book.dispose();
 const receiver=await createUiHarness({authority,clientId:'student'});
 const writer=await createUiHarness({authority,clientId:'teacher',deliver:result=>receiver.receive(result,'teacher')});
 try{
  writer.canvas.renderAll();receiver.canvas.renderAll();const original=receiver.book();let oldRenders=0;
  for(const child of original.getPageObjects()){const render=child.render;child.render=function(...args){oldRenders++;return render.apply(this,args);};}
  const ink=new Path('M 140 340 L 200 345',{stroke:'black',strokeWidth:3,fill:null,boardObjectId:'remote-source'});writer.canvas.add(ink);
  assert.equal(await writer.scope.captureIntoNotebook(ink),true);await writer.flush();receiver.canvas.renderAll();
  assert.strictEqual(receiver.book(),original);assert.equal(original.getPageObjects().length,101);
  assert.equal(oldRenders,0,'receiver repainted old geometry for one interior delta');
  assert.deepEqual(original.notebookPages,authority.getSnapshot().canvas.objects[0].notebookPages);
  const before=receiver.canvas.getContext().getImageData(0,0,800,700).data;
  original.dirty=true;receiver.canvas.renderAll();assert.deepEqual(before,receiver.canvas.getContext().getImageData(0,0,800,700).data);
  assert.equal(receiver.errors.length+writer.errors.length,0);
 }finally{await writer.close();await receiver.close();}
});
