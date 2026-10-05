import test from 'node:test';
import assert from 'node:assert/strict';
import { createNotebookSession } from '../src/lib/notebookSession.js';
import { createNotebookBoardController } from '../src/lib/notebookBoardController.js';
import { evaluateAuthorityAction } from '../src/lib/authorityOperationEvaluator.js';

const base = (neighbors = 1000) => ({ revision: 0, snapshot: { version: 2, background: 'blank', canvas: { objects: [
  ...Array.from({ length: neighbors }, (_, i) => ({ type: 'Path', boardObjectId: `neighbor-${i}`, left: i, top: i,
    path: [['M', 0, 0], ['L', 3, 5]], updatedAt: 1 })),
  { type: 'BoardNotebook', boardObjectId: 'book', notebookPageNumber: 1, notebookPages: [[], []] },
] } } });
const ink = id => ({ type: 'notebook', version: 1, id: 'book', pageNumber: 1,
  changes: [{ type: 'insert', object: { type: 'Path', boardObjectId: id, path: [['M', 0, 0], ['L', 10, 10]] }, ifAbsent: true }],
  updatedAt: 10, updatedBy: 'writer' });
const commit = (id, revision, ops) => ({ actionId: id, clientId: 'writer', revision, ops, changed: true, background: null });
const clean = operation => ({ ...operation, changes: operation.changes.map(({ ifAbsent, ...change }) => ({ ...change, zIndex: 0 })) });
const pending = () => new Promise(() => {});

test('local notebook preview retains every unrelated frozen board record by identity', () => {
  const s = createNotebookSession({ confirmedState: base(), publish: pending }); s.pause('test');
  const before = s.getState().snapshot;
  s.enqueue({ actionId: 'a', ops: [ink('a')] });
  const after = s.getState().snapshot;
  for (let i = 0; i < 1000; i++) assert.strictEqual(after.canvas.objects[i], before.canvas.objects[i], `unrelated ${i} was copied`);
  assert.equal(before.canvas.objects.at(-1).notebookPages[0].length, 0);
  assert.equal(after.canvas.objects.at(-1).notebookPages[0].length, 1);
  assert.strictEqual(after.canvas.objects.at(-1).notebookPages[1], before.canvas.objects.at(-1).notebookPages[1]);
  s.dispose();
});

test('indexed-fork preparation never mutates a frozen prior transform or its neighbors', () => {
  const s = createNotebookSession({ confirmedState: base(2), publish: pending }); s.pause('test');
  const before = s.getState().snapshot;
  s.enqueue({ actionId: 'move', ops: [{ type: 'transform', version: 1, objects: [{ id: 'neighbor-0', transform: { left: 900 }, updatedAt: 12 }] }] });
  const after = s.getState().snapshot;
  assert.equal(before.canvas.objects[0].left, 0); assert.equal(after.canvas.objects[0].left, 900);
  assert.strictEqual(before.canvas.objects[1], after.canvas.objects[1]);
  s.dispose();
});

test('authority preflight remains isolated for transformed objects and dependent notebook actions', () => {
  const { snapshot } = base(2), retained = structuredClone(snapshot);
  const result = evaluateAuthorityAction({ snapshot, notebookVersion: 1, clientId: 'writer', actionId: 'both', ops: [
    { type: 'transform', version: 1, objects: [{ id: 'neighbor-0', transform: { left: 900 }, updatedAt: 12 }] }, ink('a'),
  ] });
  assert.equal(result.appliedOps.length, 2); assert.deepEqual(snapshot, retained);
});

test('the same confirmed acknowledgement cannot rebuild still-pending ink or notify twice', () => {
  const events = [], s = createNotebookSession({ confirmedState: base(2), publish: pending,
    onChange: (_state, event) => events.push(event) }); s.pause('test');
  s.enqueue({ actionId: 'a', ops: [ink('a')] }); s.enqueue({ actionId: 'b', ops: [ink('b')] });
  const confirmed = commit('a', 1, [clean(ink('a'))]);
  s.ack(confirmed);
  const before = s.getState().snapshot, count = events.length;
  s.ack(structuredClone(confirmed));
  assert.strictEqual(s.getState().snapshot, before, 'duplicate replayed pending actions');
  assert.equal(events.length, count, 'duplicate triggered UI notification');
  assert.equal(s.pendingCount(), 1); s.dispose();
});

test('a conflicting duplicate of a recent confirmed revision is rejected without changing current ink', () => {
  const s = createNotebookSession({ confirmedState: base(0), publish: pending }); s.pause('test');
  s.enqueue({ actionId: 'a', ops: [ink('a')] });
  s.ack(commit('a', 1, [clean(ink('a'))]));
  const before = s.getState().snapshot;
  assert.throws(() => s.ack(commit('a', 1, [clean(ink('evil'))])), error => error.code === 'notebook_revision_conflict');
  assert.strictEqual(s.getState().snapshot, before); s.dispose();
});

test('duplicate acknowledgement does not enqueue a new Canvas projection', async () => {
  let paints = 0;
  const c = createNotebookBoardController({ confirmedState: base(0), publish: pending, paint: async () => { paints++; return true; } });
  c.pause('test'); c.enqueue({ actionId: 'a', ops: [ink('a')] }); c.enqueue({ actionId: 'b', ops: [ink('b')] });
  const confirmed = commit('a', 1, [clean(ink('a'))]); c.ack(confirmed); await c.whenPainted();
  const before = paints; c.ack(structuredClone(confirmed)); await c.whenPainted();
  assert.equal(paints, before, 'duplicate reprojected already installed state'); c.dispose();
});

test('restored pending action acknowledged by an older snapshot revision is still removed safely', async () => {
  const op = clean(ink('a')), initial = base(0);
  initial.snapshot.canvas.objects[0].notebookPages[0].push(op.changes[0].object); initial.revision = 4;
  const s = createNotebookSession({ confirmedState: initial, initialPendingActions: [{ actionId: 'a', clientId: 'writer', baseRevision: 0, ops: [ink('a')] }],
    publish: async () => commit('a', 1, [op]) });
  await s.flush(); assert.equal(s.pendingCount(), 0);
  assert.equal(s.getState().snapshot.canvas.objects[0].notebookPages[0].length, 1); s.dispose();
});
