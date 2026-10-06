import test from 'node:test';
import assert from 'node:assert/strict';
import { createNotebookSession } from '../src/lib/notebookSession.js';
import { createNotebookBoardController } from '../src/lib/notebookBoardController.js';

const base = () => ({ revision: 0, snapshot: { version: 2, background: 'grid', canvas: { objects: [
  { type: 'BoardNotebook', boardObjectId: 'book', notebookPageNumber: 1, notebookPages: [[], []] },
] } } });
const insert = id => ({ type: 'notebook', version: 1, id: 'book', pageNumber: 1,
  changes: [{ type: 'insert', ifAbsent: true, object: { type: 'Rect', boardObjectId: id, width: 10, height: 10 } }] });
const action = id => ({ actionId: id, clientId: 'writer', ops: [insert(id)] });
const snapshotWith = (...ids) => { const b = base(); b.revision = 1;
  b.snapshot.canvas.objects[0].notebookPages[0] = ids.map(id => insert(id).changes[0].object); return b; };
const contents = s => s.getState().snapshot.canvas.objects[0]?.notebookPages[0].map(x => x.boardObjectId) ?? [];
const never = () => new Promise(() => {});
const make = options => { const s = createNotebookSession({ confirmedState: base(), publish: never,
  cooperativeRecovery: true, ...options }); s.pause('offline'); return s; };
function fill(s, count = 128) { for (let i = 0; i < count; i++) s.enqueue(action(`ink-${i}`)); }
const task = () => new Promise(resolve => setTimeout(resolve, 0));

// Removing the cooperative rebuild must fail this while preserving sync oracle semantics.
test('large checkpoint replay keeps the old coherent view until an atomic installation and admits a task', async t => {
  const s = make(); t.after(() => s.dispose()); fill(s);
  const old = s.getState().snapshot; let inputSawOld = false;
  setTimeout(() => { inputSawOld = s.getState().snapshot === old; }, 0);
  assert.equal(s.rebase(snapshotWith('remote')), true);
  assert.strictEqual(s.getState().snapshot, old, 'large replay monopolized the caller and installed before input');
  await s.whenReconciled(); assert.equal(inputSawOld, true);
  assert.deepEqual(contents(s), ['remote', ...Array.from({ length: 128 }, (_, i) => `ink-${i}`)]);
});

test('new input and guarded undo accepted during replay are retained in the final canonical order', async t => {
  const s = make(); t.after(() => s.dispose()); fill(s); s.rebase(snapshotWith('remote'));
  const h = s.enqueue(action('fresh'));
  assert.equal(contents(s).at(-1), 'fresh', 'live input was blocked by recovery');
  s.enqueue({ actionId: 'undo-fresh', history: true, ops: h.inverseOps });
  await s.whenReconciled();
  assert.deepEqual(contents(s), ['remote', ...Array.from({ length: 128 }, (_, i) => `ink-${i}`)]);
  assert.equal(s.pendingCount(), 130);
});

test('an acknowledgement or rejection during replay invalidates its draft, not later ink', async t => {
  const s = make(), oracle = make({ cooperativeRecovery: false });
  t.after(() => { s.dispose(); oracle.dispose(); }); fill(s); fill(oracle);
  s.rebase(snapshotWith('remote')); oracle.rebase(snapshotWith('remote'));
  await task();
  const commit = { actionId: 'second-remote', clientId: 'other', revision: 2, changed: true,
    ops: [{ ...insert('remote-2'), changes: [{ type: 'insert', zIndex: 1, object: insert('remote-2').changes[0].object }] }] };
  s.ack(commit); oracle.ack(commit);
  s.reject({ actionId: 'ink-10', revision: 2, accepted: false }); oracle.reject({ actionId: 'ink-10', revision: 2, accepted: false });
  const after = { ...action('after'), baseRevision: s.getConfirmedState().revision };
  s.enqueue(after); oracle.enqueue(after);
  await s.whenReconciled(); assert.deepEqual(s.getState(), oracle.getState());
  assert.deepEqual(s.exportPending(), oracle.exportPending());
});

test('resume does not publish using a stale draft when a restored parent disappeared', async t => {
  let sent = 0;
  const s = make({ publish: () => { sent++; return never(); } }); t.after(() => s.dispose()); fill(s);
  s.rebase({ revision: 1, snapshot: { version: 2, canvas: { objects: [] }, background: 'grid' } });
  s.resume(); await s.whenReconciled(); await task();
  assert.equal(sent, 0); assert.equal(s.pendingCount(), 128); assert.deepEqual(contents(s), []);
  await assert.rejects(s.flush(), /blocked|missing/);
});

test('dispose during replay rejects its observer promptly and preserves all durable identities', async () => {
  const s = make(); fill(s); s.rebase(snapshotWith('remote'));
  const ready = s.whenReconciled(), before = s.exportPending(), retained = s.dispose();
  assert.deepEqual(retained, before); await assert.rejects(ready, /disposed/);
  await task(); assert.equal(s.pendingCount(), 0);
});

test('small operations keep immediate synchronous semantics', async t => {
  const s = make(); t.after(() => s.dispose()); s.enqueue(action('one'));
  s.rebase(snapshotWith('remote')); assert.deepEqual(contents(s), ['remote', 'one']);
  await s.whenReconciled();
});

test('controller whenPainted waits for model recovery, not just its previous paint promise', async t => {
  let visible;
  const c = createNotebookBoardController({ confirmedState: base(), publish: never, paint: async v => { visible = v; return true; } });
  t.after(() => c.dispose()); c.pause('offline'); fill(c); await c.whenPainted();
  c.rebase(snapshotWith('remote')); await c.whenPainted();
  assert.deepEqual(visible, c.getState()); assert.equal(contents(c)[0], 'remote');
});

test('a reverse-order burst drains contiguous confirmations between browser tasks', async t => {
  const s = make(); t.after(() => s.dispose()); fill(s);
  const commits = Array.from({ length: 128 }, (_, i) => ({ actionId: `ink-${i}`, clientId: 'writer', revision: i + 1,
    changed: true, ops: [{ ...insert(`ink-${i}`), changes: [{ type: 'insert', zIndex: i, object: insert(`ink-${i}`).changes[0].object }] }] }));
  for (let i = 127; i >= 1; i--) s.ack(commits[i]);
  let inputRevision;
  setTimeout(() => { inputRevision = s.getConfirmedState().revision; }, 0);
  s.ack(commits[0]);
  assert.equal(s.getConfirmedState().revision, 0, 'the acknowledgement drained the whole burst synchronously');
  await s.whenReconciled(); assert.ok(inputRevision < 128);
  assert.equal(s.getConfirmedState().revision, 128); assert.equal(s.pendingCount(), 0);
  assert.deepEqual(contents(s), Array.from({ length: 128 }, (_, i) => `ink-${i}`));
});

test('a large remote-only confirmation burst is included in flush and cannot expose a half-rebuilt view', async t => {
  const s = createNotebookSession({ confirmedState: base(), publish: never, cooperativeRecovery: true });
  t.after(() => s.dispose());
  for (let i = 95; i >= 0; i--) s.ack({ actionId: `other-${i}`, revision: i + 1, changed: true,
    ops: [{ ...insert(`other-${i}`), changes: [{ type: 'insert', zIndex: i, object: insert(`other-${i}`).changes[0].object }] }] });
  let beforeFlush = true;
  const done = s.flush().then(() => { beforeFlush = false; });
  await Promise.resolve(); assert.equal(beforeFlush, true);
  await done; assert.equal(s.getConfirmedState().revision, 96); assert.equal(contents(s).length, 96);
});

test('flush waits for replacement metadata instead of rejecting a previously blocked parent', async t => {
  let revision = 2;
  const s = make({ publish: a => ({ ...a, revision: ++revision, changed: true }) });
  t.after(() => s.dispose()); fill(s, 64);
  s.rebase({ revision: 1, snapshot: { canvas: { objects: [] }, background: 'grid' } });
  await s.whenReconciled();
  const restored = snapshotWith('remote'); restored.revision = 2;
  s.rebase(restored); s.resume();
  await s.flush(); assert.equal(s.pendingCount(), 0); assert.equal(contents(s).length, 65);
});

test('durable pending IDs are removed only for confirmed outcomes across a large checkpoint', async t => {
  const records = new Map(), removed = [];
  const s = make({ outbox: { save: async a => records.set(a.actionId, structuredClone(a)), remove: async id => { removed.push(id); records.delete(id); } } });
  t.after(() => s.dispose());
  const handles = Array.from({ length: 128 }, (_, i) => s.enqueue(action(`ink-${i}`)));
  await Promise.all(handles.map(h => h.durable)); assert.equal(records.size, 128);
  const confirmedIds = Array.from({ length: 64 }, (_, i) => `ink-${i}`);
  const checkpoint = snapshotWith(...confirmedIds); checkpoint.revision = 64; checkpoint.acknowledgedActionIds = confirmedIds;
  s.rebase(checkpoint); s.enqueue(action('live'));
  await s.whenReconciled(); await task();
  assert.deepEqual(removed.sort(), [...confirmedIds].sort());
  assert.equal(s.pendingCount(), 65); assert.equal(records.size, 65); assert.equal(contents(s).length, 129);
  const retained = s.dispose(); assert.deepEqual(retained.map(a => a.actionId).sort(), [...records.keys()].sort());
});

test('a second checkpoint and recent acknowledgement win over a suspended old replay', async t => {
  const s = make(), oracle = make({ cooperativeRecovery: false });
  t.after(() => { s.dispose(); oracle.dispose(); }); fill(s); fill(oracle);
  const old = snapshotWith('old'); const fresh = snapshotWith('new'); fresh.revision = 2;
  s.rebase(old); oracle.rebase(old); await task(); s.rebase(fresh); oracle.rebase(fresh);
  await s.whenReconciled(); assert.deepEqual(s.getState(), oracle.getState());
  assert.equal(contents(s).includes('old'), false);
});

test('deferred nonmanaged acknowledgement does not repaint externally installed ordinary objects', async t => {
  const initial = base(); initial.snapshot.canvas.objects.push({ type: 'Rect', boardObjectId: 'outside', width: 10 });
  const painted = [];
  const c = createNotebookBoardController({ confirmedState: initial, publish: never,
    paint: async (_v, ctx) => { painted.push([...ctx.objectIds]); return true; } });
  t.after(() => c.dispose()); c.pause('offline'); fill(c); await c.whenPainted(); painted.length = 0;
  c.ack({ actionId: 'outside-edit', revision: 1, changed: true, ops: [{ type: 'patch', id: 'outside', patch: { width: 20 } }] }, { paint: false });
  await c.whenPainted(); assert.equal(painted.flat().includes('outside'), false);
  assert.equal(c.getConfirmedState().snapshot.canvas.objects[1].width, 20);
});

test('cooperative checkpoint consumes the actual Board snapshot callback only after reconciliation', async t => {
  const { authorityFixture, createUiHarness } = await import('./notebook-ui-node-harness.mjs');
  const { authority } = await authorityFixture(base().snapshot.canvas.objects);
  const ui = await createUiHarness({ authority }); t.after(() => ui.close());
  const c = ui.scope.notebookControllerRef.current; c.pause('offline'); fill(c, 64); await c.whenPainted();
  const remote = snapshotWith('remote');
  let loaded; const load = ui.scope.loadCanvasJsonProgressively;
  ui.scope.loadCanvasJsonProgressively = (canvas, data) => { loaded = structuredClone(data); return load(canvas, data); };
  await ui.scope.applyAuthoritativeSnapshot(remote.snapshot, 1);
  // This assertion is about the snapshot actually installed by Board, before
  // any eventual authority rejection of the deliberately isolated test source.
  assert.equal(loaded.objects[0].notebookPages[0].some(o => o.boardObjectId === 'remote'), true, 'Board loaded pre-recovery state');
  assert.equal(ui.book()._objects.some(o => o.boardObjectId === 'remote'), true);
  assert.equal(ui.book()._objects.length, 65);
});

test('recovery retires restored pending markers for acknowledged objects before other intents finish', async t => {
  const initial = base(); initial.snapshot.canvas.objects.push({ ...initial.snapshot.canvas.objects[0], boardObjectId: 'second', notebookPages: [[]] });
  const actions = Array.from({ length: 128 }, (_, i) => ({ ...action(`saved-${i}`),
    ops: [{ ...insert(`saved-${i}`), id: i < 64 ? 'book' : 'second' }] }));
  const c = createNotebookBoardController({ confirmedState: initial, initialPendingActions: actions, publish: never, paint: async () => true });
  t.after(() => c.dispose()); c.pause('offline'); await c.whenPainted();
  const checkpoint = structuredClone(initial); checkpoint.revision = 64;
  checkpoint.acknowledgedActionIds = actions.slice(0, 64).map(a => a.actionId);
  checkpoint.snapshot.canvas.objects[0].notebookPages[0] = actions.slice(0, 64).map(a => a.ops[0].changes[0].object);
  await c.rebaseAsync(checkpoint); await c.whenPainted();
  assert.equal(c.pendingCount(), 64); assert.deepEqual([...c.pendingObjectIds()], ['second']);
});
