import test from 'node:test';
import assert from 'node:assert/strict';
import { getEnv } from 'fabric/node';
import { setEnv, Path, StaticCanvas } from 'fabric';
import { BoardNotebook, applyPageDeltaToFabric } from '../src/lib/boardNotebook.js';
import { applyNotebookOperation } from '../src/lib/notebookOperations.js';
import { prepareNotebookProjection } from '../src/lib/notebookProjection.js';
setEnv(getEnv());
const fields = ['boardObjectId', 'updatedAt', 'updatedBy'];
const record = id => new Path('M -40 -20 L 20 10', { boardObjectId: id, fill: null, stroke: 'black', strokeWidth: 2 }).toObject(fields);
const insert = id => ({ type: 'notebook', version: 1, id: 'book', pageNumber: 1, updatedAt: 12,
  updatedBy: 'writer', changes: [{ type: 'insert', object: record(id) }] });
async function fixture() {
  const book = await BoardNotebook.fromObject({ boardObjectId: 'book', notebookPages: [Array.from({length: 300}, (_, i) => record(`old-${i}`))] });
  const canvas = new StaticCanvas(null, { width: 700, height: 600, renderOnAddRemove: false }); canvas.add(book); canvas.renderAll();
  return { book, canvas, close: () => canvas.dispose() };
}
function spyLists(book, arrays) {
  const originals = new Map(), get = book.getPageObjects; let reads = 0;
  book.getPageObjects = function (...args) { reads++; return get.apply(this, args); };
  for (const key of ['map', 'filter', 'some', 'every', 'forEach', 'slice', Symbol.iterator]) {
    const method = Array.prototype[key]; originals.set(key, method);
    Array.prototype[key] = function (...args) { if (arrays.includes(this)) reads++; return method.apply(this, args); };
  }
  return { reads: () => reads, restore() { book.getPageObjects = get; for (const [key, method] of originals) Array.prototype[key] = method; } };
}

test('known single-child append reaches projection without scanning old page records or Fabric children', async () => {
  const f = await fixture(); const before = f.book.notebookPages[0], old = f.book._objects.slice();
  const target = { ...f.book.toObject(fields) }; applyNotebookOperation(target, insert('new'));
  const spy = spyLists(f.book, [before, target.notebookPages[0]]);
  try {
    const work = await prepareNotebookProjection(f.book, target); assert.equal(work.apply(), true);
    assert.equal(spy.reads(), 0, 'known append rediscovered its delta by scanning the whole page');
    assert.equal(f.book._objects.length, 301); assert.equal(f.book._objects.at(-1).boardObjectId, 'new');
    for (let i = 0; i < old.length; i++) assert.strictEqual(f.book._objects[i], old[i]);
    assert.strictEqual(f.book.notebookPages, target.notebookPages);
    assert.equal(f.book._objects.at(-1).updatedAt, 12);
  } finally { spy.restore(); await f.close(); }
});

test('incoming delta appends its prepared child without resynchronizing the whole Fabric page', async () => {
  const f = await fixture(); const get = f.book.getPageObjects; let reads = 0;
  f.book.getPageObjects = function (...args) { reads++; return get.apply(this, args); };
  try {
    assert.equal((await applyPageDeltaToFabric(f.book, insert('remote'))).changed, true);
    assert.equal(reads, 0, 'incoming append rescanned or rebuilt its whole page');
    assert.equal(f.book._objects.length, 301);
  } finally { f.book.getPageObjects = get; await f.close(); }
});

test('unproven duplicate identities still fail the full projection validator', async () => {
  const f = await fixture(); const before = f.book.notebookPages;
  try {
    const target = structuredClone(f.book.toObject(fields)); target.notebookPages[0].push(record('old-0'));
    await assert.rejects(prepareNotebookProjection(f.book, target), /Duplicate/);
    assert.strictEqual(f.book.notebookPages, before); assert.equal(f.book._objects.length, 300);
  } finally { await f.close(); }
});

test('reordered checkpoint with a new child uses general projection and restores the exact order', async () => {
  const f = await fixture();
  try {
    const target = structuredClone(f.book.toObject(fields)); target.notebookPages[0].reverse(); target.notebookPages[0].push(record('new'));
    const work = await prepareNotebookProjection(f.book, target); assert.equal(work.apply(), true);
    assert.deepEqual(f.book._objects.map(x => x.boardObjectId), target.notebookPages[0].map(x => x.boardObjectId));
  } finally { await f.close(); }
});

test('superseded append preparation leaves visible children and records unchanged', async () => {
  const f = await fixture(); const before = f.book.notebookPages, target = { ...f.book.toObject(fields) };
  applyNotebookOperation(target, insert('cancelled')); let current = true;
  try {
    const work = await prepareNotebookProjection(f.book, target, { isCurrent: () => current }); current = false;
    assert.equal(work.apply(), false); work.dispose();
    assert.strictEqual(f.book.notebookPages, before); assert.equal(f.book._objects.length, 300);
  } finally { await f.close(); }
});

test('actual local capture installs its canonical appended page without a syncPage scan', async () => {
  const { authorityFixture, createUiHarness, serialized } = await import('./notebook-ui-node-harness.mjs');
  const { readSnapshotRecord } = await import('../src/lib/indexedBoardModel.js');
  const original = new BoardNotebook({ boardObjectId: 'book', left: 20, top: 20 });
  for (let i = 0; i < 300; i++) original.addPageObject(new Path(`M -180 ${-150 + i} L 80 ${-147 + i}`,
    { boardObjectId: `old${i}`, stroke: 'black', strokeWidth: 2, fill: null }));
  const { authority } = await authorityFixture([serialized(original)]); original.dispose();
  const ui = await createUiHarness({ authority });
  try {
    const book = ui.book(), controller = ui.scope.notebookControllerRef.current;
    const model = readSnapshotRecord(controller.getState().snapshot, 'book').object;
    const alignment = await prepareNotebookProjection(book, model); assert.equal(alignment.apply(), true);
    ui.canvas.renderAll();
    const sync = book.syncPage; let scans = 0;
    book.syncPage = function (...args) { scans++; return sync.apply(this, args); };
    const ink = new Path('M 140 340 L 200 345', { boardObjectId: 'source', stroke: 'black', strokeWidth: 3, fill: null });
    ui.canvas.add(ink);
    assert.equal(await ui.scope.captureIntoNotebook(ink), true);
    await ui.flush();
    assert.equal(scans, 0, 'local capture resynchronized all prior page objects');
    assert.equal(book._objects.length, 301);
    assert.deepEqual(book.notebookPages, authority.getSnapshot().canvas.objects[0].notebookPages);
    assert.equal(ui.errors.length, 0);
  } finally { await ui.close(); }
});

test('unchanged incoming preparation does not run the page reducer a second time', async () => {
  const f = await fixture(), base = f.book.notebookPages[0], original = Array.prototype.slice; let copies = 0;
  Array.prototype.slice = function (...args) { if (this === base) copies++; return original.apply(this, args); };
  try {
    await applyPageDeltaToFabric(f.book, insert('single-prepare'));
    assert.equal(copies, 1, 'same page was copied again after unchanged asynchronous preparation');
  } finally { Array.prototype.slice = original; await f.close(); }
});

test('only one validated immutable tail insertion carries an append proof', async () => {
  const { notebookPageAppend } = await import('../src/lib/notebookPageDelta.js');
  const f = await fixture(); const before = f.book.notebookPages[0];
  try {
    for (const changes of [
      [{ type: 'insert', object: record('middle'), zIndex: 1 }],
      [{ type: 'insert', object: record('one') }, { type: 'insert', object: record('two') }],
      [{ type: 'delete', id: 'old-0' }],
      [{ type: 'patch', id: 'old-0', patch: { left: 50 } }],
      [{ type: 'insert', object: record('old-0') }],
    ]) {
      const target = { ...f.book.toObject(fields) };
      applyNotebookOperation(target, { ...insert('ignored'), changes });
      assert.equal(notebookPageAppend(before, target.notebookPages[0]), null);
    }
    const target = { ...f.book.toObject(fields) }; applyNotebookOperation(target, insert('tail'));
    assert.equal(notebookPageAppend(before, target.notebookPages[0]).record.boardObjectId, 'tail');
    assert.equal(notebookPageAppend(before, structuredClone(target.notebookPages[0])), null, 'wire/checkpoint cannot forge proof');
  } finally { await f.close(); }
});

test('a hidden-page change during preparation is preserved when the visible append resumes', async () => {
  const f = await fixture();
  try {
    const pending = applyPageDeltaToFabric(f.book, insert('visible'));
    await Promise.resolve();
    applyNotebookOperation(f.book, { ...insert('hidden'), pageNumber: 2 });
    assert.equal((await pending).changed, true);
    assert.equal(f.book.notebookPages[0].length, 301);
    assert.equal(f.book.notebookPages[1][0].boardObjectId, 'hidden');
  } finally { await f.close(); }
});

test('changed live content cannot use a previously prepared append proof', async () => {
  const f = await fixture();
  try {
    const target = { ...f.book.toObject(fields) }; applyNotebookOperation(target, insert('tail'));
    const child = await Path.fromObject(target.notebookPages[0].at(-1));
    const before = f.book.notebookPages;
    f.book.invalidatePageContent(f.book._objects[0]);
    assert.equal(f.book.appendPreparedPageObject(child, target.notebookPages), false);
    assert.strictEqual(f.book.notebookPages, before); assert.equal(f.book._objects.length, 300);
    child.dispose();
  } finally { await f.close(); }
});

test('proven local append pixels match canonical rendering with fractional scale and transparent ink', async () => {
  const { createNotebookBoardActions } = await import('../src/lib/notebookBoardActions.js');
  const { applyAuthorityOpsInPlace } = await import('../src/lib/authoritySnapshot.js');
  const { Point, util } = await import('fabric');
  const f = await fixture();
  try {
    f.book.set({ left: 20, top: 20, scaleX: .65, scaleY: .65, opacity: .45 });
    f.canvas.setZoom(1.3); f.canvas.renderAll();
    const snapshot = { version: 2, canvas: { objects: [f.book.toObject(fields)] } };
    let installed = 0;
    const append = f.book.appendPreparedPageObject;
    f.book.appendPreparedPageObject = function (...args) { const result = append.apply(this, args); if (result) installed++; return result; };
    const controller = { getState: () => ({ snapshot }), pendingObjectIds: () => new Set(['book']),
      enqueue(input) { applyAuthorityOpsInPlace(snapshot, input.ops); return { actionId: input.actionId, inverseOps: [], settled: new Promise(() => {}) }; } };
    const actions = createNotebookBoardActions({ getCanvas: () => f.canvas, getController: async () => controller,
      clientId: 'test', acquireLease: async () => true, ownsLease: () => true, releaseLease() {}, recordAction() {},
      getRecords: () => { throw new Error('contained append should not request full source records'); } });
    const points = [[-40,22],[0,55],[45,32]].map(([x,y]) => util.transformPoint(new Point(x,y), f.book.calcTransformMatrix()));
    const stroke = new Path([['M',points[0].x,points[0].y],['Q',points[1].x,points[1].y,points[2].x,points[2].y]], {
      boardObjectId: 'source', stroke: 'rgba(70,30,20,.6)', opacity: .7, strokeWidth: 4, fill: null,
      strokeUniform: true, strokeLineCap: 'round', strokeLineJoin: 'round', strokeDashArray: [7,3] });
    f.canvas.add(stroke); assert.equal(await actions.capture(f.book, stroke), true); f.canvas.renderAll();
    assert.equal(installed, 1);
    const ctx = f.canvas.getContext(), width = f.canvas.lowerCanvasEl.width, height = f.canvas.lowerCanvasEl.height;
    const actual = ctx.getImageData(0, 0, width, height).data;
    f.book.dirty = true; f.canvas.renderAll();
    assert.deepEqual(actual, ctx.getImageData(0, 0, width, height).data);
  } finally { await f.close(); }
});
