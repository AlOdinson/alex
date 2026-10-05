import test from 'node:test';
import assert from 'node:assert/strict';
import {createIndexedBoardModel, indexedBoardModelFor, readSnapshotRecord, changedSnapshotObjectIds} from '../src/lib/indexedBoardModel.js';
const fixture=()=>({version:2,background:'blank',canvas:{width:800,objects:Array.from({length:5001},(_,i)=>({boardObjectId:`o${i}`,type:'Path',left:i,path:[['M',0,0],['L',1,2]]}))}});

test('persistent record replacement shares untouched data, preserves rank, and exports ordinary cloneable JSON',()=>{
 const original=fixture(),model=createIndexedBoardModel(original),snapshot=model.snapshot;
 let next=model;
 for(let i=0;i<200;i++){
  const id=`o${i*23%5001}`,old=next.read(id);
  next=next.replace([{...old,left:old.left+1}],{savedAt:`tick-${i}`});
 }
 assert.strictEqual(model.read('o5000'),next.read('o5000'));
 assert.strictEqual(readSnapshotRecord(next.snapshot,'o5000').object,model.read('o5000'));
 assert.equal(readSnapshotRecord(next.snapshot,'o5000').zIndex,5000);
 assert.equal(model.read('o0').left,0);assert.equal(next.read('o0').left,1);
 assert.equal(snapshot.canvas.objects.length,5001);assert.equal(next.snapshot.canvas.width,800);
 assert.ok(Array.isArray(structuredClone(next.snapshot).canvas.objects));
 assert.equal(JSON.parse(JSON.stringify(next.snapshot)).canvas.objects[0].left,1);
 assert.strictEqual(indexedBoardModelFor(snapshot),model);
 assert.equal(changedSnapshotObjectIds(model.snapshot,next.snapshot).size,200);
});

test('a no-op replacement preserves version; replacing identity or inserting requires an explicit structural path',()=>{
 const model=createIndexedBoardModel(fixture());
 assert.strictEqual(model.replace([model.read('o0')]),model);
 assert.throws(()=>model.replace([{boardObjectId:'new',type:'Path'}]),/structural/i);
 assert.equal(model.read('absent'),undefined);assert.equal(model.rankOf('absent'),-1);
 assert.deepEqual([...changedSnapshotObjectIds(model.snapshot,model.snapshot)],[]);
});

test('scope selection reads only addressed records, not a materialized full snapshot',()=>{
 let reads=0;
 const objects=Array.from({length:5001},(_,i)=>({get boardObjectId(){reads++;return `o${i}`;},type:'Path'}));
 const model=createIndexedBoardModel({version:2,background:'blank',canvas:{objects}});reads=0;
 const scope=model.scope(['o9','missing']);
 assert.equal(scope.canvas.objects.length,1);assert.equal(scope.canvas.objects[0],model.read('o9'));
 assert.equal(reads,0,'scope enumerated record identities again');
});

test('duplicate IDs and active selections cannot enter a fixed-order notebook shortcut',()=>{
 for(const objects of [[{boardObjectId:'same'},{boardObjectId:'same'}],[{boardObjectId:'a',type:'ActiveSelection'}]])
  assert.equal(createIndexedBoardModel({canvas:{objects}}).supportsStableOrder,false);
 const model=createIndexedBoardModel({canvas:{objects:[{boardObjectId:'__proto__',type:'Path'}]}});
 assert.equal(model.rankOf('__proto__'),0);
});

test('invalid ranks cannot alias an existing last record',()=>{
 const model=createIndexedBoardModel(fixture());
 for(const rank of [NaN,undefined,Infinity,-1,1.5,5001])assert.equal(model.at(rank),undefined);
});

test('legacy addressed reads preserve last-record precedence for duplicate IDs',()=>{
 const first={boardObjectId:'dup',left:1},last={boardObjectId:'dup',left:2};
 const snapshot={canvas:{objects:[first,last]}};
 assert.deepEqual(readSnapshotRecord(snapshot,'dup'),{object:last,zIndex:1});
});
