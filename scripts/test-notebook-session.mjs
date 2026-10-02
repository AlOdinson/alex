import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateAuthorityAction } from '../src/lib/authorityOperationEvaluator.js';
import { applyAuthorityOpsInPlace } from '../src/lib/authoritySnapshot.js';
import { updateNotebookTombstones } from '../src/lib/notebookOperations.js';
import { prepareAuthoritativeHistory } from '../src/lib/historyOperations.js';
const api = await import('../src/lib/notebookSession.js').catch(() => ({}));
const make = options => {
  assert.equal(typeof api.createNotebookSession, 'function', 'missing ordered notebook session');
  return api.createNotebookSession(options);
};
const baseline = (pages = 20) => ({ revision: 0, snapshot: { version: 2, background: 'grid', canvas: { objects: [
  { type: 'BoardNotebook', boardObjectId: 'book', left: 10, notebookPageNumber: pages,
    notebookPages: Array.from({ length: pages }, () => []) },
] } } });
const stroke = id => ({ type: 'Path', boardObjectId: id, path: [['M', 0, 0], ['L', 5, 8]], stroke: 'black' });
const insert = (id, pageNumber = 20) => ({ type: 'notebook', version: 1, id: 'book', pageNumber,
  changes: [{ type: 'insert', object: stroke(id), ifAbsent: true }] });
const action = (id, pageNumber = 20) => ({ actionId: id, clientId: 'teacher', ops: [insert(id, pageNumber)] });
const children = (session, page = 20) => session.getState().snapshot.canvas.objects[0]?.notebookPages[page - 1] ?? [];
const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function server(initial = baseline()) {
  let state = structuredClone(initial), tombstones = {}, notebookTombstones = {};
  const outcomes = new Map();
  return { state: () => ({ ...structuredClone(state), tombstones, notebookTombstones }), commit(input) {
    if (outcomes.has(input.actionId)) return { ...outcomes.get(input.actionId), duplicate: true };
    const result = evaluateAuthorityAction({ snapshot: state.snapshot, notebookVersion: 1, tombstones,
      notebookTombstones, ...input });
    const history = prepareAuthoritativeHistory(state.snapshot, result.appliedOps, result.appliedBackground, input);
    if (result.changed) {
      state.revision++;
      applyAuthorityOpsInPlace(state.snapshot, history.appliedOps, result.appliedBackground);
      notebookTombstones = updateNotebookTombstones(notebookTombstones, history.appliedOps, { ...input, revision: state.revision });
    }
    const output = { actionId: input.actionId, clientId: input.clientId, revision: state.revision,
      ops: history.appliedOps, changed: result.changed, background: result.appliedBackground,
      historyInverseOps: history.historyInverseOps, skippedConflicts: result.skippedConflicts };
    outcomes.set(input.actionId, output); return structuredClone(output);
  } };
}

test('300 rapid strokes appear before acknowledgements and reverse acknowledgements converge once each', async () => {
  const authority = server(), replies = [], published = [], changes = [];
  const session = make({ confirmedState: baseline(), clientId: 'teacher', maxInFlight: 300,
    publish: input => { published.push(input.actionId); const result = authority.commit(input);
      return new Promise(resolve => replies.push(() => resolve(result))); },
    onChange: (state, event) => changes.push([state.revision, event.pendingCount]) });
  const handles = Array.from({ length: 300 }, (_, i) => session.enqueue(action(`ink-${i}`)));
  assert.equal(children(session).length, 300);
  assert.equal(session.pendingCount(), 300);
  assert.equal(session.getConfirmedState().revision, 0);
  await tick(); assert.equal(replies.length, 300);
  assert.deepEqual(published, handles.map(handle => handle.actionId));
  for (const reply of replies.reverse()) { reply(); await tick(); }
  await session.flush();
  assert.equal(session.pendingCount(), 0);
  assert.deepEqual(session.getState().snapshot.canvas, authority.state().snapshot.canvas);
  assert.equal(new Set(children(session).map(child => child.boardObjectId)).size, 300);
  assert.equal(session.getConfirmedState().revision, 300);
  assert.ok(changes.some(([, pending]) => pending === 300)); session.dispose();
});

test('middle rejection removes only that stroke and preserves subsequent independent input', async () => {
  const authority = server();
  const session = make({ confirmedState: baseline(), clientId: 'teacher', publish: input => input.actionId === 'bad'
    ? { actionId: 'bad', revision: authority.state().revision, changed: false, ops: [], skippedConflicts: [{ reason: 'lease_lost' }] }
    : authority.commit(input) });
  const first = session.enqueue(action('first')), bad = session.enqueue(action('bad')), last = session.enqueue(action('last'));
  assert.equal(children(session).length, 3);
  await assert.rejects(bad.settled, error => error.code === 'notebook_action_rejected');
  await Promise.all([first.settled, last.settled]); await session.flush();
  assert.deepEqual(children(session).map(child => child.boardObjectId), ['first', 'last']); session.dispose();
});

test('undo before initial ack remains ordered and redo uses the authoritative deletion identity', async () => {
  const authority = server(); let release;
  const session = make({ confirmedState: baseline(), clientId: 'teacher', maxInFlight: 1,
    publish: async input => { if (input.actionId === 'add') await new Promise(resolve => { release = resolve; }); return authority.commit(input); } });
  const added = session.enqueue(action('add'));
  const undone = session.enqueue({ actionId: 'undo', ops: added.inverseOps });
  assert.equal(children(session).length, 0);
  await tick(); release(); await added.settled;
  const result = await undone.settled;
  const redo = session.enqueue({ actionId: 'redo', ops: result.historyInverseOps });
  await redo.settled; await session.flush();
  assert.deepEqual(children(session).map(child => child.boardObjectId), ['add']); session.dispose();
});

test('page navigation never retargets an already-enqueued stroke', async () => {
  const authority = server(); const session = make({ confirmedState: baseline(), clientId: 'teacher', publish: input => authority.commit(input) });
  session.enqueue(action('old-page', 19));
  session.enqueue({ actionId: 'navigate', ops: [{ type: 'patch', id: 'book', patch: { notebookPageNumber: 1 } }] });
  session.enqueue(action('new-page', 1)); await session.flush();
  assert.deepEqual(children(session, 19).map(c => c.boardObjectId), ['old-page']);
  assert.deepEqual(children(session, 1).map(c => c.boardObjectId), ['new-page']);
  assert.equal(session.getState().snapshot.canvas.objects[0].notebookPageNumber, 1); session.dispose();
});

test('disconnect after durable server commit keeps intent and retries the same identity after rebase', async () => {
  const authority = server(); let disconnected = true; const sent = [];
  const session = make({ confirmedState: baseline(), clientId: 'teacher', maxInFlight: 1,
    publish: input => { sent.push(structuredClone(input)); const result = authority.commit(input);
      if (disconnected) throw new Error('connection interrupted after commit'); return result; } });
  const handle = session.enqueue(action('retry'));
  await assert.rejects(session.flush(), /connection interrupted/);
  assert.equal(session.pendingCount(), 1); assert.equal(children(session).length, 1);
  disconnected = false; session.rebase(authority.state()); session.resume();
  await handle.settled; await session.flush();
  assert.equal(authority.state().revision, 1); assert.equal(children(session).length, 1);
  assert.equal(sent.length, 2); assert.deepEqual(sent[0], sent[1]); session.dispose();
});

test('lease loss preserves the unsent queue and blocks new writes until resumed', async () => {
  const authority = server(); let lease = true; const sent = [];
  const session = make({ confirmedState: baseline(), clientId: 'teacher', maxInFlight: 1, canEdit: () => lease,
    publish: input => { sent.push(input.actionId); return authority.commit(input); } });
  session.pause('temporary transport pause'); const handle = session.enqueue(action('waiting'));
  lease = false; session.resume(); await assert.rejects(session.flush(), /lease/i);
  assert.equal(session.pendingCount(), 1); assert.deepEqual(sent, []);
  assert.throws(() => session.enqueue(action('not-allowed')), /lease/i);
  lease = true; session.resume(); await handle.settled; await session.flush(); assert.deepEqual(sent, ['waiting']); session.dispose();
});

test('parent deletion during rebase cannot leave an outside split fragment or discard recoverable intent', async () => {
  const session = make({ confirmedState: baseline(), clientId: 'teacher', publish: () => { throw new Error('must not publish'); } });
  session.pause('offline'); session.enqueue({ actionId: 'split', ops: [insert('inside'), { type: 'upsert', object: { type: 'Path', boardObjectId: 'outside', path: [] } }] });
  session.rebase({ revision: 1, snapshot: { version: 2, background: 'grid', canvas: { objects: [] } } });
  assert.equal(session.getState().snapshot.canvas.objects.length, 0);
  assert.equal(session.pendingCount(), 1);
  assert.equal(session.exportPending()[0].ops.length, 2);
  session.resume(); await assert.rejects(session.flush(), /blocked|missing/i); session.dispose();
});

test('bounded queue rejects new input before changing the preview and never mutates caller operations', async () => {
  const session = make({ confirmedState: baseline(), clientId: 'teacher', maxPending: 2, maxPendingBytes: 2000, publish: () => new Promise(() => {}) });
  session.pause('test'); const input = action('immutable'); session.enqueue(input); input.ops[0].changes[0].object.path[0][1] = 999;
  session.enqueue(action('two'));
  assert.throws(() => session.enqueue(action('overflow')), error => error.code === 'notebook_queue_full');
  assert.equal(children(session).length, 2); assert.equal(children(session)[0].path[0][1], 0);
  assert.equal(session.exportPending()[0].ops[0].changes[0].object.path[0][1], 0);
  const retained = session.dispose(); assert.equal(retained.length, 2);
  assert.throws(() => session.enqueue(action('disposed')), /disposed/i);
});

test('late or duplicate acknowledgements and observer errors cannot resurrect strokes', async () => {
  const authority = server(); let last; const observed = [];
  const session = make({ confirmedState: baseline(), clientId: 'teacher',
    publish: input => (last = authority.commit(input)), onChange: () => { throw new Error('view failed'); }, onError: error => observed.push(error.message) });
  await session.enqueue(action('one')).settled; await session.flush();
  session.ack(last); session.ack(last);
  assert.equal(children(session).length, 1); assert.equal(session.pendingCount(), 0);
  const older = baseline(); session.rebase(older); assert.equal(children(session).length, 1);
  session.dispose(); session.ack(last); assert.ok(observed.includes('view failed'));
});

test('pending intents survive dispose/reload via an outbox and are removed only after confirmation', async () => {
  const records = new Map(); const authority = server(); let unblock;
  const outbox = { async save(input) { await new Promise(resolve => { unblock = resolve; }); records.set(input.actionId, structuredClone(input)); },
    async remove(id) { records.delete(id); } };
  const session = make({ confirmedState: baseline(), clientId: 'teacher', outbox, publish: () => { throw new Error('not before durable save'); } });
  session.pause('offline'); const handle = session.enqueue(action('durable'));
  assert.equal(children(session).length, 1); await tick(); unblock(); await handle.durable;
  assert.equal(records.size, 1); session.dispose(); assert.equal(records.size, 1);
  const restored = make({ confirmedState: baseline(), clientId: 'teacher', initialPendingActions: [...records.values()],
    outbox: { save: async input => records.set(input.actionId, input), remove: outbox.remove }, publish: input => authority.commit(input) });
  await restored.flush(); assert.equal(records.size, 0); assert.equal(children(restored).length, 1); restored.dispose();
});

test('outbox storage failure retains visible input, blocks transmission and can be retried', async () => {
  const authority = server(); let fail = true, sends = 0;
  const session = make({ confirmedState: baseline(), clientId: 'teacher', outbox: {
    save: async () => { if (fail) throw new Error('quota temporarily unavailable'); }, remove: async () => {} },
    publish: input => { sends++; return authority.commit(input); } });
  const handle = session.enqueue(action('not-saved-yet'));
  await assert.rejects(session.flush(), /quota/); assert.equal(sends, 0); assert.equal(children(session).length, 1);
  assert.equal(session.pendingCount(), 1); fail = false; session.resume(); await handle.settled; await session.flush();
  assert.equal(sends, 1); session.dispose();
});

test('future protocol acknowledgements do not remove durable intents or advance the confirmed revision', async () => {
  const session = make({ confirmedState: baseline(), clientId: 'teacher', publish: () => new Promise(() => {}) });
  session.enqueue(action('future'));
  assert.throws(() => session.ack({ actionId: 'future', revision: 1, notebookVersion: 2, ops: [insert('future')] }), /update|version|обнов/i);
  assert.equal(session.pendingCount(), 1); assert.equal(session.getConfirmedState().revision, 0); session.dispose();
});

test('mixed baseline objects stay immutable and a frame undo cannot erase pending ink', async () => {
  const initial = baseline(); initial.snapshot.canvas.objects.push({ type: 'Textbox', boardObjectId: 'title', text: 'Lesson' });
  const authority = server(initial);
  const session = make({ confirmedState: initial, clientId: 'teacher', publish: input => authority.commit(input) });
  session.enqueue(action('ink'));
  const moved = session.enqueue({ actionId: 'move', ops: [{ type: 'patch', id: 'book', patch: { left: 90 } }] });
  session.enqueue({ actionId: 'undo-move', ops: moved.inverseOps });
  await session.flush(); assert.equal(children(session).length, 1);
  assert.equal(session.getState().snapshot.canvas.objects[0].left, 10);
  assert.equal(session.getState().snapshot.canvas.objects[1].text, 'Lesson'); session.dispose();
});

test('repeated buffered commit with changed delivery metadata is not a revision conflict', async () => {
  const authority = server(); const session = make({ confirmedState: baseline(), clientId: 'teacher', publish: () => new Promise(() => {}) });
  session.pause('manual ack'); const h1 = session.enqueue(action('1')), h2 = session.enqueue(action('2'));
  const a = authority.commit(session.exportPending()[0]), b = authority.commit(session.exportPending()[1]);
  session.ack(b); session.ack({ ...b, duplicate: true }); session.ack(a);
  await Promise.all([h1.settled, h2.settled]); assert.equal(children(session).length, 2); session.dispose();
});

test('enqueue and ordered confirmations do not clone a full notebook after initial load', async () => {
  const initial = baseline(); initial.snapshot.canvas.objects[0].notebookPages.slice(0, 19).forEach((page, p) => {
    page.push(...Array.from({ length: 50 }, (_, i) => stroke(`hidden-${p}-${i}`)));
  });
  const authority = server(initial); const replies = [];
  const session = make({ confirmedState: initial, clientId: 'teacher', maxInFlight: 1,
    publish: input => { const result = authority.commit(input); return new Promise(resolve => replies.push(() => resolve(result))); } });
  const original = globalThis.structuredClone;
  globalThis.structuredClone = input => {
    assert.equal(Boolean(input?.notebookPages || input?.canvas?.objects || input?.snapshot?.canvas?.objects), false, 'full snapshot clone in stroke hot path');
    return original(input);
  };
  try {
    for (let i = 0; i < 50; i++) session.enqueue(action(`fresh-${i}`));
    for (let i = 0; i < 50; i++) { await tick(); replies.shift()(); await tick(); }
    await session.flush(); assert.equal(children(session).length, 50);
  } finally { globalThis.structuredClone = original; session.dispose(); }
});

test('authority lock rejection cannot be misreported as a successful no-op', async () => {
  const session=make({confirmedState:baseline(),clientId:'teacher',publish:input=>({actionId:input.actionId,revision:0,changed:false,
    appliedOps:[],rejectedObjectIds:['book'],skippedConflicts:[]})});
  await assert.rejects(session.enqueue(action('denied')).settled,error=>error.code==='notebook_action_rejected');
  assert.equal(children(session).length,0);session.dispose();
});

test('durable saves retain intent order even when the first storage transaction is slow', async () => {
  const calls=[],records=[];let release;
  const session=make({confirmedState:baseline(),clientId:'teacher',outbox:{
    save:async input=>{calls.push(input.actionId);if(input.actionId==='first')await new Promise(r=>{release=r;});records.push(input.actionId);},remove:async()=>{}},
    publish:()=>{throw new Error('offline');}});
  session.pause('offline');const first=session.enqueue(action('first')),second=session.enqueue(action('second'));
  await tick();assert.deepEqual(calls,['first'],'a later save must not overtake the first intent on disk');
  release();await Promise.all([first.durable,second.durable]);assert.deepEqual(records,['first','second']);session.dispose();
});
