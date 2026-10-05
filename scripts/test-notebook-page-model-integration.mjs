import test from 'node:test';
import assert from 'node:assert/strict';
import { getEnv } from 'fabric/node';
import { setEnv, Path, StaticCanvas, util } from 'fabric';
import { BoardNotebook, applyPageDeltaToFabric } from '../src/lib/boardNotebook.js';
import { applyNotebookOperation } from '../src/lib/notebookOperations.js';
import { prepareNotebookProjection } from '../src/lib/notebookProjection.js';
import { freezeNotebookRecord } from '../src/lib/notebookRecords.js';
setEnv(getEnv());
const fields = ['boardObjectId','updatedAt','updatedBy'];
const record = id => new Path('M -40 -20 L 20 10', { boardObjectId: id, fill: null, stroke: 'black', strokeWidth: 2 }).toObject(fields);
const insert = id => ({ type:'notebook',version:1,id:'book',pageNumber:1,updatedAt:12,updatedBy:'writer',changes:[{type:'insert',object:record(id)}] });
async function fixture() {
  const book = await BoardNotebook.fromObject({ boardObjectId:'book',notebookPages:[Array.from({length:300},(_,i)=>record(`old-${i}`))] });
  const canvas = new StaticCanvas(null,{width:700,height:600,renderOnAddRemove:false});canvas.add(book);canvas.renderAll();
  return {book,canvas,close:()=>canvas.dispose()};
}
function spyExports(pages) {
  let reads=0;
  return {pages:new Proxy(pages,{get(target,key,receiver){if(key==='0')reads++;return Reflect.get(target,key,receiver);}}),reads:()=>reads};
}

test('projection installs an indexed tail append without asking for the complete page array',async()=>{
  const f=await fixture();
  try {
    const target={...f.book.toObject(fields)};applyNotebookOperation(target,insert('new'));
    freezeNotebookRecord(target);
    const spy=spyExports(target.notebookPages);target.notebookPages; // boundary already frozen
    const work=await prepareNotebookProjection(f.book,{...target,notebookPages:spy.pages});
    assert.equal(work.apply(),true);
    assert.equal(spy.reads(),0,'projection forced full page export');
    assert.equal(f.book._objects.length,301);
    assert.equal(f.book._objects.at(-1).boardObjectId,'new');
  }finally{await f.close();}
});

test('direct prepared local append accepts the indexed page without exporting retained records',async()=>{
  const f=await fixture();
  try {
    const target={...f.book.toObject(fields)};const operation=insert('new');applyNotebookOperation(target,operation);
    const object=(await util.enlivenObjects([operation.changes[0].object]))[0];
    const spy=spyExports(target.notebookPages);
    assert.equal(f.book.appendPreparedPageObject(object,spy.pages),true);
    assert.equal(spy.reads(),0,'local append forced full page export');
  }finally{await f.close();}
});

test('incoming append does not freeze/materialize a new full child array before installation',async()=>{
  const f=await fixture();const original=Object.freeze;let fullPages=0;
  Object.freeze=function(value){if(Array.isArray(value)&&value.length===301&&value[0]?.boardObjectId==='old-0')fullPages++;return original(value);};
  try {
    assert.equal((await applyPageDeltaToFabric(f.book,insert('incoming'))).changed,true);
    assert.equal(fullPages,0,'incoming pipeline materialized full page records');
    assert.equal(f.book._objects.at(-1).boardObjectId,'incoming');
  }finally{Object.freeze=original;await f.close();}
});

test('real local capture and confirmation do not materialize equivalent preview/confirmed page versions',async()=>{
  const {authorityFixture,createUiHarness,serialized}=await import('./notebook-ui-node-harness.mjs');
  const {readSnapshotRecord}=await import('../src/lib/indexedBoardModel.js');
  const original=new BoardNotebook({boardObjectId:'book',left:20,top:20});
  for(let i=0;i<300;i++)original.addPageObject(new Path(`M -180 ${-150+i} L 80 ${-147+i}`,{boardObjectId:`old-${i}`,stroke:'black',strokeWidth:2,fill:null}));
  const {authority}=await authorityFixture([serialized(original)]);original.dispose();
  const ui=await createUiHarness({authority}),book=ui.book();
  const alignment=await prepareNotebookProjection(book,readSnapshotRecord(ui.scope.notebookControllerRef.current.getState().snapshot,'book').object);alignment.apply();ui.canvas.renderAll();
  let full=0;const freeze=Object.freeze;
  Object.freeze=function(value){if(Array.isArray(value)&&value.length===301&&value[0]?.boardObjectId==='old-0')full++;return freeze(value);};
  try {
    const ink=new Path('M 140 340 L 200 345',{boardObjectId:'source',stroke:'black',strokeWidth:3,fill:null});ui.canvas.add(ink);
    assert.equal(await ui.scope.captureIntoNotebook(ink),true);await ui.flush();
    assert.equal(full,0,'preview/confirmation forced full child-array exports');
    assert.equal(ui.errors.length,0);assert.equal(book._objects.length,301);
    assert.deepEqual(book.serializeNotebookForSnapshot().notebookPages,authority.getSnapshot().canvas.objects[0].notebookPages);
  }finally{Object.freeze=freeze;await ui.close();}
});
