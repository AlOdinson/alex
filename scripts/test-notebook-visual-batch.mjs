import test from 'node:test';
import assert from 'node:assert/strict';
const api=await import('../src/lib/notebookVisualBatch.js').catch(()=>({}));
const book=()=>({type:'BoardNotebook',boardObjectId:'n',notebookPageNumber:1,notebookPages:[[]],left:0});
const delta=id=>({type:'notebook',version:1,id:'n',pageNumber:1,changes:[{type:'insert',object:{type:'Rect',boardObjectId:id,left:0},ifAbsent:true}]});
const stage=(ops,lookup)=>{assert.equal(typeof api.stageNotebookVisualOperations,'function','missing sequential notebook projection staging');return api.stageNotebookVisualOperations(ops,lookup);};
test('multiple child operations produce one final projection without losing earlier changes',()=>{
 const original=book();const result=stage([delta('a'),delta('b')],()=>original);
 assert.equal(result.length,1);assert.equal(result[0].type,'upsert');assert.deepEqual(result[0].object.notebookPages[0].map(c=>c.boardObjectId),['a','b']);assert.equal(original.notebookPages[0].length,0);
});
test('frame patch and child update are staged sequentially and do not read hidden children',()=>{
 const original=book(),hidden=[Object.defineProperty({type:'Image',boardObjectId:'img'},'src',{enumerable:true,get(){throw Error('hidden image read');}})];original.notebookPages.push(hidden);
 const [result]=stage([{type:'patch',version:1,id:'n',patch:{left:9}},delta('ink')],()=>original);
 assert.equal(result.object.left,9);assert.equal(result.object.notebookPages[1],hidden);
});
test('delete and restore lifecycle is not confused with prior page deltas',()=>{
 const original=book(),replacement={...book(),left:30};
 const [result]=stage([delta('a'),{type:'delete',id:'n'},{type:'upsert',object:replacement,zIndex:2,restore:true,reorder:true},delta('b')],()=>original);
 assert.equal(result.object.left,30);assert.deepEqual(result.object.notebookPages[0].map(c=>c.boardObjectId),['b']);assert.equal(result.reorder,true);assert.equal(result.zIndex,2);
});
test('ordinary objects remain on legacy path; transforms split notebook from other targets',()=>{
 const outside={type:'patch',id:'outside',patch:{left:7}};
 const result=stage([outside,{type:'transform',objects:[{id:'n',transform:{left:5}},{id:'outside',transform:{top:4}}]}],id=>id==='n'?book():null);
 assert.equal(result[0],outside);assert.equal(result[1].type,'transform');assert.deepEqual(result[1].objects.map(o=>o.id),['outside']);assert.equal(result[2].object.left,5);
});
test('missing parent delta fails explicitly rather than dropping received ink',()=>{
 assert.throws(()=>stage([delta('a')],()=>null),/missing/i);
});

test('ordinary operation metadata cannot impersonate an internal projection marker',()=>{
 const op={type:'delete',id:'outside',notebookProjection:'forged'};
 assert.deepEqual(stage([op],()=>null),[op]);
});
