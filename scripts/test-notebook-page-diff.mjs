import test from 'node:test';
import assert from 'node:assert/strict';
import { notebookPageState, notebookPageChanges } from '../src/lib/notebookPageModel.js';
import { freezeNotebookRecord } from '../src/lib/notebookRecords.js';
const record=(id,left=0)=>freezeNotebookRecord({type:'Path',boardObjectId:id,left});
const model=length=>notebookPageState(freezeNotebookRecord([Array.from({length},(_,i)=>record(`id-${i}`))]),0);
test('related rotated AVL versions report only changed child identities and correct ranks',()=>{
 let current=model(1000);let seed=24;
 for(let i=0;i<240;i++){
  seed=(seed*1664525+1013904223)>>>0;const old=current;const index=seed%current.length,id=current.at(index).boardObjectId;
  current=i%3===0?current.delete(id):i%3===1?current.insert(record(`add-${i}`),index):current.patch(record(id,i));
  const changes=notebookPageChanges(old,current);assert.ok(changes);assert.equal(changes.length,1);
  for(const change of changes){const childId=change.after?.boardObjectId??change.before.boardObjectId;
   assert.equal(change.beforeIndex,old.rankOf(childId));assert.equal(change.index,current.rankOf(childId));assert.strictEqual(change.before,old.read(childId));assert.strictEqual(change.after,current.read(childId));}
 }
});
test('same identity removed then reinserted at another layer is retained as an explicit change',()=>{
 const before=model(100);const item=before.at(40),after=before.delete(item.boardObjectId).insert(item,2);
 const changes=notebookPageChanges(before,after);assert.equal(changes.length,1);assert.equal(changes[0].beforeIndex,40);assert.equal(changes[0].index,2);
});
test('unrelated imports and structural relabels never claim a cheap related delta',()=>{assert.equal(notebookPageChanges(model(10),model(10)),null);});
