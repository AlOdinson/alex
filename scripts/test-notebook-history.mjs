import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateAuthorityAction } from '../src/lib/authorityOperationEvaluator.js';
import { prepareAuthoritativeHistory } from '../src/lib/historyOperations.js';
const snapshot = { canvas: { objects: [{boardObjectId:'book', notebookPages:[['new']]}, {boardObjectId:'fragment',left:5}] } };
const ops = [
  {type:'patch',id:'book',patch:{notebookPages:[[]]},ifFields:{notebookPages:[['new']]},atomicGroup:'split'},
  {type:'delete',id:'fragment',ifObjectVersion:{left:5},atomicGroup:'split'},
];
test('split undo rejects every fragment when notebook content has changed', () => {
  const changed = structuredClone(snapshot);
  changed.canvas.objects[0].notebookPages = [['someone else']];
  const result = evaluateAuthorityAction({snapshot:changed,ops});
  assert.equal(result.changed,false);
  assert.deepEqual(result.appliedOps,[]);
});
test('split undo rejects parent mutation when outside fragment has changed', () => {
  const changed = structuredClone(snapshot); changed.canvas.objects[1].left=7;
  assert.equal(evaluateAuthorityAction({snapshot:changed,ops}).changed,false);
});
test('accepted split inverse keeps its all-or-nothing guard for redo', () => {
  const result = evaluateAuthorityAction({snapshot,ops});
  assert.equal(result.appliedOps.length,2);
  const history = prepareAuthoritativeHistory(snapshot,result.appliedOps,null,{clientId:'teacher',actionId:'a'});
  assert.ok(history.historyInverseOps.every(op=>op.atomicGroup==='split'));
});

test('creating a blank page does not serialize old children into its inverse',()=>{
 const hidden=Object.defineProperty({type:'Image',boardObjectId:'large'},'src',{enumerable:true,get(){throw Error('hidden page serialization');}});
 const notebook={type:'BoardNotebook',boardObjectId:'book',notebookPageNumber:1,notebookPages:[[hidden]]};
 const history=prepareAuthoritativeHistory({canvas:{objects:[notebook]}},[{type:'patch',id:'book',patch:{notebookPageNumber:2},updatedAt:5}],null,{clientId:'teacher',actionId:'page'});
 assert.equal(history.historyInverseOps[0].patch.notebookPageNumber,1);assert.ok(!JSON.stringify(history.historyInverseOps).includes('notebookPages'));
});
