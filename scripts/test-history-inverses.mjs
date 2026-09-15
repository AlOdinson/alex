import assert from 'node:assert/strict';
import test from 'node:test';
import { openBrowserBoardAuthority } from '../src/lib/browserBoardAuthority.js';
import { createInitialHistoryOps, refreshHistoryOps } from '../src/lib/historyOperations.js';
import { createConditionalDeleteOps } from '../src/lib/operationProtocol.js';
import { createHistoryCommandQueue } from '../src/lib/historyCommandQueue.js';

async function fixture(objects = []) {
  const outcomes = new Map();
  const service = await openBrowserBoardAuthority({
    boardId: 'unit-history',
    loadBoard: async () => ({ revision: 0, snapshotRevision: 0, snapshot: { version: 2, background: 'grid', canvas: { objects } } }),
    loadCommitsAfter: async () => [], loadActionOutcome: async (_id, id) => outcomes.get(id),
    persistCommit: async (_id, commit) => { outcomes.set(commit.actionId, structuredClone(commit)); return { commit, duplicate: false }; },
    persistNoopOutcome: async (_id, result) => { outcomes.set(result.actionId, structuredClone(result)); return { result, duplicate: false }; },
  });
  let counter = 0;
  return { service, commit: (ops, clientId = 'teacher', actionId = `action-${++counter}`) => service.commitAction({
    actionId, clientId, ops, baseRevision: service.getRevision(),
  }) };
}
const clean = (value) => JSON.parse(JSON.stringify(value, (key, item) => ['updatedAt', 'updatedBy'].includes(key) ? undefined : item));
for (const author of ['teacher-computer', 'student-phone', 'student-tablet']) {
  test(`${author}: add/color/move/delete survives ten complete undo/redo cycles`, async () => {
    const f = await fixture();
    const undo = [], redo = [];
    let generation = 0;
    const stack = (entry) => { undo.push(entry); redo.length = 0; generation++; };
    const object = { type: 'Rect', boardObjectId: 'shape', left: 10, top: 20, fill: '#111111', scaleX: 1, scaleY: 1, angle: 0 };
    const rec = () => f.service.getSnapshot().canvas.objects.map((object, zIndex) => ({ object, zIndex }));
    await f.commit([{ type: 'upsert', object, zIndex: 0 }], author);
    stack({ type: 'add', records: rec() });
    const before = rec();
    await f.commit([{ type: 'patch', id: 'shape', patch: { fill: '#ff0000' } }], author);
    stack({ type: 'modify', before, after: rec() });
    const beforeRecords = rec();
    await f.commit([{ type: 'transform', version: 1, objects: [{ id: 'shape', transform: { left: 62, top: -11, angle: 90, scaleX: 2, scaleY: 0.5 } }] }], author);
    stack({ type: 'transform', beforeRecords, afterRecords: rec() });
    const saved = rec();
    await f.commit([{ type: 'delete', id: 'shape', mutationId: 'original-delete' }], author);
    stack({ type: 'delete', records: saved, deletionMutationIds: { shape: 'original-delete' } });
    const queue = createHistoryCommandQueue({ getUndo: () => undo, getRedo: () => redo, getGeneration: () => generation,
      execute: async (action, direction) => {
        const result = await f.commit(refreshHistoryOps(createInitialHistoryOps(action, direction, author), author), author);
        action.nextHistoryOps = result.historyInverseOps;
        return result;
      }, onError: (error) => assert.fail(error.message),
    });
    for (let cycle=0; cycle<10; cycle++) {
      for(let i=0;i<4;i++) assert.equal((await queue.enqueue('undo')).changed, true);
      assert.deepEqual(f.service.getSnapshot().canvas.objects, []);
      assert.equal(undo.length, 0); assert.equal(redo.length, 4);
      for(let i=0;i<4;i++) assert.equal((await queue.enqueue('redo')).changed, true);
      assert.deepEqual(f.service.getSnapshot().canvas.objects, []);
      assert.equal(undo.length, 4); assert.equal(redo.length, 0);
    }
    queue.close();
  });
}
test('a duplicate acknowledged request returns its original inverse without committing twice', async () => {
  const object = { type: 'Rect', boardObjectId: 'x', fill: 'red' };
  const f = await fixture([object]);
  const ops = createConditionalDeleteOps([{ object, zIndex: 0 }]);
  const first = await f.commit(ops, 'student', 'retained-id');
  await f.commit([{ type: 'upsert', object: { boardObjectId: 'other' } }], 'teacher');
  const duplicate = await f.commit(ops, 'student', 'retained-id');
  assert.equal(duplicate.duplicate, true);
  assert.deepEqual(duplicate.historyInverseOps, first.historyInverseOps);
  assert.equal(f.service.getRevision(), 2);
});
test('restoration cannot resurrect an object deleted again by the same participant', async () => {
  const object = { type: 'Rect', boardObjectId: 'x' };
  const f = await fixture([object]);
  const removed = await f.commit(createConditionalDeleteOps([{ object, zIndex: 0 }]));
  await f.commit([{ type: 'upsert', object, restore: true }]);
  await f.commit([{ type: 'delete', id: 'x', mutationId: 'new-delete' }]);
  const stale = await f.commit(removed.historyInverseOps);
  assert.equal(stale.changed, false);
  assert.deepEqual(f.service.getSnapshot().canvas.objects, []);
});
test('background undo is conditional and its redo also preserves another participant background', async () => {
  const f = await fixture();
  const undo = await f.commit([{ type: 'background', background: 'dots', ifBackground: 'grid' }]);
  assert.equal(f.service.getSnapshot().background, 'dots');
  const redo = await f.commit(undo.historyInverseOps);
  assert.equal(f.service.getSnapshot().background, 'grid');
  await f.commit([{ type: 'background', background: 'blank', ifBackground: 'grid' }], 'student');
  const conflict = await f.commit(redo.historyInverseOps);
  assert.equal(conflict.changed, false);
  assert.equal(f.service.getSnapshot().background, 'blank');
});
test('restoring a deleted selection into a shortened board normalizes layer positions', async () => {
  const objects = ['a','b','c','d'].map((boardObjectId) => ({ type: 'Rect', boardObjectId }));
  const f = await fixture(objects);
  const deleted = await f.commit(createConditionalDeleteOps(objects.slice(2).map((object,i)=>({object,zIndex:i+2}))));
  await f.commit([{type:'delete',id:'a'},{type:'delete',id:'b'}], 'student');
  const restored = await f.commit(deleted.historyInverseOps);
  assert.deepEqual(restored.appliedOps.map((op)=>op.zIndex), [0,1]);
  assert.deepEqual(clean(f.service.getSnapshot().canvas.objects), objects.slice(2));
  const removed = await f.commit(restored.historyInverseOps);
  assert.equal(removed.changed, true);
  assert.deepEqual(f.service.getSnapshot().canvas.objects, []);
});
test('a wholly conflicting history entry is skipped without manufacturing redo', async () => {
  const undo = [{id:'old'}, {id:'conflict'}], redo=[];
  const called=[];
  const queue=createHistoryCommandQueue({getUndo:()=>undo,getRedo:()=>redo,execute:async(action)=>{
    called.push(action.id);return {changed:action.id!=='conflict'};
  }});
  await queue.enqueue('undo');
  assert.deepEqual(called,['conflict','old']);
  assert.deepEqual(undo,[]);assert.deepEqual(redo,[{id:'old'}]);
  queue.close();
});
test('opposite rapid commands preserve order and source entries until confirmed', async () => {
  const undo=[{id:'one'}],redo=[];
  let release;const gate=new Promise((r)=>{release=r;});
  const called=[];
  const queue=createHistoryCommandQueue({getUndo:()=>undo,getRedo:()=>redo,execute:async(action,direction)=>{
    called.push(direction);await gate;return {changed:true};
  }});
  const pending=[queue.enqueue('undo'),queue.enqueue('redo'),queue.enqueue('undo')];
  assert.equal(undo.length,1);assert.equal(redo.length,0);
  release();await Promise.all(pending);
  assert.deepEqual(called,['undo','redo','undo']);assert.equal(redo.length,1);assert.equal(undo.length,0);
  queue.close();
});
