import test from 'node:test';
import assert from 'node:assert/strict';
import { getEnv } from 'fabric/node';
import { setEnv, Path, Rect } from 'fabric';
import { createBoardNotebook, captureNotebookObject } from '../src/lib/boardNotebook.js';
import { SPLIT_TOLERANCE, boxPath, mapPaths, booleanPaths, recordVectorPaints, paintPolygons } from '../src/lib/notebookSplitGeometry.js';
setEnv(getEnv());

const pageFor = book => mapPaths(boxPath(-book.width/2,-book.height/2,book.width,book.height), book.calcTransformMatrix());
const canonical = (source, book) => {
  const matrix = source.calcTransformMatrix();
  const tolerance = SPLIT_TOLERANCE / Math.max(Math.hypot(matrix[0],matrix[1]),Math.hypot(matrix[2],matrix[3]),1e-6);
  const page = pageFor(book), { paints } = recordVectorPaints(source,tolerance);
  const rows = paints.filter(p=>typeof p.color==='string').map(paint=>{
    const polygons=mapPaths(paintPolygons(paint,tolerance),matrix);
    return { color:paint.color, inside:booleanPaths(polygons,page), outside:booleanPaths(polygons,page,'difference') };
  });
  return { paints, matrix, tolerance, page, rows };
};

test('worker-safe vector split core matches the canonical polygon result', async () => {
  const core = await import('../src/lib/notebookSplitGeometryCore.js').catch(()=>null);
  assert.equal(typeof core?.splitVectorPaintsTask, 'function', 'worker-safe split core is missing');
  const book=createBoardNotebook({left:100,top:100,width:200,height:200});
  const source=new Path('M 20 150 C 90 10 260 360 380 150',{fill:null,stroke:'red',strokeWidth:9,strokeLineCap:'round',strokeLineJoin:'round'});
  try {
    const c=canonical(source,book);
    const result=core.splitVectorPaintsTask({paints:c.paints,page:c.page,matrix:c.matrix,tolerance:c.tolerance});
    assert.deepEqual(result,c.rows);
  } finally { await book.dispose(); source.dispose(); }
});

test('an unmasked crossing vector dispatches geometry through a worker', async () => {
  const OriginalWorker=globalThis.Worker; let created=0, posted=0;
  const core = await import('../src/lib/notebookSplitGeometryCore.js').catch(()=>null);
  class FakeWorker {
    constructor(){created++;}
    postMessage(message){posted++; queueMicrotask(()=>{
      try { this.onmessage?.({data:{id:message.id,result:core.splitVectorPaintsTask(message.payload)}}); }
      catch(error){ this.onmessage?.({data:{id:message.id,error:error.message}}); }
    });}
    terminate(){}
  }
  globalThis.Worker=FakeWorker;
  const book=createBoardNotebook({left:100,top:100,width:200,height:200});
  const source=new Path('M 20 150 L 380 150',{fill:null,stroke:'red',strokeWidth:8,strokeLineCap:'round'});
  try {
    const result=await captureNotebookObject(book,source);
    assert.ok(result?.split); assert.equal(created,1); assert.equal(posted,1);
    result.inside?.dispose(); result.outside?.dispose();
  } finally { globalThis.Worker=OriginalWorker; await book.dispose(); source.dispose(); }
});

test('masked vectors keep the canonical main-thread fallback until mask geometry is worker-safe', async () => {
  const OriginalWorker=globalThis.Worker; let created=0;
  class FakeWorker { constructor(){created++; throw new Error('masked vector must not create worker');} }
  globalThis.Worker=FakeWorker;
  const book=createBoardNotebook({left:100,top:100,width:200,height:200});
  const source=new Path('M 20 150 L 380 150',{fill:null,stroke:'red',strokeWidth:8,strokeLineCap:'round'});
  source.clipPath=new Rect({width:300,height:100,left:0,top:0,originX:'center',originY:'center'});
  try {
    const result=await captureNotebookObject(book,source);
    assert.ok(result); assert.equal(created,0);
    result.inside?.dispose(); result.outside?.dispose();
  } finally { globalThis.Worker=OriginalWorker; await book.dispose(); source.dispose(); }
});

test('raster alpha bounds can be resolved through a worker-owned bitmap', async () => {
  const client=await import('../src/lib/notebookSplitWorkerClient.js');
  assert.equal(typeof client.runNotebookRasterBounds,'function','raster worker helper is missing');
  let transferred=false,closed=false;
  const bitmap={width:4,height:3,close(){closed=true;}};
  class FakeWorker {
    postMessage(message,transfer){transferred=transfer?.[0]===bitmap;queueMicrotask(()=>this.onmessage?.({data:{id:1,result:{x0:1,y0:1,x1:2,y1:2}}}));}
    terminate(){}
  }
  const bounds=await client.runNotebookRasterBounds({width:4,height:3},{createBitmap:async()=>bitmap,workerFactory:()=>new FakeWorker()});
  assert.deepEqual(bounds,{x0:1,y0:1,x1:2,y1:2});assert.equal(transferred,true);assert.equal(closed,true);
});
