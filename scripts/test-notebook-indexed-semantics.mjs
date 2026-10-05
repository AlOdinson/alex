import test from 'node:test';
import assert from 'node:assert/strict';
import { createIndexedBoardModel } from '../src/lib/indexedBoardModel.js';
import { prepareIndexedNotebookAction, applyIndexedNotebookOps } from '../src/lib/notebookIndexedTransaction.js';
import { evaluateAuthorityAction } from '../src/lib/authorityOperationEvaluator.js';
import { prepareAuthoritativeHistory } from '../src/lib/historyOperations.js';
import { applyAuthorityOps } from '../src/lib/authoritySnapshot.js';
import { updateNotebookTombstones } from '../src/lib/notebookOperations.js';

const fixture=()=>({version:2,background:'blank',canvas:{objects:[
 {type:'Path',boardObjectId:'outside',left:12,path:[['M',0,0],['L',2,2]]},
 ...['one','two'].map(boardObjectId=>({type:'BoardNotebook',boardObjectId,notebookPageNumber:1,notebookPages:[[],[]]}))]}});
const child=id=>({type:'Path',boardObjectId:id,path:[['M',0,0],['L',3,2]]});
const op=(id,changes,extra={})=>({type:'notebook',version:1,id,pageNumber:1,changes,...extra});
function compare(snapshot,ops,extra={}){
 const model=createIndexedBoardModel(structuredClone(snapshot));
 const input={snapshot:model.snapshot,ops,notebookVersion:1,clientId:'teacher',actionId:'a',...extra};
 const expected=evaluateAuthorityAction({...input,snapshot});
 const scoped=prepareIndexedNotebookAction(input,{history:true});assert.ok(scoped,'expected fixed-order batch');
 assert.deepEqual(scoped.evaluation,expected);
 assert.deepEqual(scoped.history,prepareAuthoritativeHistory(snapshot,expected.appliedOps,expected.appliedBackground,input));
 const actual=applyIndexedNotebookOps(model.snapshot,expected.appliedOps,expected.appliedBackground);
 assert.deepEqual(structuredClone(actual),applyAuthorityOps(snapshot,expected.appliedOps,expected.appliedBackground));
 return actual;
}

test('scoped notebook preflight/history match full reducer for conditions, atomic rollback and absent source retirement',()=>{
 let snapshot=fixture();
 snapshot=compare(snapshot,[op('one',[{type:'insert',object:child('x'),ifAbsent:true}],{atomicGroup:'a',updatedAt:10}),{type:'delete',id:'source',mutationId:'m',atomicGroup:'a'}]);
 for(const ops of [
  [op('one',[{type:'patch',id:'x',patch:{left:9},ifFields:{left:99}}])],
  [op('one',[{type:'delete',id:'x',ifZIndex:99}])],
  [op('one',[{type:'insert',object:child('x'),ifAbsent:true}])],
  [op('missing',[{type:'insert',object:child('new')}])],
  [op('one',[{type:'insert',object:child('new')}],{pageNumber:999999})],
  [op('two',[{type:'insert',object:child('good')}],{atomicGroup:'both'}),op('one',[{type:'delete',id:'absent'}],{atomicGroup:'both'})],
  [op('one',[{type:'insert',object:child('tail'),zIndex:0},{type:'patch',id:'tail',patch:{left:20},ifFields:{type:'bad'}}])],
  [op('one',[{type:'delete',id:'x',ifObjectVersion:child('x')}])],
  [op('one',[{type:'insert',object:child('z')},{type:'delete',id:'z'}])],
 ])compare(snapshot,ops);
 compare(snapshot,[op('two',[{type:'insert',object:child('x'),ifDeletedBy:'teacher',ifDeletedMutationId:'m'}])],
 {notebookTombstones:{'["two",1,"x"]':{clientId:'teacher',mutationId:'m'},unrelated:{}}});
 compare(snapshot,[op('two',[{type:'insert',object:child('x')}])],{notebookVersion:0});
});

test('bounded deterministic operation sequences retain exact canonical contents and inverses',()=>{
 let plain=fixture(),indexed=createIndexedBoardModel(structuredClone(plain)).snapshot,tombstones={};
 let seed=97;const random=()=>((seed=Math.imul(seed,1664525)+1013904223>>>0)/4294967296);
 for(let i=0;i<150;i++){
  const book=random()<.5?'one':'two',id=`c${Math.floor(random()*20)}`,kind=Math.floor(random()*3);
  const change=kind===0?{type:'insert',object:child(id),ifAbsent:true}:kind===1?{type:'delete',id}:{type:'patch',id,patch:{left:i}};
  const ops=[op(book,[change],{updatedAt:i})];const context={clientId:'teacher',actionId:`a${i}`,revision:i+1};
  const expected=evaluateAuthorityAction({snapshot:plain,ops,notebookVersion:1,notebookTombstones:tombstones,...context});
  const next=prepareIndexedNotebookAction({snapshot:indexed,ops,notebookVersion:1,notebookTombstones:tombstones,...context},{history:true});
  assert.deepEqual(next.evaluation,expected);
  assert.deepEqual(next.history,prepareAuthoritativeHistory(plain,expected.appliedOps,expected.appliedBackground,context));
  plain=applyAuthorityOps(plain,expected.appliedOps,expected.appliedBackground);
  indexed=applyIndexedNotebookOps(indexed,expected.appliedOps,expected.appliedBackground);
  assert.deepEqual(structuredClone(indexed),plain,`step${i}`);
  tombstones=updateNotebookTombstones(tombstones,expected.appliedOps,context);
 }
});

test('existing source deletion, frame mutation and order changes retain the structural path',()=>{
 const snapshot=createIndexedBoardModel(fixture()).snapshot;
 for(const ops of [[{type:'delete',id:'outside'}],[{type:'upsert',object:child('new')}],
  [op('one',[{type:'insert',object:child('x')}]),{type:'delete',id:'outside'}],
  [{type:'patch',id:'one',patch:{left:10}}]]){
  assert.equal(prepareIndexedNotebookAction({snapshot,ops}),null);
  assert.equal(applyIndexedNotebookOps(snapshot,ops),null);
 }
});
