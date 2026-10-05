import test from 'node:test';
import assert from 'node:assert/strict';
import { Canvas, Path, Rect, Point, util, Shadow, Textbox } from 'fabric';
import { BoardNotebook } from '../src/lib/boardNotebook.js';
import * as childIndex from '../src/lib/notebookChildIndex.js';
import { notebookPageState } from '../src/lib/notebookPageModel.js';
import { applyNotebookOperation } from '../src/lib/notebookOperations.js';
import { prepareNotebookProjection } from '../src/lib/notebookProjection.js';
import { boardFunction, fields } from './notebook-ui-node-harness.mjs';

const record = (id, left=0, top=0, extra={}) => new Rect({boardObjectId:id,left,top,width:18,height:18,
  originX:'center',originY:'center',strokeWidth:0,fill:'#123',...extra}).toObject(fields);
async function fixture(records, options={}) {
  const book=await BoardNotebook.fromObject({boardObjectId:'book',left:25,top:30,...options,notebookPages:[records]});
  const canvas=new Canvas(null,{width:800,height:700,renderOnAddRemove:false,enableRetinaScaling:false});
  canvas.add(book);canvas.renderAll();notebookPageState(book.notebookPages,0);
  const entries=new Map(), pointer={current:null};
  const scope={canvas,Point,objectEraserPointerRef:pointer,notebookEraserEntries:entries,
    isBoardNotebook:object=>object===book,preciseObjectEraserTarget:()=>book,objectEraserCandidatesNear:()=>[],
    notebookEraserCandidates:childIndex.notebookEraserCandidates,
    scenePointFromClient:(x,y)=>util.transformPoint(new Point(x,y),util.invertTransform(canvas.viewportTransform))};
  const erase=boardFunction('eraseAtClientPoint',scope);
  const localPoint=(x,y)=>util.transformPoint(new Point(x,y),book.calcTransformMatrix());
  const viewport=point=>util.transformPoint(point,canvas.viewportTransform);
  const expected=point=>{
    const p=viewport(point);
    return [...book.getPageObjects()].reverse().find(object=>!object.isEraserPath&&object.containsPoint(point)
      &&!canvas.isTargetTransparent(object,p.x,p.y))?.boardObjectId;
  };
  const hit=point=>{entries.clear();pointer.current=null;const p=viewport(point);erase(p.x,p.y);return [...(entries.get('book')?.childIds??[])][0];};
  return {book,canvas,scope,entries,pointer,erase,localPoint,viewport,expected,hit,close:()=>canvas.dispose()};
}
async function project(f,changes){const target={...f.book.toObject(fields)};
  applyNotebookOperation(target,{type:'notebook',version:1,id:'book',pageNumber:1,updatedAt:12,updatedBy:'writer',changes});
  const work=await prepareNotebookProjection(f.book,target);assert.equal(work.apply(),true);return target;}

test('actual Board eraser avoids page enumeration and distant exact tests with 5000 children',async t=>{
  const f=await fixture([record('hit'),...Array.from({length:5000},(_,i)=>record(`far-${i}`,-180,-180))]);
  try{
    const point=f.localPoint(0,0);assert.equal(f.expected(point),'hit');
    let copies=0,checks=0;
    const get=f.book.getPageObjects;f.book.getPageObjects=function(){copies++;return get.call(this);};
    for(const child of f.book._objects){const contains=child.containsPoint;child.containsPoint=function(p){checks++;return contains.call(this,p);};}
    assert.equal(f.expected(point),'hit');const before={checks,copies};checks=copies=0;
    assert.equal(f.hit(point),'hit');
    t.diagnostic(JSON.stringify({before,after:{checks,copies}}));
    assert.equal(copies,0,'pointer hit test enumerated the full notebook page');
    assert.ok(checks<=2,`checked ${checks} children instead of nearby candidates`);
  }finally{await f.close();}
});

test('transparent bounding-box interior and eraser paths do not hide the lower ink target',async()=>{
  const ring=new Rect({boardObjectId:'ring',left:0,top:0,originX:'center',originY:'center',width:100,height:100,stroke:'red',strokeWidth:3,fill:null}).toObject(fields);
  const eraser=record('erase',0,0,{isEraserPath:true,globalCompositeOperation:'destination-out'});
  const f=await fixture([record('bottom'),ring,eraser]);
  try{assert.equal(f.expected(f.localPoint(0,0)),'bottom');assert.equal(f.hit(f.localPoint(0,0)),'bottom');
    assert.equal(f.hit(f.localPoint(130,100)),undefined);
  }finally{await f.close();}
});

test('candidate layer order follows canonical page changes before the next full render',async()=>{
  const f=await fixture([record('bottom'),record('top')]);
  try{
    assert.equal(f.hit(f.localPoint(0,0)),'top');
    await project(f,[{type:'delete',id:'top'}]);assert.equal(f.hit(f.localPoint(0,0)),'bottom');
    await project(f,[{type:'insert',zIndex:0,object:record('under')}]);assert.equal(f.hit(f.localPoint(0,0)),'bottom');
    await project(f,[{type:'patch',id:'bottom',patch:{left:90}}]);
    assert.equal(f.hit(f.localPoint(0,0)),'under');assert.equal(f.hit(f.localPoint(90,0)),'bottom');
  }finally{await f.close();}
});

test('book transforms, viewport zoom and pixel tolerance preserve the old hit predicate',async()=>{
  const f=await fixture([record('hit',25,12,{strokeUniform:true,stroke:'blue',strokeWidth:3}),record('other',-130,80)]);
  try{
    for(const frame of [
      {left:50,top:30,scaleX:.61,scaleY:.61,angle:0},
      {left:90,top:60,scaleX:.84,scaleY:1.13,angle:31,skewX:12},
      {left:180,top:50,scaleX:1.1,scaleY:.7,angle:-20,flipX:true,skewX:-7},
    ]){
      f.book.set(frame);f.book.setCoords();f.book.dirty=true;f.canvas.renderAll();
      for(const zoom of [.57,1,1.73]){f.canvas.setViewportTransform([zoom,0,0,zoom,11,-7]);f.canvas.setTargetFindTolerance(3);
        for(const [x,y] of [[25,12],[31,18],[35,12],[-130,80],[160,120]]){
          const point=f.localPoint(x,y);assert.equal(f.hit(point),f.expected(point),JSON.stringify({frame,zoom,x,y}));
        }
      }
    }
  }finally{await f.close();}
});

test('dirty, missing and same-length replaced pages use a safe live fallback',async()=>{
  const f=await fixture([record('old',-100,0)]);
  try{
    f.book.replacePageObjects([new Rect({boardObjectId:'new',left:100,top:0,width:20,height:20,originX:'center',originY:'center',fill:'black'})]);
    assert.equal(f.hit(f.localPoint(100,0)),f.expected(f.localPoint(100,0)));
    assert.equal(f.hit(f.localPoint(-100,0)),undefined);
    f.canvas.renderAll();childIndex.forgetNotebookChildIndex(f.book);
    assert.equal(f.hit(f.localPoint(100,0)),'new');
  }finally{await f.close();}
});

test('unknown rich-text and shadow footprints remain searchable in the global candidate set',async()=>{
  const text=new Textbox('X',{boardObjectId:'styled',left:-100,top:0,width:50,fontSize:24,styles:{0:{0:{stroke:'red',strokeWidth:20}}}}).toObject(fields);
  const f=await fixture([record('shadow',80,0,{shadow:new Shadow({color:'red',blur:3,offsetX:4})}),text]);
  try{for(const child of f.book._objects){const p=child.getCenterPoint();assert.equal(f.hit(p),f.expected(p));}}
  finally{await f.close();}
});

test('prepared-page eraser uses addressed deletion and preserves exact pixels and undo',async t=>{
  const {authorityFixture,createUiHarness}=await import('./notebook-ui-node-harness.mjs');
  const records=[record('hit'),...Array.from({length:350},(_,i)=>record(`far-${i}`,-190+(i%10)*5,-175+Math.floor(i/10)*5))];
  const initial=new BoardNotebook({boardObjectId:'book',left:25,top:30,notebookPages:[records]});
  const {authority}=await authorityFixture([initial.toObject(fields)]);initial.dispose();
  const ui=await createUiHarness({authority});
  try{
    // First edit adopts the imported page into the controller's owned family.
    // Cost assertions concern subsequent edits, not cold import/index construction.
    await ui.scope.eraseNotebookChildren([{id:'book',page:1,childIds:new Set(['far-349'])}]);await ui.flush();
    ui.canvas.renderAll();const book=ui.book(),objects=book._objects,retained=objects[1];
    let scans=0,renders=0;const get=book.getPageObjects;
    book.getPageObjects=function(){scans++;return get.call(this);};
    for(const child of objects.slice(1)){const render=child.render;child.render=function(ctx){renders++;return render.call(this,ctx);};}
    assert.equal(await ui.scope.eraseNotebookChildren([{id:'book',page:1,childIds:new Set(['hit'])}]),true);
    await ui.flush();ui.canvas.renderAll();
    t.diagnostic(JSON.stringify({releasePageReads:scans,retainedRenders:renders}));
    assert.equal(scans,0,`erase release copied or traversed the visible page ${scans} times`);
    assert.equal(renders,0,'erase release redrew distant retained children');
    assert.equal(ui.book()._objects.some(o=>o.boardObjectId==='hit'),false);
    assert.strictEqual(ui.book()._objects[0],retained);
    assert.deepEqual(ui.book().notebookPages,authority.getSnapshot().canvas.objects[0].notebookPages);
    const bitmap=ui.canvas.getContext().getImageData(0,0,800,700).data;
    book.dirty=true;ui.canvas.renderAll();
    assert.equal(Buffer.compare(Buffer.from(bitmap),Buffer.from(ui.canvas.getContext().getImageData(0,0,800,700).data)),0);
    await ui.scope.commitConditionalHistoryOps(ui.history.at(-1).nextHistoryOps,'undo-indexed-erase');await ui.flush();
    assert.equal(ui.book()._objects[0].boardObjectId,'hit');
    assert.deepEqual(ui.book().notebookPages,authority.getSnapshot().canvas.objects[0].notebookPages);
    assert.equal(ui.errors.length,0);
  }finally{await ui.close();}
});

test('actual erase gesture batches repeated hits once and keeps a single conditional history action',async()=>{
  const {authorityFixture,createUiHarness}=await import('./notebook-ui-node-harness.mjs');
  const initial=new BoardNotebook({boardObjectId:'book',left:25,top:30,notebookPages:[[record('a',-70,0),record('b',70,0)]]});
  const {authority}=await authorityFixture([initial.toObject(fields)]);initial.dispose();
  const ui=await createUiHarness({authority});
  try{
    ui.canvas.renderAll();const book=ui.book(),entries=new Map();let committed;
    const scope={...ui.scope,Point,notebookEraserCandidates:childIndex.notebookEraserCandidates,
      notebookEraserEntries:entries,objectEraserPointerRef:{current:{active:true}},erasingRef:{current:true},
      objectEraserRenderFrameRef:{current:null},objectEraserRecordsRef:{current:new Map()},
      flushObjectEraserVisualPatches(){},restoreObjectEraserRenderMode(){},
      preciseObjectEraserTarget:()=>book,objectEraserCandidatesNear:()=>[],
      scenePointFromClient:(x,y)=>new Point(x,y),
      notebookHandlersRef:{current:{erase:es=>{committed=ui.scope.eraseNotebookChildren(es);}}}};
    const erase=boardFunction('eraseAtClientPoint',scope),finish=boardFunction('finishObjectEraser',scope);
    for(const x of [-70,-65,70]){const p=util.transformPoint(new Point(x,0),book.calcTransformMatrix());erase(p.x,p.y);}
    assert.deepEqual([...entries.get('book').childIds],['a','b']);
    assert.equal(book._objects.length,2,'hit testing removed ink before the gesture was committed');
    finish();await committed;await ui.flush();
    assert.equal(entries.size,0);assert.equal(book._objects.length,0);assert.equal(ui.history.length,1);
    await ui.scope.commitConditionalHistoryOps(ui.history[0].nextHistoryOps,'undo-two-erasures');await ui.flush();
    assert.deepEqual(book._objects.map(o=>o.boardObjectId),['a','b']);assert.equal(ui.errors.length,0);
  }finally{await ui.close();}
});

test('a refused erase enqueue leaves all live children and history unchanged',async()=>{
  const{authorityFixture,createUiHarness}=await import('./notebook-ui-node-harness.mjs');
  const initial=new BoardNotebook({boardObjectId:'book',notebookPages:[[record('a')]]});
  const{authority}=await authorityFixture([initial.toObject(fields)]);initial.dispose();const ui=await createUiHarness({authority});
  try{const book=ui.book(),before=book._objects[0];const controller=ui.scope.notebookControllerRef.current;
    const enqueue=controller.enqueue;controller.enqueue=()=>{throw Error('outbox full');};
    await assert.rejects(ui.scope.incrementalNotebookActions.erase([{id:'book',page:1,childIds:new Set(['a'])}]),/outbox full/);
    controller.enqueue=enqueue;assert.strictEqual(book._objects[0],before);assert.equal(ui.history.length,0);
  }finally{await ui.close();}
});

test('an unchanged canonical enqueue result cannot visually remove a guarded child',async()=>{
  const{authorityFixture,createUiHarness}=await import('./notebook-ui-node-harness.mjs');
  const initial=new BoardNotebook({boardObjectId:'book',notebookPages:[[record('a')]]});
  const{authority}=await authorityFixture([initial.toObject(fields)]);initial.dispose();const ui=await createUiHarness({authority});
  try{const book=ui.book(),before=book._objects[0],controller=ui.scope.notebookControllerRef.current;
    const enqueue=controller.enqueue;controller.enqueue=()=>({actionId:'guarded-noop',inverseOps:[],settled:Promise.resolve({changed:false})});
    assert.equal(await ui.scope.incrementalNotebookActions.erase([{id:'book',page:1,childIds:new Set(['a'])}]),true);
    controller.enqueue=enqueue;assert.strictEqual(book._objects[0],before);assert.equal(book._objects.length,1);
  }finally{await ui.close();}
});

test('erase entries from an old page do not delete a child from the current page',async()=>{
  const{authorityFixture,createUiHarness}=await import('./notebook-ui-node-harness.mjs');
  const initial=new BoardNotebook({boardObjectId:'book',notebookPages:[[record('a')],[record('b')]],notebookPageNumber:2});
  const{authority}=await authorityFixture([initial.toObject(fields)]);initial.dispose();const ui=await createUiHarness({authority});
  try{assert.equal(await ui.scope.incrementalNotebookActions.erase([{id:'book',page:1,childIds:new Set(['b'])}]),false);
    assert.equal(ui.book()._objects[0].boardObjectId,'b');assert.equal(ui.history.length,0);
  }finally{await ui.close();}
});

test('densely overlapping candidates retain the cheap legacy order instead of ranking every child',async()=>{
  const f=await fixture(Array.from({length:1000},(_,i)=>record(`overlap-${i}`)));
  try{
    let idReads=0;
    for(const child of f.book._objects){const id=child.boardObjectId;
      Object.defineProperty(child,'boardObjectId',{configurable:true,get(){idReads++;return id;}});}
    assert.equal(f.hit(f.localPoint(0,0)),'overlap-999');
    assert.ok(idReads<32,`dense hit performed ${idReads} addressed rank lookups instead of safe fallback`);
  }finally{await f.close();}
});

test('a legacy numeric child identity falls back instead of silently losing the erase gesture',async()=>{
  const {createNotebookBoardActions}=await import('../src/lib/notebookBoardActions.js');
  const f=await fixture([record(17),record('keep',90,0)]);let queued;
  const controller={enqueue(input){queued=input;return{actionId:input.actionId,inverseOps:[],settled:Promise.resolve()};},pendingObjectIds:()=>new Set()};
  const actions=createNotebookBoardActions({getCanvas:()=>f.canvas,getController:async()=>controller,clientId:'writer',
    acquireLease:async()=>true,ownsLease:()=>true,releaseLease:()=>{},recordAction:()=>{}});
  try{assert.equal(await actions.erase([{id:'book',page:1,childIds:new Set([17])}]),true);
    assert.equal(queued.ops[0].changes[0].id,'17');assert.deepEqual(f.book._objects.map(o=>o.boardObjectId),['keep']);
  }finally{await f.close();}
});
