import test from 'node:test';
import assert from 'node:assert/strict';
import { createNotebookSession } from '../src/lib/notebookSession.js';
import { createNotebookBoardController } from '../src/lib/notebookBoardController.js';

const base = () => ({ revision: 0, snapshot: { version: 2, background: 'grid', canvas: { objects: [
  { type: 'BoardNotebook', boardObjectId: 'book', notebookPageNumber: 1, notebookPages: [[], []] },
] } } });
const insert = id => ({ type: 'notebook', version: 1, id: 'book', pageNumber: 1,
  changes: [{ type: 'insert', ifAbsent: true, object: { type: 'Path', boardObjectId: id, path: [['M', 0, 0], ['L', 2, 2]], stroke: '#111', fill: null } }] });
const actions = count => Array.from({ length: count }, (_, i) => ({ actionId: `saved-${i}`, clientId: 'writer', baseRevision: 0, ops: [insert(`ink-${i}`)] }));
const never = () => new Promise(() => {});
const task = () => new Promise(resolve => setTimeout(resolve, 0));
const pageIds = session => session.getState().snapshot.canvas.objects[0].notebookPages[0].map(x => x.boardObjectId);

function oracle(input) {
  const session = createNotebookSession({ confirmedState: base(), publish: never, initialPendingActions: input });
  session.pause('offline'); return session;
}

// Production change that makes this pass: restorePendingActions must yield between
// complete restored intents instead of replaying the entire durable queue inline.
test('cold pending restore admits a browser task and converges to the synchronous oracle', async t => {
  const input = actions(128), expected = oracle(input);
  const session = createNotebookSession({ confirmedState: base(), publish: never });
  t.after(() => { expected.dispose(); session.dispose(); });
  session.pause('offline');
  let observed = null;
  setTimeout(() => { observed = session.pendingCount(); }, 0);
  const restoring = session.restorePendingActions(input);
  assert.ok(session.pendingCount() < 128, 'restore replayed every durable intent synchronously');
  await task();
  assert.ok(observed !== null && observed < 128, `browser task ran only after ${observed} restored intents`);
  await restoring;
  assert.deepEqual(session.getState(), expected.getState());
  assert.deepEqual(session.exportPending(), expected.exportPending());
  assert.equal(session.pendingCount(), 128);
});

test('cancelled cold pending restore rolls back partial private work without removing durable actions', async t => {
  const removed = [], session = createNotebookSession({ confirmedState: base(), publish: never,
    outbox: { save: async () => { throw new Error('restored actions must not be resaved'); }, remove: async id => removed.push(id) } });
  t.after(() => session.dispose()); session.pause('offline');
  let current = true;
  setTimeout(() => { current = false; }, 0);
  await assert.rejects(session.restorePendingActions(actions(128), { isCurrent: () => current }), /cancel|closed|закрыт|отмен/i);
  assert.equal(session.pendingCount(), 0);
  assert.deepEqual(pageIds(session), []);
  assert.deepEqual(removed, []);
});

test('controller restores pending object ownership cooperatively before projection', async t => {
  const input = actions(96); let paints = 0;
  const controller = createNotebookBoardController({ confirmedState: base(), publish: never, paint: async () => { paints++; return true; } });
  t.after(() => controller.dispose()); controller.pause('offline');
  let taskPending = null; setTimeout(() => { taskPending = controller.pendingCount(); }, 0);
  await controller.restoreInitialPendingActions(input);
  await controller.whenPainted();
  assert.ok(taskPending !== null && taskPending < 96);
  assert.equal(controller.pendingCount(), 96);
  assert.equal(controller.pendingObjectIds().has('book'), true);
  assert.equal(paints, 1, 'restored notebook should project once, not once per durable action');
});

test('ordinary enqueue cannot interleave inside a cold durable restore', async t => {
  const session = createNotebookSession({ confirmedState: base(), publish: never });
  t.after(() => session.dispose()); session.pause('offline');
  const restoring = session.restorePendingActions(actions(96));
  assert.throws(() => session.enqueue({ actionId: 'live-during-restore', clientId: 'writer', ops: [insert('live-during-restore')] }), /restore|initial/i);
  await restoring;
  assert.deepEqual(pageIds(session), Array.from({ length: 96 }, (_, i) => `ink-${i}`));
});

test('flush during cold restore cannot publish a partial restored prefix', async () => {
  let sent=0;
  const session=createNotebookSession({confirmedState:base(),publish:()=>{sent++;return never();},canEdit:()=>true});
  const restoring=session.restorePendingActions(actions(96));
  const flushing=session.flush(); flushing.catch(()=>{});
  await task();
  assert.equal(sent,0,'sender published a partially restored durable prefix');
  await restoring;
  session.dispose();
  await assert.rejects(flushing,/disposed/);
});
