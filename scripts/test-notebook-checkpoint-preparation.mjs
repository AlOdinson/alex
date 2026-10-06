import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createNotebookSession } from '../src/lib/notebookSession.js';
import { createNotebookBoardController } from '../src/lib/notebookBoardController.js';
import { indexedBoardModelFor } from '../src/lib/indexedBoardModel.js';
import { callback } from './notebook-ui-node-harness.mjs';
const api = await import('../src/lib/notebookCheckpoint.js').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND' && error.message.includes('notebookCheckpoint.js')) return {};
  throw error;
});
const ref = current => ({ current });
const task = () => new Promise(resolve => setTimeout(resolve, 0));
const never = () => new Promise(() => {});
const seed = (count = 1200) => ({ revision: 7, snapshot: { version: 2, background: 'grid', canvas: { objects: [
  { type: 'BoardNotebook', boardObjectId: 'book', notebookPageNumber: 6,
    notebookPages: Array.from({ length: 6 }, (_, p) => Array.from({ length: 100 }, (_, i) => ({
      type: 'Path', boardObjectId: `p${p}-${i}`, path: [['M', 0, 0], ['Q', 3, 2, 5, 8]], stroke: 'black',
    }))) },
  ...Array.from({ length: count }, (_, i) => ({ type: 'Rect', boardObjectId: `other-${i}`, width: 10, height: 10 })),
] } }, tombstones: Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`deleted-${i}`, { revision: i, actionId: `a-${i}` }])),
notebookTombstones: { book: { '1': { gone: { revision: 6 } } } }, acknowledgedActionIds: ['settled'] });
const prepare = (...args) => { assert.equal(typeof api.prepareNotebookCheckpoint, 'function', 'bounded checkpoint preparation missing'); return api.prepareNotebookCheckpoint(...args); };
function acquisition(source, { duringRead = () => {}, revision = () => source.revision } = {}) {
  let reads = 0;
  const runtime = { whenRuntimeReady: async () => {}, flushPending: async () => {}, getNotebookVersion: () => 1,
    getRevision: revision, getNotebookCheckpoint: () => { reads++; duringRead(reads); return structuredClone(source); } };
  const scope = { notebookRuntimeEnabled: true, boardReadyRef: ref(true), fabricCanvasRef: ref({}), realtimeRef: ref(runtime),
    notebookControllerRef: ref(null), notebookControllerInitRef: ref(null), notebookControllerEpochRef: ref(0),
    clientIdRef: ref('teacher'), canEditRef: ref(true), boardId: 'board', pendingServerWritesRef: ref(0),
    notebookGapRevisionRef: ref(null), notebookHandlersRef: ref({}),
    createNotebookBoardController, createNotebookOutbox: () => ({ list: async () => [], save: async () => {}, remove: async () => {} }),
    readStableNotebookCheckpoint: (...args) => { assert.equal(typeof api.readStableNotebookCheckpoint, 'function'); return api.readStableNotebookCheckpoint(...args); },
    readSnapshotRecord() {}, sendDurableOps: never, replayPendingActionsLocally: async () => true,
    setPendingCount() {}, setSaveStatus() {}, setSyncTone() {}, syncFromServer() {},
  };
  scope.ensureNotebookController = callback('ensureNotebookController', scope);
  return { scope, get reads() { return reads; } };
}

test('actual Board cold controller yields during model preparation, not only before fetching it', async () => {
  let taskBeforeInstall = false, h;
  h = acquisition(seed(), { duringRead: () => setTimeout(() => { taskBeforeInstall = h.scope.notebookControllerRef.current === null; }, 0) });
  const c = await h.scope.ensureNotebookController();
  try { assert.equal(taskBeforeInstall, true, 'cold checkpoint monopolized freeze/index construction'); assert.equal(c.getState().snapshot.canvas.objects.length, 1201); }
  finally { c.dispose(); }
});

test('actual Board retries when a commit arrives during checkpoint preparation', async () => {
  const source = seed(); let arrived;
  const h = acquisition(source, { duringRead: n => { if (n === 1) arrived = new Promise(resolve => setTimeout(() => {
    source.revision++; source.snapshot.canvas.objects.push({ type: 'Rect', boardObjectId: 'remote-during-load', width: 4 }); resolve();
  }, 0)); } });
  const c = await h.scope.ensureNotebookController(); await arrived;
  try { assert.equal(c.getConfirmedState().revision, 8, 'installed a checkpoint made stale by a new commit');
    assert.equal(c.getState().snapshot.canvas.objects.at(-1).boardObjectId, 'remote-during-load'); assert.equal(h.reads, 2); }
  finally { c.dispose(); }
});

test('closing or replacing the runtime during cold preparation cannot install a controller', async () => {
  for (const replace of [false, true]) {
    let h;
    h = acquisition(seed(), { duringRead: () => setTimeout(() => {
      if (replace) h.scope.realtimeRef.current = {}; else h.scope.notebookControllerEpochRef.current++;
    }, 0) });
    const c = await h.scope.ensureNotebookController();
    try { assert.equal(c, null, 'late preparation installed on a closed or different runtime'); }
    finally { c?.dispose(); }
    assert.equal(h.scope.notebookControllerRef.current, null); assert.equal(h.scope.notebookControllerInitRef.current, null);
  }
});

test('preparation preserves canonical data, source isolation, array order and deep immutability', async () => {
  const source = seed(12), expected = structuredClone(source);
  const ready = prepare(source);
  source.snapshot.canvas.objects[0].notebookPages[0][0].path[1][1] = 999;
  const token = await ready;
  const s = createNotebookSession({ confirmedState: token, publish: never });
  try { assert.deepEqual(structuredClone(s.getState()), { snapshot: expected.snapshot, revision: expected.revision });
    assert.ok(indexedBoardModelFor(s.getState().snapshot));
    assert.ok(Object.isFrozen(s.getState().snapshot.canvas.objects[0].notebookPages[0][0].path[1]));
    assert.equal(Object.isFrozen(source.snapshot.canvas.objects[1]), false); }
  finally { s.dispose(); }
});

test('prepared token avoids a second complete clone and cannot be forged by plain metadata', async () => {
  const token = await prepare(seed(2)); const original = globalThis.structuredClone; let copies = 0;
  globalThis.structuredClone = (...args) => { copies++; return original(...args); };
  let s;
  try { s = createNotebookSession({ confirmedState: token, publish: never }); assert.equal(copies, 0, 'prepared state was deep-cloned again'); }
  finally { globalThis.structuredClone = original; s?.dispose(); }
  const fake = structuredClone(token); fake.prepared = true;
  const other = createNotebookSession({ confirmedState: fake, publish: never });
  try { fake.snapshot.canvas.objects[0].notebookPages[0][0].stroke = 'red';
    assert.equal(other.getState().snapshot.canvas.objects[0].notebookPages[0][0].stroke, 'black'); }
  finally { other.dispose(); }
});

test('preparation cancellation releases the caller without installing partial state', async () => {
  const abort = new AbortController(); const pending = prepare(seed(), { signal: abort.signal });
  setTimeout(() => abort.abort(new Error('cancel cold checkpoint')), 0);
  await assert.rejects(pending, /cancel cold checkpoint/);
  let current = true; const superseded = prepare(seed(), { isCurrent: () => current });
  setTimeout(() => { current = false; }, 0);
  await assert.rejects(superseded, e => e.code === 'notebook_work_cancelled');
});

test('cyclic notebook records and invalid checkpoint values reject without certifying them', async () => {
  await assert.rejects(prepare({ revision: -1, snapshot: { canvas: { objects: [] } } }), /snapshot|revision/);
  const source = seed(1); source.snapshot.canvas.objects[1].cycle = source.snapshot.canvas.objects[1];
  await assert.rejects(prepare(source), /Cyclic notebook record/);
});

test('stable reader has a bounded compatibility escape under continuously changing revision', async () => {
  assert.equal(typeof api.readStableNotebookCheckpoint, 'function'); let revision = 0, reads = 0;
  const result = await api.readStableNotebookCheckpoint({
    readCheckpoint: () => { const source = seed(2); source.revision = ++revision; reads++; return source; },
    readRevision: () => ++revision,
  });
  assert.equal(reads, 4, 'continuous traffic must not loop forever'); assert.equal(result.revision, revision);
  const s = createNotebookSession({ confirmedState: result, publish: never });
  try { assert.equal(s.getState().revision, revision); } finally { s.dispose(); }
});

test('independent preparations do not share cancellation or mutable model state', async () => {
  const abort = new AbortController(); const one = prepare(seed(), { signal: abort.signal });
  const two = prepare(seed(4)); abort.abort(new Error('one only'));
  await assert.rejects(one, /one only/); const token = await two;
  const a = createNotebookSession({ confirmedState: token, publish: never }), b = createNotebookSession({ confirmedState: token, publish: never });
  try { a.pause('offline'); const h = a.enqueue({ type: 'notebook', version: 1, id: 'book', pageNumber: 6, changes: [
    { type: 'insert', ifAbsent: true, object: { type: 'Rect', boardObjectId: 'new', width: 3 } } ] });
    assert.equal(a.getState().snapshot.canvas.objects[0].notebookPages[5].length, 101);
    assert.equal(b.getState().snapshot.canvas.objects[0].notebookPages[5].length, 100);
    assert.ok(h.inverseOps.length); }
  finally { a.dispose(); b.dispose(); }
});

test('the final await handoff cannot install a checkpoint older than the current runtime', async () => {
  const source = seed(1), h = acquisition(source);
  h.scope.readStableNotebookCheckpoint = async () => {
    const token = await prepare(source);
    source.revision++; source.snapshot.canvas.objects.push({ type: 'Rect', boardObjectId: 'last-microtask', width: 8 });
    return token;
  };
  const c = await h.scope.ensureNotebookController();
  try { assert.equal(c.getConfirmedState().revision, 8); assert.equal(c.getState().snapshot.canvas.objects.at(-1).boardObjectId, 'last-microtask'); }
  finally { c.dispose(); }
});

test('prepared and canonical sessions agree on guarded edits, tombstones and inverses', async () => {
  const source = seed(3);
  source.notebookTombstones = { '["book",6,"gone"]': { clientId: 'teacher', mutationId: 'deleted-m', revision: 6 } };
  const token = await prepare(source);
  const a = createNotebookSession({ confirmedState: token, publish: never }), b = createNotebookSession({ confirmedState: source, publish: never });
  a.pause('offline'); b.pause('offline');
  try {
    const operations = [
      { type: 'insert', object: { type: 'Rect', boardObjectId: 'gone', width: 4 }, ifDeletedBy: 'teacher', ifDeletedMutationId: 'deleted-m' },
      { type: 'insert', object: { type: 'Rect', boardObjectId: 'added', width: 4 }, ifAbsent: true },
      { type: 'patch', id: 'p5-30', patch: { stroke: 'red' }, ifFields: { stroke: 'black' } },
      { type: 'delete', id: 'p5-31', ifFields: { stroke: 'black' } },
      { type: 'delete', id: 'p5-32', ifFields: { stroke: 'purple' } },
    ];
    for (let i = 0; i < operations.length; i++) {
      const input = { actionId: `compare-${i}`, clientId: 'teacher', ops: [{ type: 'notebook', version: 1, id: 'book', pageNumber: 6, changes: [operations[i]] }] };
      const ah = a.enqueue(input), bh = b.enqueue(input);
      assert.deepEqual(ah.inverseOps, bh.inverseOps); assert.deepEqual(structuredClone(a.getState()), structuredClone(b.getState()));
      assert.deepEqual(a.exportPending(), b.exportPending());
    }
  } finally { a.dispose(); b.dispose(); }
});

test('duplicate, missing and selection IDs preserve the original indexed layout semantics', async () => {
  const source = seed(0); source.snapshot.canvas.objects.push(
    { type: 'Rect', boardObjectId: 'duplicate', width: 1 }, { type: 'Rect', width: 2 },
    { type: 'ActiveSelection', boardObjectId: 'selection', objects: [] },
    { type: 'Rect', boardObjectId: 'duplicate', width: 3 });
  const a = createNotebookSession({ confirmedState: await prepare(source), publish: never });
  const b = createNotebookSession({ confirmedState: source, publish: never });
  try {
    const ai = indexedBoardModelFor(a.getState().snapshot), bi = indexedBoardModelFor(b.getState().snapshot);
    assert.equal(ai.supportsStableOrder, bi.supportsStableOrder); assert.equal(ai.supportsStableOrder, false);
    for (const id of ['book', 'duplicate', 'selection', 'absent']) assert.deepEqual(ai.readRecord(id), bi.readRecord(id));
    assert.deepEqual(structuredClone(a.getState()), structuredClone(b.getState()));
  } finally { a.dispose(); b.dispose(); }
});


test('storage recovery index loads with the pinned previous renderer record utilities', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'notebook-previous-reader-'));
  try {
    const previousRecords = execFileSync('git', ['show', '52a65f38badf74215568540297e71ba3ce7b8b0c:src/lib/notebookRecords.js'], { cwd: new URL('..', import.meta.url) });
    await fs.writeFile(path.join(dir, 'package.json'), '{"type":"module"}');
    await fs.writeFile(path.join(dir, 'notebookRecords.js'), previousRecords);
    await fs.copyFile(new URL('../src/lib/boardTombstoneIndex.js', import.meta.url), path.join(dir, 'boardTombstoneIndex.js'));
    const indexApi = await import(pathToFileURL(path.join(dir, 'boardTombstoneIndex.js')).href);
    const source = { old: { revision: 5, nested: { retained: true } } };
    const index = indexApi.createBoardTombstoneIndex(source);
    assert.deepEqual(index.serialize(), source);
    const it = indexApi.createBoardTombstoneIndexSteps(source);
    let step; do { step = it.next(); } while (!step.done);
    assert.deepEqual(step.value.serialize(), source);
    source.old.nested.retained = false;
    assert.equal(index.get('old').nested.retained, true);
    assert.equal(step.value.get('old').nested.retained, true);
    assert.ok(Object.isFrozen(step.value.get('old').nested));
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
