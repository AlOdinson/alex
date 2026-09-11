import assert from 'node:assert/strict';
import test from 'node:test';
import { openBrowserBoardAuthority } from '../src/lib/browserBoardAuthority.js';

const EMPTY = { version: 2, background: 'grid', canvas: { objects: [] } };

test('rebuilds the current teacher snapshot from local snapshot plus contiguous journal', async () => {
  const service = await openBrowserBoardAuthority({
    boardId: 'board-a',
    loadBoard: async () => ({
      boardId: 'board-a', revision: 2, snapshotRevision: 0, snapshot: EMPTY,
    }),
    loadCommitsAfter: async (_boardId, revision) => revision === 0 ? [
      { actionId: 'a1', revision: 1, ops: [{ type: 'upsert', object: { boardObjectId: 'x', type: 'rect', left: 1 } }] },
      { actionId: 'a2', revision: 2, ops: [{ type: 'transform', objects: [{ id: 'x', transform: { left: 9 } }] }] },
    ] : [],
    persistCommit: async () => {},
    saveSnapshot: async () => {},
  });

  assert.equal(service.getRevision(), 2);
  assert.equal(service.getSnapshot().canvas.objects[0].left, 9);
});

test('rejects startup when the local durable journal has a revision gap', async () => {
  await assert.rejects(() => openBrowserBoardAuthority({
    boardId: 'board-gap',
    loadBoard: async () => ({ boardId: 'board-gap', revision: 3, snapshotRevision: 0, snapshot: EMPTY }),
    loadCommitsAfter: async () => [{ actionId: 'a2', revision: 2, ops: [] }, { actionId: 'a3', revision: 3, ops: [] }],
    persistCommit: async () => {},
    saveSnapshot: async () => {},
  }), /journal gap/i);
});

test('updates the in-memory snapshot only after a new durable commit succeeds', async () => {
  let releasePersist;
  const persisted = [];
  const service = await openBrowserBoardAuthority({
    boardId: 'board-b',
    loadBoard: async () => ({ boardId: 'board-b', revision: 0, snapshotRevision: 0, snapshot: EMPTY }),
    loadCommitsAfter: async () => [],
    persistCommit: async (_boardId, commit) => {
      persisted.push(commit);
      await new Promise((resolve) => { releasePersist = resolve; });
      return { commit, duplicate: false };
    },
    saveSnapshot: async () => {},
  });

  const committing = service.commitAction({
    actionId: 'add-1', clientId: 'teacher', baseRevision: 0,
    ops: [{ type: 'upsert', object: { boardObjectId: 'x', type: 'rect', left: 7 } }],
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(service.getRevision(), 0);
  assert.equal(service.getSnapshot().canvas.objects.length, 0);
  assert.equal(persisted.length, 1);

  releasePersist();
  const result = await committing;
  assert.equal(result.revision, 1);
  assert.equal(service.getRevision(), 1);
  assert.equal(service.getSnapshot().canvas.objects[0].left, 7);
});

test('compacts the reconstructed current snapshot at the current revision', async () => {
  const saves = [];
  const service = await openBrowserBoardAuthority({
    boardId: 'board-c',
    loadBoard: async () => ({
      boardId: 'board-c', revision: 1, snapshotRevision: 0, snapshot: EMPTY,
    }),
    loadCommitsAfter: async () => [
      { actionId: 'a1', revision: 1, ops: [{ type: 'upsert', object: { boardObjectId: 'x', type: 'rect' } }] },
    ],
    persistCommit: async () => {},
    saveSnapshot: async (boardId, snapshot, revision) => { saves.push({ boardId, snapshot, revision }); return revision; },
  });

  await service.compactSnapshot();
  assert.equal(saves.length, 1);
  assert.equal(saves[0].boardId, 'board-c');
  assert.equal(saves[0].revision, 1);
  assert.equal(saves[0].snapshot.canvas.objects[0].boardObjectId, 'x');
});
