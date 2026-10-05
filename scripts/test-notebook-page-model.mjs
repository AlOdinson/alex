import test from 'node:test';
import assert from 'node:assert/strict';
import { applyNotebookOperation, evaluateNotebookOperation, invertNotebookOperation, updateNotebookTombstones } from '../src/lib/notebookOperations.js';
import { freezeNotebookRecord, isImmutableNotebookRecord } from '../src/lib/notebookRecords.js';
import { notebookPageAppend } from '../src/lib/notebookPageDelta.js';

const child = (id, x = 0) => ({ type: 'Path', boardObjectId: id, left: x, path: [['M', 0, 0], ['L', 10, 5]], stroke: '#123456', updatedAt: 1, updatedBy: 'teacher' });
const book = pages => ({ type: 'BoardNotebook', boardObjectId: 'book', notebookPages: pages, notebookPageNumber: 1 });
const op = (changes, time = 2) => ({ type: 'notebook', version: 1, id: 'book', pageNumber: 1, updatedAt: time, updatedBy: 'teacher', changes });
const ctx = { clientId: 'teacher', actionId: 'action', mutationId: 'action', revision: 1 };
function observedPage(count = 5000) {
  let reads = 0;
  const page = [];
  for (let i = 0; i < count; i++) {
    const record = child(`old-${i}`, i);
    Object.defineProperty(page, i, { enumerable: true, configurable: true, get() { reads++; return record; } });
  }
  const notebook = book(freezeNotebookRecord([page]));
  // Initial owned-page indexing is a load cost, not per-edit work.
  evaluateNotebookOperation(notebook, op([{ type: 'insert', object: child('old-0') }]));
  reads = 0;
  return { notebook, reads: () => reads, reset: () => { reads = 0; } };
}
for (const change of [
  { type: 'insert', object: child('new'), zIndex: 5000 },
  { type: 'patch', id: 'old-2500', patch: { left: -50 } },
  { type: 'delete', id: 'old-2500' },
]) {
  test(`${change.type}: evaluating a warm owned page does not enumerate its retained children`, () => {
    const s = observedPage();
    const result = evaluateNotebookOperation(s.notebook, op([change]), {}, ctx);
    assert.equal(result.changed, true);
    assert.deepEqual(result.skippedConflicts, []);
    assert.ok(s.reads() < 32, `retained page reads: ${s.reads()}`);
  });
  test(`${change.type}: apply and inverse avoid copying/indexing a warm retained page`, () => {
    const s = observedPage(); const before = { ...s.notebook };
    const result = applyNotebookOperation(s.notebook, op([change]));
    assert.equal(result.changed, true);
    const inverse = invertNotebookOperation(before, op([change]), { ...ctx, afterState: s.notebook });
    assert.equal(inverse.length, 1);
    assert.ok(s.reads() < 32, `retained page reads: ${s.reads()}`);
    const expected = change.type === 'insert' ? 5001 : change.type === 'delete' ? 4999 : 5000;
    assert.equal(s.notebook.notebookPages[0].length, expected);
    assert.equal(before.notebookPages[0].length, 5000);
  });
}

test('serialized/checkpoint pages remain plain deeply frozen arrays and exports are independent', () => {
  const before = book(freezeNotebookRecord([[child('a')], [child('hidden')]]));
  const next = { ...before }; const action = op([{ type: 'insert', object: child('b'), zIndex: 1 }]);
  applyNotebookOperation(next, action);
  action.changes[0].object.path[0][1] = 999;
  freezeNotebookRecord(next);
  assert.ok(Array.isArray(next.notebookPages));
  assert.ok(Array.isArray(next.notebookPages[0]));
  assert.ok(isImmutableNotebookRecord(next.notebookPages[0]));
  assert.equal(next.notebookPages[1], before.notebookPages[1]);
  const json = JSON.parse(JSON.stringify(next)), copied = structuredClone(next);
  assert.deepEqual(copied, json);
  copied.notebookPages[0][1].path[0][1] = 30;
  assert.equal(next.notebookPages[0][1].path[0][1], 0);
  assert.equal(before.notebookPages[0].length, 1);
  assert.equal(notebookPageAppend(before.notebookPages[0], next.notebookPages[0])?.record.boardObjectId, 'b');
});

test('plain or only shallowly frozen caller pages are not trusted across external mutation', () => {
  const record = child('a'); const notebook = book(Object.freeze([Object.freeze([record])]));
  evaluateNotebookOperation(notebook, op([{ type: 'insert', object: child('a') }]));
  record.boardObjectId = 'renamed';
  const result = evaluateNotebookOperation(notebook, op([{ type: 'patch', id: 'renamed', patch: { left: 15 } }]));
  assert.equal(result.changed, true);
  assert.equal(record.left, 0, 'preflight does not mutate caller children');
});

test('conditional patch, delete, restore and undo preserve canonical order and guards', () => {
  const original = book(freezeNotebookRecord([[child('a'), child('b'), child('c')]]));
  const next = { ...original };
  const remove = op([{ type: 'delete', id: 'b', ifZIndex: 1 }]);
  const inverse = invertNotebookOperation(original, remove, ctx);
  applyNotebookOperation(next, remove);
  const tombstones = updateNotebookTombstones({}, [remove], ctx);
  assert.equal(evaluateNotebookOperation(next, inverse[0], {}).changed, false);
  const restored = evaluateNotebookOperation(next, inverse[0], tombstones, ctx);
  assert.deepEqual(restored.skippedConflicts, []);
  applyNotebookOperation(next, { ...inverse[0], changes: restored.appliedChanges });
  assert.deepEqual(next.notebookPages[0].map(x => x.boardObjectId), ['a', 'b', 'c']);
  assert.deepEqual(JSON.parse(JSON.stringify(next.notebookPages)), JSON.parse(JSON.stringify(original.notebookPages)));
});

test('many insertions into one order gap never reorder or duplicate siblings', () => {
  const notebook = book(freezeNotebookRecord([[child('first'), child('last')]]));
  const expected = ['first', 'last'];
  for (let i = 0; i < 90; i++) {
    applyNotebookOperation(notebook, op([{ type: 'insert', object: child(`gap-${i}`), zIndex: 1 }], i + 2));
    expected.splice(1, 0, `gap-${i}`);
  }
  assert.deepEqual(notebook.notebookPages[0].map(x => x.boardObjectId), expected);
  const result = evaluateNotebookOperation(notebook, op([{ type: 'delete', id: 'gap-30', ifZIndex: expected.indexOf('gap-30') }]));
  assert.equal(result.changed, true);
});

test('mixed indexed operations and inverses match the legacy array reducer through 320 steps', () => {
  let indexed = book(freezeNotebookRecord([Array.from({ length: 60 }, (_, i) => child(`seed-${i}`, i))]));
  let legacy = structuredClone(indexed), tombstones = {};
  let seed = 1701;
  const random = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  for (let step = 0; step < 320; step++) {
    // Unowned copies deliberately exercise the retained canonical array reducer.
    legacy = structuredClone(legacy);
    const records = legacy.notebookPages[0], position = random(records.length || 1), current = records[position];
    const identity = current?.boardObjectId, changes = [];
    switch (step % 8) {
      case 0: case 1: changes.push({ type: 'insert', object: child(`new-${step}`, step), zIndex: random(records.length + 1) }); break;
      case 2: changes.push({ type: 'patch', id: identity, patch: { left: step, opacity: 0.6 }, ifFields: { left: current.left } }); break;
      case 3: changes.push({ type: 'delete', id: identity, ifZIndex: position }); break;
      case 4: changes.push({ type: 'patch', id: identity, patch: { stroke: 'blue', left: 99 }, unset: ['opacity'], ifFields: { left: -999 } }); break;
      case 5: changes.push({ type: 'delete', id: identity, ifZIndex: position + 1 }); break;
      case 6: changes.push({ type: 'insert', object: child(`compound-${step}`), zIndex: position }, { type: 'patch', id: `compound-${step}`, patch: { stroke: 'red' } }); break;
      case 7: changes.push({ type: 'delete', id: identity }, { type: 'insert', object: { ...child(identity), type: 'Rect' }, zIndex: 0 }); break;
    }
    const action = op(changes, step + 10), context = { ...ctx, actionId: `a-${step}`, mutationId: `a-${step}` };
    const beforeIndexed = { ...indexed }, beforeLegacy = structuredClone(legacy);
    const actual = evaluateNotebookOperation(indexed, action, tombstones, context);
    const expected = evaluateNotebookOperation(legacy, action, tombstones, context);
    assert.deepEqual(actual, expected, `preflight step ${step}`);
    if (!actual.changed) continue;
    const accepted = { ...action, changes: actual.appliedChanges };
    applyNotebookOperation(indexed, accepted); applyNotebookOperation(legacy, accepted);
    const inverse = invertNotebookOperation(beforeIndexed, accepted, { ...context, afterState: indexed });
    assert.deepEqual(inverse, invertNotebookOperation(beforeLegacy, accepted, { ...context, afterState: structuredClone(legacy) }), `inverse step ${step}`);
    assert.deepEqual(structuredClone(indexed), structuredClone(legacy), `state step ${step}`);
    tombstones = updateNotebookTombstones(tombstones, [accepted], context);
    if (step % 13 === 0 && inverse.length) {
      const undoActual = evaluateNotebookOperation(indexed, inverse[0], tombstones, context);
      const undoExpected = evaluateNotebookOperation(structuredClone(legacy), inverse[0], tombstones, context);
      assert.deepEqual(undoActual, undoExpected);
      if (undoActual.changed) {
        const undo = { ...inverse[0], changes: undoActual.appliedChanges };
        applyNotebookOperation(indexed, undo); applyNotebookOperation(legacy, undo);
        tombstones = updateNotebookTombstones(tombstones, [undo], context);
      }
      assert.deepEqual(structuredClone(indexed), structuredClone(legacy));
    }
  }
});

test('unsafe duplicate legacy identities keep original last-identity delete semantics', () => {
  const a = child('same', 1), b = child('same', 2);
  const indexed = book(freezeNotebookRecord([[a, b]])), legacy = structuredClone(indexed);
  const action = op([{ type: 'delete', id: 'same' }]);
  applyNotebookOperation(indexed, action); applyNotebookOperation(legacy, action);
  assert.deepEqual(structuredClone(indexed), structuredClone(legacy));
  assert.equal(indexed.notebookPages[0][0].left, 1);
});

test('retained page versions remain unchanged after later patch, removal and middle insertion', () => {
  const notebook = book(freezeNotebookRecord([[child('a'), child('b'), child('c')]]));
  const pages = [notebook.notebookPages];
  for (const changes of [
    [{ type: 'patch', id: 'b', patch: { left: 50 } }],
    [{ type: 'delete', id: 'a' }],
    [{ type: 'insert', object: child('d'), zIndex: 1 }],
  ]) { applyNotebookOperation(notebook, op(changes)); pages.push(notebook.notebookPages); }
  assert.deepEqual(pages.map(p => p[0].map(c => `${c.boardObjectId}:${c.left}`)), [
    ['a:0','b:0','c:0'], ['a:0','b:50','c:0'], ['b:50','c:0'], ['b:50','d:0','c:0'],
  ]);
});
