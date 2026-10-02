import test from 'node:test';
import assert from 'node:assert/strict';
import { isAuthoritativeBoardOperation, operationObjectIds } from '../src/lib/operationProtocol.js';
import { applyAuthorityOpsInPlace } from '../src/lib/authoritySnapshot.js';
import { evaluateAuthorityAction } from '../src/lib/authorityOperationEvaluator.js';
import { prepareAuthoritativeHistory, isConditionalHistoryOperation, refreshHistoryOps } from '../src/lib/historyOperations.js';

// These assertions must fail without the production child-operation implementation.
const api = await import('../src/lib/notebookOperations.js').catch(() => ({}));
const stroke = (id = 'ink') => ({ type: 'Path', boardObjectId: id, path: Array.from({ length: 40 }, (_, i) => [i ? 'L' : 'M', i, i * 2]), stroke: '#123456', strokeWidth: 3, updatedAt: 1, updatedBy: 'teacher' });
const book = (pages = 1) => ({ type: 'BoardNotebook', boardObjectId: 'book', left: 10, top: 20, scaleX: 1, notebookPageNumber: pages, notebookPages: Array.from({ length: pages }, () => []) });
const snapshot = (notebook, rest = []) => ({ version: 2, background: 'grid', canvas: { objects: [notebook, ...rest] } });
const op = (changes, pageNumber = 1, extra = {}) => ({ type: 'notebook', version: 1, id: 'book', pageNumber, changes, updatedAt: 2, updatedBy: 'teacher', ...extra });
const insert = (object = stroke(), zIndex = 0) => ({ type: 'insert', object, zIndex, ifAbsent: true });
const evaluate = (value) => evaluateAuthorityAction({ notebookVersion: 1, ...value });
const ctx = { clientId: 'teacher', actionId: 'write-1', mutationId: 'write-1' };

function requireApi() {
  for (const name of ['isNotebookOperation', 'applyNotebookOperation', 'evaluateNotebookOperation', 'invertNotebookOperation', 'updateNotebookTombstones', 'notebookChildKey']) {
    assert.equal(typeof api[name], 'function', `missing notebook API: ${name}`);
  }
  return api;
}

test('child operations validate their version and address only the parent lease', () => {
  const operation = op([insert()]);
  assert.equal(isAuthoritativeBoardOperation(operation), true);
  assert.deepEqual([...operationObjectIds([operation])], ['book']);
  assert.equal(isConditionalHistoryOperation(operation), true);
  for (const bad of [op([], 1), op([insert()], 0), op([insert()], 1, { version: 2 }), op([insert()], 1.5), op([insert()], 1, { id: '' }), op([{ type: 'patch', id: 'ink', patch: [] }])]) {
    assert.equal(isAuthoritativeBoardOperation(bad), false, JSON.stringify(bad));
  }
});

test('notebook proposals remain explicitly blocked until the rollout capability is enabled', () => {
  const result = evaluateAuthorityAction({ snapshot: snapshot(book()), ops: [op([insert()])] });
  assert.equal(result.changed, false);
  assert.ok(result.skippedConflicts.some(item => item.reason === 'notebook_protocol_disabled'));
});

test('one page-20 insertion and inverse do not visit any hidden child or mutate before records', () => {
  const { applyNotebookOperation, invertNotebookOperation } = requireApi();
  const notebook = book(20);
  for (let i = 0; i < 19; i += 1) {
    notebook.notebookPages[i] = new Proxy([stroke(`hidden-${i}`)], { get(target, key, receiver) {
      if (key === '0' || key === 'toJSON' || key === Symbol.iterator) throw new Error('hidden child visited');
      return Reflect.get(target, key, receiver);
    } });
  }
  const before = { ...notebook };
  const pagesBefore = notebook.notebookPages;
  const operation = op([insert()], 20);
  const inverse = invertNotebookOperation(before, operation, ctx);
  const applied = applyNotebookOperation(notebook, operation);
  assert.equal(applied.changed, true);
  assert.deepEqual(applied.changedChildIds, ['ink']);
  assert.equal(notebook.notebookPageNumber, 20);
  assert.equal(notebook.notebookPages[0], pagesBefore[0]);
  assert.equal(pagesBefore[19].length, 0);
  assert.equal(notebook.notebookPages[19][0].boardObjectId, 'ink');
  for (const value of [operation, inverse]) assert.ok(Buffer.byteLength(JSON.stringify(value)) <= 16_384);
  operation.changes[0].object.path[0][1] = 999;
  assert.equal(notebook.notebookPages[19][0].path[0][1], 0, 'wire payload is not mutable model storage');
});

test('payload size does not grow with hidden page count', () => {
  const { invertNotebookOperation } = requireApi();
  const sizes = [1, 6, 12, 20].map(pages => {
    const notebook = book(pages);
    notebook.notebookPages.forEach(page => page.push(...Array.from({ length: 300 }, (_, i) => stroke(`old-${i}`))));
    const operation = op([insert(stroke('new'), 300)], pages);
    return [Buffer.byteLength(JSON.stringify(operation)), Buffer.byteLength(JSON.stringify(invertNotebookOperation(notebook, operation, ctx)))];
  });
  for (const pair of sizes) pair.forEach((bytes, i) => assert.ok(bytes <= 16_384 && bytes <= sizes[0][i] * 1.05));
});

test('inactive-page delta leaves visible page selection and unrelated records unchanged', () => {
  const { applyNotebookOperation } = requireApi();
  const notebook = book(2); const visible = notebook.notebookPages[1];
  applyNotebookOperation(notebook, op([insert()], 1));
  assert.equal(notebook.notebookPageNumber, 2);
  assert.equal(notebook.notebookPages[1], visible);
});

test('whole text edits and their compact inverses preserve concurrent unrelated fields', () => {
  const { applyNotebookOperation, invertNotebookOperation, evaluateNotebookOperation } = requireApi();
  const notebook = book();
  notebook.notebookPages[0] = [{ type: 'Textbox', boardObjectId: 'text', text: 'before', fill: 'black' }];
  const change = op([{ type: 'patch', id: 'text', patch: { text: 'after' }, ifFields: { text: 'before' } }]);
  const inverse = invertNotebookOperation(notebook, change, ctx);
  applyNotebookOperation(notebook, change);
  applyNotebookOperation(notebook, op([{ type: 'patch', id: 'text', patch: { fill: 'blue' } }], 1, { updatedAt: 3 }));
  for (const undo of inverse) {
    const result = evaluateNotebookOperation(notebook, undo, {});
    assert.deepEqual(result.skippedConflicts, []);
    applyNotebookOperation(notebook, { ...undo, changes: result.appliedChanges });
  }
  assert.equal(notebook.notebookPages[0][0].type, 'Textbox');
  assert.equal(notebook.notebookPages[0][0].text, 'before');
  assert.equal(notebook.notebookPages[0][0].fill, 'blue');
  assert.ok(!JSON.stringify(inverse).includes('notebookPages'));
});

test('delete restoration is fenced by both deleting client and mutation', () => {
  const { applyNotebookOperation, invertNotebookOperation, evaluateNotebookOperation, updateNotebookTombstones } = requireApi();
  const notebook = book(); notebook.notebookPages[0] = [stroke()];
  const deletion = op([{ type: 'delete', id: 'ink', ifObjectVersion: structuredClone(notebook.notebookPages[0][0]) }]);
  const inverse = invertNotebookOperation(notebook, deletion, ctx);
  applyNotebookOperation(notebook, deletion);
  const tombstones = updateNotebookTombstones({}, [deletion], ctx);
  assert.equal(evaluateNotebookOperation(notebook, inverse[0], tombstones).changed, true);
  const later = updateNotebookTombstones({}, [deletion], { ...ctx, actionId: 'later', mutationId: 'later' });
  assert.equal(evaluateNotebookOperation(notebook, inverse[0], later).changed, false);
  assert.equal(evaluateNotebookOperation(notebook, op([insert()]), tombstones).changed, false, 'ordinary insert must not resurrect a deleted identity');
  assert.equal(evaluateNotebookOperation(notebook, inverse[0], {}).changed, false);
});

test('delete guards detect a newly added child field rather than erasing somebody else’s update', () => {
  const { evaluateNotebookOperation } = requireApi();
  const notebook = book(); notebook.notebookPages[0] = [stroke()];
  const deletion = op([{ type: 'delete', id: 'ink', ifObjectVersion: structuredClone(notebook.notebookPages[0][0]) }]);
  notebook.notebookPages[0][0].opacity = 0.4;
  assert.equal(evaluateNotebookOperation(notebook, deletion, {}).changed, false);
});

test('accepted deltas replay deterministically and repeat delivery never duplicates a child', () => {
  const notebook = book(); const state = snapshot(notebook);
  const operation = op([insert()]);
  const result = evaluate({ snapshot: state, ops: [operation] });
  assert.equal(result.changed, true);
  applyAuthorityOpsInPlace(state, result.appliedOps, null, 12);
  applyAuthorityOpsInPlace(state, result.appliedOps, null, 12);
  assert.equal(state.canvas.objects[0].notebookPages[0].length, 1);
});

test('atomic split preflight simulates dependent child and outside-fragment operations in order', () => {
  const notebook = book(); const original = JSON.stringify(notebook);
  const operations = [
    op([insert()], 1, { atomicGroup: 'split' }),
    op([{ type: 'patch', id: 'ink', patch: { stroke: 'green' }, ifFields: { stroke: '#123456' } }], 1, { atomicGroup: 'split' }),
    { type: 'upsert', object: { boardObjectId: 'outside', left: 5 }, atomicGroup: 'split' },
    { type: 'patch', id: 'outside', patch: { left: 8 }, ifFields: { left: 5 }, atomicGroup: 'split' },
  ];
  const result = evaluate({ snapshot: snapshot(notebook), ops: operations });
  assert.equal(result.appliedOps.length, 4);
  assert.deepEqual(result.skippedConflicts, []);
  assert.equal(JSON.stringify(notebook), original, 'preflight must not mutate the live model');
  const state = snapshot(notebook);
  applyAuthorityOpsInPlace(state, result.appliedOps);
  assert.equal(state.canvas.objects[0].notebookPages[0][0].stroke, 'green');
  assert.equal(state.canvas.objects[1].left, 8);
});

test('a conflict in any split member rejects the whole group without leaking staged changes', () => {
  const notebook = book(); const state = snapshot(notebook, [{ boardObjectId: 'outside', left: 99 }]);
  const before = JSON.stringify(state);
  const operations = [op([insert()], 1, { atomicGroup: 'split' }), { type: 'delete', id: 'outside', ifObjectVersion: { left: 5 }, atomicGroup: 'split' }];
  const result = evaluate({ snapshot: state, ops: operations });
  assert.equal(result.changed, false);
  assert.deepEqual(result.appliedOps, []);
  assert.equal(JSON.stringify(state), before);
});

test('interleaved group conflicts cannot leave the first half of a split applied', () => {
  const state = snapshot(book(), [{ boardObjectId: 'outside', left: 5 }]);
  const operations = [op([insert()], 1, { atomicGroup: 'split' }), { type: 'patch', id: 'outside', patch: { left: 99 } }, { type: 'delete', id: 'outside', ifObjectVersion: { left: 5 }, atomicGroup: 'split' }];
  const result = evaluate({ snapshot: state, ops: operations });
  assert.equal(result.appliedOps.length, 1);
  assert.equal(result.appliedOps[0].type, 'patch');
});

test('authoritative history remains compact and cannot overwrite strokes when frame geometry changes', () => {
  const notebook = book(20); notebook.notebookPages[19] = [stroke('old')];
  const state = snapshot(notebook);
  const input = [op([insert(stroke('new'), 1)], 20, { atomicGroup: 'split' }), { type: 'transform', objects: [{ id: 'book', transform: { left: 30 }, ifTransform: { left: 10 } }], atomicGroup: 'split' }];
  const result = evaluate({ snapshot: state, ops: input });
  const history = prepareAuthoritativeHistory(state, result.appliedOps, null, ctx);
  assert.ok(history.historyInverseOps.some(item => item.type === 'notebook'));
  assert.ok(!JSON.stringify(history.historyInverseOps).includes('notebookPages'));
  assert.ok(history.historyInverseOps.every(item => item.atomicGroup === 'split'));
  assert.equal(notebook.left, 10);
  assert.equal(notebook.notebookPages[19].length, 1);
  applyAuthorityOpsInPlace(state, history.appliedOps);
  const undo = evaluate({ snapshot: state, ops: history.historyInverseOps });
  assert.deepEqual(undo.skippedConflicts, []);
  applyAuthorityOpsInPlace(state, undo.appliedOps);
  assert.equal(state.canvas.objects[0].left, 10);
  assert.deepEqual(state.canvas.objects[0].notebookPages[19].map(child => child.boardObjectId), ['old']);
});

test('authoritative inverse preparation never traverses hidden notebook children', () => {
  const notebook = book(20);
  notebook.notebookPages[0] = [{ get boardObjectId() { throw new Error('hidden child traversed'); } }];
  const operation = op([insert()], 20);
  const result = evaluate({ snapshot: snapshot(notebook), ops: [operation] });
  const history = prepareAuthoritativeHistory(snapshot(notebook), result.appliedOps, null, ctx);
  assert.equal(history.historyInverseOps[0]?.type, 'notebook');
  assert.ok(Buffer.byteLength(JSON.stringify(history.historyInverseOps)) < 16_384);
});

test('history refresh stamps child operations without modifying retained guards', () => {
  const source = op([{ type: 'patch', id: 'ink', patch: { stroke: 'red' }, ifFields: { stroke: 'blue' } }]);
  const before = JSON.stringify(source);
  const [next] = refreshHistoryOps([source], 'student', 100);
  assert.equal(next.updatedBy, 'student');
  assert.ok(next.updatedAt > 100);
  assert.deepEqual(next.changes[0].ifFields, { stroke: 'blue' });
  assert.equal(JSON.stringify(source), before);
});

test('invalid pages, nested notebooks, identity patches and prototype keys are rejected', () => {
  const { isNotebookOperation, evaluateNotebookOperation } = requireApi();
  assert.equal(evaluateNotebookOperation(book(), op([insert()], 1000000), {}).changed, false);
  for (const change of [insert({ ...stroke(), type: 'BoardNotebook', notebookPages: [[]] }), insert({ ...stroke(), type: 'BoardMedia', mediaKind: 'pdf' }), { type: 'patch', id: 'ink', patch: { boardObjectId: 'stolen' } }, { type: 'patch', id: 'ink', patch: JSON.parse('{"__proto__":{"polluted":true}}') }]) {
    assert.equal(isNotebookOperation(op([change])), false);
  }
  assert.equal({}.polluted, undefined);
});

test('atomic staged dependencies replay in the same order even when an inserted board fragment requests a layer', () => {
  const state = snapshot(book());
  const operations = [
    { type: 'upsert', object: { type: 'Rect', boardObjectId: 'outside', fill: 'red' }, zIndex: 1, reorder: true, atomicGroup: 'split' },
    { type: 'patch', id: 'outside', patch: { fill: 'blue' }, ifFields: { fill: 'red' }, atomicGroup: 'split' },
    op([insert()], 1, { atomicGroup: 'split' }),
  ];
  const result = evaluate({ snapshot: state, ops: operations });
  assert.deepEqual(result.skippedConflicts, []);
  applyAuthorityOpsInPlace(state, result.appliedOps);
  assert.equal(state.canvas.objects.find(object => object.boardObjectId === 'outside').fill, 'blue');
  assert.equal(state.canvas.objects[0].notebookPages[0].length, 1);
});

test('history keeps each deletion mutation when multiple page operations are merged', () => {
  const notebook = book(); notebook.notebookPages[0] = [stroke('first'), stroke('second')];
  const state = snapshot(notebook);
  const operations = [op([{ type: 'delete', id: 'first' }], 1, { mutationId: 'delete-first' }),
    op([{ type: 'delete', id: 'second' }], 1, { mutationId: 'delete-second' })];
  const result = evaluate({ snapshot: state, ops: operations, ...ctx });
  const history = prepareAuthoritativeHistory(state, result.appliedOps, null, ctx);
  const tombstones = api.updateNotebookTombstones({}, result.appliedOps, ctx);
  applyAuthorityOpsInPlace(state, result.appliedOps);
  const undo = evaluate({ snapshot: state, notebookTombstones: tombstones, ops: history.historyInverseOps, ...ctx });
  assert.deepEqual(undo.skippedConflicts, []);
  applyAuthorityOpsInPlace(state, undo.appliedOps);
  assert.deepEqual(state.canvas.objects[0].notebookPages[0].map(child => child.boardObjectId), ['first', 'second']);
});

test('unrelated operations do not traverse child tombstone storage', () => {
  const existing = new Proxy({}, { ownKeys() { throw new Error('unrelated tombstones traversed'); } });
  assert.equal(api.updateNotebookTombstones(existing, [{ type: 'patch', id: 'frame', patch: { left: 20 } }]), existing);
  const result = api.evaluateNotebookOperation(book(), op([insert()]), existing, ctx);
  assert.equal(result.changed, true);
});

test('delete plus restore of one identity can undo its type and child layer atomically', () => {
  const notebook = book(); notebook.notebookPages[0] = [stroke('first'), stroke('second')];
  const original = structuredClone(notebook.notebookPages[0]);
  const state = snapshot(notebook);
  const replacement = { type: 'Textbox', boardObjectId: 'first', text: 'replacement', updatedAt: 1, updatedBy: 'teacher' };
  const operations = [op([
    { type: 'delete', id: 'first', mutationId: 'replace' },
    { type: 'insert', object: replacement, zIndex: 1, ifAbsent: true, ifDeletedBy: 'teacher', ifDeletedMutationId: 'replace' },
  ], 1, { atomicGroup: 'replace' })];
  const result = evaluate({ snapshot: state, ops: operations, ...ctx });
  assert.deepEqual(result.skippedConflicts, []);
  const history = prepareAuthoritativeHistory(state, result.appliedOps, null, ctx);
  const tombstones = api.updateNotebookTombstones({}, result.appliedOps, ctx);
  applyAuthorityOpsInPlace(state, result.appliedOps);
  const undo = evaluate({ snapshot: state, notebookTombstones: tombstones, ops: history.historyInverseOps, ...ctx });
  assert.deepEqual(undo.skippedConflicts, []);
  applyAuthorityOpsInPlace(state, undo.appliedOps);
  const comparable = children => children.map(({ updatedAt, updatedBy, ...child }) => child);
  assert.deepEqual(comparable(state.canvas.objects[0].notebookPages[0]), comparable(original));
});

async function authorityFixture(initial) {
  const { openBrowserBoardAuthority } = await import('../src/lib/browserBoardAuthority.js');
  const commits = [], outcomes = new Map();
  const service = await openBrowserBoardAuthority({
    boardId: 'notebook-core',
    loadBoard: async () => ({ boardId: 'notebook-core', revision: 0, snapshotRevision: 0, snapshot: initial, tombstones: {} }),
    loadCommitsAfter: async () => [], loadActionOutcome: async (_, key) => outcomes.get(key),
    persistCommit: async (_, commit) => { commits.push(commit); return { commit, duplicate: false }; },
    persistNoopOutcome: async (_, result) => { outcomes.set(result.actionId, result); return { result, duplicate: false }; },
    saveSnapshot: async () => {},
  });
  return { service, commits };
}

test('authority passes action identity into dependent compound preflight', async () => {
  const old = { type: 'Rect', boardObjectId: 'outside', fill: 'red' };
  const { service, commits } = await authorityFixture(snapshot(book(), [old]));
  const result = await service.commitAction({ actionId: 'replace-outside', clientId: 'teacher', baseRevision: 0, ops: [
    { type: 'delete', id: 'outside', mutationId: 'delete-outside', atomicGroup: 'replace' },
    { type: 'upsert', object: { ...old, fill: 'blue' }, ifDeletedBy: 'teacher', ifDeletedMutationId: 'delete-outside', atomicGroup: 'replace' },
  ] });
  assert.equal(result.changed, true);
  assert.equal(commits.length, 1);
  assert.equal(service.getSnapshot().canvas.objects.find(object => object.boardObjectId === 'outside').fill, 'blue');
});

test('production authority refuses forged activation and persists no notebook journal entry', async () => {
  const initial = snapshot(book());
  const { service, commits } = await authorityFixture(initial);
  const proposal = { actionId: 'forged-activation', clientId: 'student', baseRevision: 0, notebookVersion: 1, ops: [op([insert()])] };
  const result = await service.commitAction(proposal);
  assert.equal(result.changed, false);
  assert.ok(result.skippedConflicts.some(item => item.reason === 'notebook_protocol_disabled'));
  assert.equal(commits.length, 0);
  assert.equal(service.getRevision(), 0);
  assert.equal((await service.commitAction(proposal)).duplicate, true);
  assert.deepEqual(service.getSnapshot().canvas.objects, initial.canvas.objects);
});

test('seeded mixed child edits survive full undo and redo with changing mutation identities', () => {
  const notebook = book(20); notebook.notebookPages.forEach((page, i) => page.push(stroke(`original-${i}`)));
  const state = snapshot(notebook);
  const comparable = value => JSON.parse(JSON.stringify(value, (key, item) => ['updatedAt', 'updatedBy', 'savedAt'].includes(key) ? undefined : item));
  const initial = comparable(state.canvas.objects);
  let tombstones = {}, clock = 10, seed = 937;
  const random = max => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed % max; };
  const commit = operations => {
    const context = { clientId: 'teacher', actionId: `action-${++clock}` };
    const result = evaluate({ snapshot: state, ops: refreshHistoryOps(operations, context.clientId, clock), notebookTombstones: tombstones, ...context });
    assert.deepEqual(result.skippedConflicts, []);
    const history = prepareAuthoritativeHistory(state, result.appliedOps, null, context);
    tombstones = api.updateNotebookTombstones(tombstones, history.appliedOps, context);
    applyAuthorityOpsInPlace(state, history.appliedOps);
    return history.historyInverseOps;
  };
  const inverses = [];
  for (let i = 0; i < 60; i++) {
    const pageNumber = random(20) + 1, page = state.canvas.objects[0].notebookPages[pageNumber - 1];
    const mode = random(3), child = page[random(Math.max(1, page.length))];
    const change = !child || mode === 0 ? insert(stroke(`new-${i}`), page.length)
      : mode === 1 ? { type: 'delete', id: child.boardObjectId, ifObjectVersion: structuredClone(child) }
        : { type: 'patch', id: child.boardObjectId, patch: { stroke: `color-${i}` }, ifFields: { stroke: child.stroke } };
    inverses.push(commit([op([change], pageNumber)]));
  }
  const final = comparable(state.canvas.objects);
  const redos = [];
  for (const inverse of inverses.reverse()) redos.push(commit(inverse));
  assert.deepEqual(comparable(state.canvas.objects), initial);
  for (const redo of redos.reverse()) commit(redo);
  assert.deepEqual(comparable(state.canvas.objects), final);
});

test('snapshot reducer ignores empty entries in a compound notebook action', () => {
  const state = snapshot(book());
  assert.doesNotThrow(() => applyAuthorityOpsInPlace(state, [null, op([insert()])]));
  assert.equal(state.canvas.objects[0].notebookPages[0].length, 1);
});
