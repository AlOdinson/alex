import { createInitialHistoryOps, refreshHistoryOps } from '../src/lib/historyOperations.js';
import { createHistoryCommandQueue } from '../src/lib/historyCommandQueue.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { createConditionalDeleteOps, createConditionalRecordPatchOps } from '../src/lib/operationProtocol.js';
import { openBrowserBoardAuthority } from '../src/lib/browserBoardAuthority.js';
import { createTeacherPeerHub } from '../src/lib/teacherPeerHub.js';

const turn = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };
const EMPTY = { version: 2, background: 'grid', canvas: { objects: [] } };
async function authority(objects = []) {
  const outcomes = new Map();
  const service = await openBrowserBoardAuthority({
    boardId: 'history',
    loadBoard: async () => ({ revision: 0, snapshotRevision: 0, snapshot: { ...EMPTY, canvas: { objects } } }),
    loadCommitsAfter: async () => [],
    loadActionOutcome: async (_id, actionId) => outcomes.get(actionId) ?? null,
    persistCommit: async (_id, commit) => { outcomes.set(commit.actionId, structuredClone(commit)); return { commit, duplicate: false }; },
    persistNoopOutcome: async (_id, result) => { outcomes.set(result.actionId, result); return { result, duplicate: false }; },
  });
  let id = 0;
  return { service, commit: (ops, clientId = 'teacher') => service.commitAction({
    actionId: `history-${++id}`, clientId, baseRevision: service.getRevision(), ops,
  }) };
}
const source = fs.readFileSync(new URL('../src/components/Board.jsx', import.meta.url), 'utf8');
function loadCallback(name, scope) {
  const start = source.indexOf(`  const ${name} = useCallback(`);
  assert.ok(start >= 0, `${name} callback not found`);
  const end = source.indexOf('\n\n  const ', start + 1);
  const text = source.slice(start, end);
  return new Function('scope', `with(scope) { ${text}; return ${name}; }`)(scope);
}
const ref = (current) => ({ current });
async function boardHarness(objects, options = {}) {
  const { service, commit } = await authority(objects);
  const status = [];
  const scope = {
    useCallback: (fn) => fn, useEffect: () => {}, HISTORY_LIMIT: 1000,
    createInitialHistoryOps, refreshHistoryOps, createHistoryCommandQueue,
    randomToken: (() => { let i = 0; return () => `request-${++i}`; })(),
    historyCommandQueueRef: ref(null), historyGenerationRef: ref(0), historyHandlersRef: ref(null),
    localDeletionMutationIdsRef: ref(new Map()), localSelectionTransactionRef: ref(null),
    deferredTransformFlushRef: ref(null), realtimeRef: ref(null),
    authoritativeApplyQueueRef: ref(Promise.resolve()),
    applyRemoteOpsRef: ref(async () => true), syncFromServer: async () => {},
    commitLocalSelectionTransaction: async () => {},
    clientIdRef: ref('teacher'),
    applyingHistoryRef: ref(false), applyingRemoteRef: ref(false), historyCommandBusyRef: ref(false),
    canEditRef: ref(true), undoStackRef: ref([]), redoStackRef: ref([]),
    fabricCanvasRef: ref({ discardActiveObject() {} }),
    setCanUndo() {}, setCanRedo() {}, schedulePersistence() {},
    setSaveStatus: (text) => status.push(text), setSyncTone() {}, transientStatusTimerRef: ref(null),
    window: { setTimeout() {}, clearTimeout() {} },
    console: { error() {} },
    createConditionalDeleteOps, createConditionalRecordPatchOps,
    TRANSFORM_PROPERTY_KEYS: ['left', 'top', 'scaleX', 'scaleY', 'angle', 'flipX', 'flipY'],
    replayPendingActionsLocally: async () => {},
    sendDurableOps: async (ops) => {
      await options.beforeCommit?.();
      return [options.result ?? await commit(ops)];
    },
    applyBackground: () => options.backgroundPromise,
  };
  for (const name of ['updateHistoryButtons', 'recordAction', 'commitConditionalHistoryOps', 'applyHistoryAction', 'prepareHistoryCommand', 'enqueueHistoryCommand', 'undo', 'redo']) {
    scope[name] = loadCallback(name, scope);
  }
  return { ...scope, service, commit, status };
}

// This executes the actual existing React callback bodies with a real authority,
// without requiring Fabric/DOM just to reproduce history bookkeeping failures.
test('deleting an unrelated lower object cannot block undo of an unchanged stroke', async () => {
  const a = { boardObjectId: 'a', type: 'Path', left: 10 };
  const b = { boardObjectId: 'b', type: 'Path', left: 20 };
  const { service, commit } = await authority([a, b]);
  await commit([{ type: 'delete', id: 'a' }], 'student');
  const result = await commit(createConditionalDeleteOps([{ object: b, zIndex: 1 }]));
  assert.equal(result.changed, true, 'only stacking shifted, the stroke was not modified');
  assert.deepEqual(service.getSnapshot().canvas.objects, []);
});

test('redo replays only fields actually undone, never a previously conflicted field', async () => {
  const before = { boardObjectId: 'x', type: 'Rect', fill: 'black', left: 10 };
  const after = { ...before, fill: 'red', left: 20 };
  const b = await boardHarness([{ ...after, left: 99 }]);
  b.recordAction({ type: 'modify', before: [{ object: before, zIndex: 0 }], after: [{ object: after, zIndex: 0 }] });
  await b.undo();
  assert.equal(b.service.getSnapshot().canvas.objects[0].fill, 'black');
  assert.equal(b.service.getSnapshot().canvas.objects[0].left, 99);
  await b.commit([{ type: 'patch', id: 'x', patch: { left: 10 } }], 'student');
  await b.redo();
  assert.equal(b.service.getSnapshot().canvas.objects[0].fill, 'red');
  assert.equal(b.service.getSnapshot().canvas.objects[0].left, 10, 'redo must not touch a field that undo skipped');
});

test('every rapid undo command is queued rather than silently discarded', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const objects = ['a', 'b', 'c'].map((boardObjectId) => ({ boardObjectId, type: 'Rect' }));
  const b = await boardHarness(objects, { beforeCommit: () => gate });
  objects.forEach((object, zIndex) => b.recordAction({ type: 'add', records: [{ object, zIndex }] }));
  const commands = [b.undo(), b.undo(), b.undo()];
  release();
  await Promise.all(commands);
  assert.equal(b.undoStackRef.current.length, 0);
  assert.equal(b.redoStackRef.current.length, 3);
  assert.deepEqual(b.service.getSnapshot().canvas.objects, []);
});

test('a rejected teacher acknowledgement does not consume the undo history entry', async () => {
  const object = { boardObjectId: 'x', type: 'Rect' };
  const b = await boardHarness([object], { result: { accepted: false, changed: false, appliedOps: [], rejectedObjectIds: [], error: 'Not permitted' } });
  b.recordAction({ type: 'add', records: [{ object, zIndex: 0 }] });
  await b.undo();
  assert.equal(b.undoStackRef.current.length, 1);
  assert.equal(b.redoStackRef.current.length, 0);
});

test('local drawing recorded while a history command awaits the network is not lost', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const object = { boardObjectId: 'x', type: 'Rect' };
  const b = await boardHarness([object], { beforeCommit: () => gate });
  b.recordAction({ type: 'add', records: [{ object, zIndex: 0 }] });
  const undoing = b.undo();
  await turn();
  b.recordAction({ type: 'add', records: [{ object: { boardObjectId: 'new' }, zIndex: 1 }] });
  release();
  await undoing;
  assert.equal(b.undoStackRef.current.at(-1)?.records[0]?.object.boardObjectId, 'new');
});

test('a silent slow participant cannot block commit delivery to healthy participants', async () => {
  let release;
  const slow = new Promise((resolve) => { release = resolve; });
  const delivered = [];
  const hub = createTeacherPeerHub({
    authority: { getRevision: () => 1, commitAction: async () => {} },
    getSnapshot: async () => ({ snapshot: EMPTY, revision: 1 }), getCommitsAfter: async () => [],
  });
  hub.addPeer('slow-tablet', { send: () => slow, sendTextTransfer: async () => {} });
  hub.addPeer('healthy-phone', { send: async (type) => delivered.push(type), sendTextTransfer: async () => {} });
  let settled = false;
  const broadcast = hub.broadcastCommit({ revision: 2, ops: [{ type: 'delete', id: 'x' }] }).then(() => { settled = true; });
  await turn();
  const deliveredBeforeDrain = [...delivered];
  const settledBeforeDrain = settled;
  release();
  await broadcast;
  assert.deepEqual(deliveredBeforeDrain, ['commit']);
  assert.equal(settledBeforeDrain, true, 'committing must not await the slowest participant');
});
