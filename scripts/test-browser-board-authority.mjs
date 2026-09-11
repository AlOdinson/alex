import assert from 'node:assert/strict';
import test from 'node:test';
import { openBrowserBoardAuthority } from '../src/lib/browserBoardAuthority.js';

const EMPTY = { version: 2, background: 'grid', canvas: { objects: [] } };

test('rebuilds the current teacher snapshot from local snapshot plus contiguous journal', async () => {
  const service = await openBrowserBoardAuthority({
    boardId: 'board-a',
    loadBoard: async () => ({
      boardId: 'board-a', revision: 2, snapshotRevision: 0, snapshot: EMPTY, tombstones: {},
    }),
    loadCommitsAfter: async (_boardId, revision) => revision === 0 ? [
      { actionId: 'a1', revision: 1, ops: [{ type: 'upsert', object: { boardObjectId: 'x', type: 'rect', left: 1 } }] },
      { actionId: 'a2', revision: 2, ops: [{ type: 'transform', objects: [{ id: 'x', transform: { left: 9 } }] }] },
    ] : [],
    persistCommit: async () => {},
    saveSnapshot: async () => {},
    loadActionOutcome: async () => null,
    persistNoopOutcome: async (_boardId, result) => ({ result, duplicate: false }),
  });

  assert.equal(service.getRevision(), 2);
  assert.equal(service.getSnapshot().canvas.objects[0].left, 9);
});

test('rejects startup when the local durable journal has a revision gap', async () => {
  await assert.rejects(() => openBrowserBoardAuthority({
    boardId: 'board-gap',
    loadBoard: async () => ({ boardId: 'board-gap', revision: 3, snapshotRevision: 0, snapshot: EMPTY, tombstones: {} }),
    loadCommitsAfter: async () => [{ actionId: 'a2', revision: 2, ops: [] }, { actionId: 'a3', revision: 3, ops: [] }],
    persistCommit: async () => {},
    saveSnapshot: async () => {},
    loadActionOutcome: async () => null,
    persistNoopOutcome: async (_boardId, result) => ({ result, duplicate: false }),
  }), /journal gap/i);
});

test('updates the in-memory snapshot only after a new durable commit succeeds', async () => {
  let releasePersist;
  let markPersistStarted;
  const persistStarted = new Promise((resolve) => { markPersistStarted = resolve; });
  const persisted = [];
  const service = await openBrowserBoardAuthority({
    boardId: 'board-b',
    loadBoard: async () => ({ boardId: 'board-b', revision: 0, snapshotRevision: 0, snapshot: EMPTY, tombstones: {} }),
    loadCommitsAfter: async () => [],
    persistCommit: async (_boardId, commit) => {
      persisted.push(commit);
      markPersistStarted();
      await new Promise((resolve) => { releasePersist = resolve; });
      return { commit, duplicate: false };
    },
    saveSnapshot: async () => {},
    loadActionOutcome: async () => null,
    persistNoopOutcome: async (_boardId, result) => ({ result, duplicate: false }),
  });

  const committing = service.commitAction({
    actionId: 'add-1', clientId: 'teacher', baseRevision: 0,
    ops: [{ type: 'upsert', object: { boardObjectId: 'x', type: 'rect', left: 7 } }],
  });
  await persistStarted;
  assert.equal(service.getRevision(), 0);
  assert.equal(service.getSnapshot().canvas.objects.length, 0);
  assert.equal(persisted.length, 1);

  releasePersist();
  const result = await committing;
  assert.equal(result.revision, 1);
  assert.equal(result.changed, true);
  assert.deepEqual(result.appliedOps, persisted[0].ops);
  assert.equal(service.getRevision(), 1);
  assert.equal(service.getSnapshot().canvas.objects[0].left, 7);
});

test('conditional stale action is persisted as a no-op without advancing revision', async () => {
  const noops = [];
  let commitWrites = 0;
  const service = await openBrowserBoardAuthority({
    boardId: 'board-conditional-noop',
    loadBoard: async () => ({
      boardId: 'board-conditional-noop', revision: 0, snapshotRevision: 0,
      snapshot: { version: 2, background: 'grid', canvas: { objects: [{ boardObjectId: 'x', left: 50 }] } },
      tombstones: {},
    }),
    loadCommitsAfter: async () => [],
    persistCommit: async () => { commitWrites += 1; },
    persistNoopOutcome: async (_boardId, result) => { noops.push(result); return { result, duplicate: false }; },
    loadActionOutcome: async () => null,
    saveSnapshot: async () => {},
  });

  const result = await service.commitAction({
    actionId: 'undo-stale', clientId: 'teacher', baseRevision: 0,
    ops: [{ type: 'patch', id: 'x', patch: { left: 10 }, ifFields: { left: 20 } }],
  });

  assert.equal(result.changed, false);
  assert.equal(result.revision, 0);
  assert.equal(service.getRevision(), 0);
  assert.equal(commitWrites, 0);
  assert.equal(noops.length, 1);
  assert.deepEqual(result.skippedConflicts, [{ objectId: 'x', reason: 'fields_changed', fields: ['left'] }]);
});

test('conditional action persists only safe fields and exposes skipped conflicts', async () => {
  const persisted = [];
  const service = await openBrowserBoardAuthority({
    boardId: 'board-conditional-partial',
    loadBoard: async () => ({
      boardId: 'board-conditional-partial', revision: 0, snapshotRevision: 0,
      snapshot: { version: 2, background: 'grid', canvas: { objects: [{ boardObjectId: 'x', left: 50, fill: 'red' }] } },
      tombstones: {},
    }),
    loadCommitsAfter: async () => [],
    persistCommit: async (_boardId, commit) => { persisted.push(commit); return { commit, duplicate: false }; },
    persistNoopOutcome: async (_boardId, result) => ({ result, duplicate: false }),
    loadActionOutcome: async () => null,
    saveSnapshot: async () => {},
  });

  const result = await service.commitAction({
    actionId: 'undo-partial', clientId: 'teacher', baseRevision: 0,
    ops: [{
      type: 'patch', id: 'x', patch: { fill: 'blue', left: 10 },
      ifFields: { fill: 'red', left: 20 }, updatedAt: 123,
    }],
  });

  assert.equal(result.revision, 1);
  assert.deepEqual(persisted[0].ops, [{
    type: 'patch', id: 'x', patch: { fill: 'blue' }, updatedAt: 123,
  }]);
  assert.deepEqual(result.appliedOps, persisted[0].ops);
  assert.deepEqual(result.skippedConflicts, [{ objectId: 'x', reason: 'fields_changed', fields: ['left'] }]);
  assert.equal(service.getSnapshot().canvas.objects[0].fill, 'blue');
  assert.equal(service.getSnapshot().canvas.objects[0].left, 50);
});

test('restore conditions use durable tombstone metadata', async () => {
  const persisted = [];
  const service = await openBrowserBoardAuthority({
    boardId: 'board-restore',
    loadBoard: async () => ({
      boardId: 'board-restore', revision: 2, snapshotRevision: 2,
      snapshot: EMPTY,
      tombstones: { x: { clientId: 'teacher', mutationId: 'delete-mutation' } },
    }),
    loadCommitsAfter: async () => [],
    persistCommit: async (_boardId, commit) => { persisted.push(commit); return { commit, duplicate: false }; },
    persistNoopOutcome: async (_boardId, result) => ({ result, duplicate: false }),
    loadActionOutcome: async () => null,
    saveSnapshot: async () => {},
  });

  const result = await service.commitAction({
    actionId: 'restore-1', clientId: 'teacher', baseRevision: 2,
    ops: [{
      type: 'upsert', object: { boardObjectId: 'x', left: 10 }, restore: true,
      ifDeletedBy: 'teacher', ifDeletedMutationId: 'delete-mutation',
    }],
  });
  assert.equal(result.changed, true);
  assert.equal(result.revision, 3);
  assert.equal(service.getSnapshot().canvas.objects[0].boardObjectId, 'x');
  assert.equal(persisted[0].ops[0].ifDeletedBy, undefined);
});

test('reuses a durable prior outcome before re-evaluating the same action id', async () => {
  let writes = 0;
  const prior = {
    actionId: 'prior-action', revision: 4, changed: true, duplicate: false,
    ops: [{ type: 'delete', id: 'x' }], appliedOps: [{ type: 'delete', id: 'x' }],
    skippedConflicts: [],
  };
  const service = await openBrowserBoardAuthority({
    boardId: 'board-prior',
    loadBoard: async () => ({ boardId: 'board-prior', revision: 4, snapshotRevision: 4, snapshot: EMPTY, tombstones: {} }),
    loadCommitsAfter: async () => [],
    loadActionOutcome: async (_boardId, actionId) => actionId === 'prior-action' ? prior : null,
    persistCommit: async () => { writes += 1; },
    persistNoopOutcome: async () => { writes += 1; },
    saveSnapshot: async () => {},
  });

  const result = await service.commitAction({ actionId: 'prior-action', ops: [{ type: 'upsert', object: { boardObjectId: 'x' } }] });
  assert.equal(result.duplicate, true);
  assert.equal(result.revision, 4);
  assert.equal(writes, 0);
});

test('compacts the reconstructed current snapshot at the current revision', async () => {
  const saves = [];
  const service = await openBrowserBoardAuthority({
    boardId: 'board-c',
    loadBoard: async () => ({
      boardId: 'board-c', revision: 1, snapshotRevision: 0, snapshot: EMPTY, tombstones: {},
    }),
    loadCommitsAfter: async () => [
      { actionId: 'a1', revision: 1, ops: [{ type: 'upsert', object: { boardObjectId: 'x', type: 'rect' } }] },
    ],
    persistCommit: async () => {},
    persistNoopOutcome: async (_boardId, result) => ({ result, duplicate: false }),
    loadActionOutcome: async () => null,
    saveSnapshot: async (boardId, snapshot, revision) => { saves.push({ boardId, snapshot, revision }); return revision; },
  });

  await service.compactSnapshot();
  assert.equal(saves.length, 1);
  assert.equal(saves[0].boardId, 'board-c');
  assert.equal(saves[0].revision, 1);
  assert.equal(saves[0].snapshot.canvas.objects[0].boardObjectId, 'x');
});