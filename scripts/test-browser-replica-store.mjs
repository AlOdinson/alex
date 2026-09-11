import assert from 'node:assert/strict';
import test from 'node:test';
import * as replicaStore from '../src/lib/browserReplicaStore.js';

const {
  applyReplicaCommit,
  clearReplicaState,
  getReplicaChangesAfter,
  getReplicaState,
  installReplicaSnapshot,
} = replicaStore;

const EMPTY = { version: 2, background: 'grid', canvas: { objects: [] } };

test('installs authoritative snapshot and applies contiguous commits', () => {
  clearReplicaState('board-a');
  installReplicaSnapshot('board-a', EMPTY, 4);
  const result = applyReplicaCommit('board-a', {
    actionId: 'a5', revision: 5, ops: [{
      type: 'upsert', object: { boardObjectId: 'x', type: 'rect', left: 1 },
    }],
  });
  assert.equal(result.applied, true);
  const state = getReplicaState('board-a');
  assert.equal(state.revision, 5);
  assert.equal(state.snapshot.canvas.objects[0].boardObjectId, 'x');
  assert.deepEqual(getReplicaChangesAfter('board-a', 4).map((commit) => commit.revision), [5]);
});

test('does not apply a commit across a revision gap', () => {
  clearReplicaState('board-b');
  installReplicaSnapshot('board-b', EMPTY, 2);
  const result = applyReplicaCommit('board-b', { actionId: 'a4', revision: 4, ops: [] });
  assert.equal(result.applied, false);
  assert.equal(result.needsSnapshot, true);
  assert.equal(getReplicaState('board-b').revision, 2);
});

test('ignores already applied duplicate revisions', () => {
  clearReplicaState('board-c');
  installReplicaSnapshot('board-c', EMPTY, 7);
  const result = applyReplicaCommit('board-c', { actionId: 'a7', revision: 7, ops: [] });
  assert.equal(result.applied, false);
  assert.equal(result.duplicate, true);
});

test('revision lookup and one contiguous commit do not clone the whole replica snapshot', () => {
  clearReplicaState('board-hot-path');
  const largeSnapshot = {
    version: 2,
    background: 'grid',
    canvas: {
      objects: Array.from({ length: 2000 }, (_, index) => ({
        boardObjectId: `existing-${index}`,
        type: 'path',
        path: [['M', index, index], ['L', index + 1, index + 1]],
      })),
    },
  };
  installReplicaSnapshot('board-hot-path', largeSnapshot, 20);

  assert.equal(
    typeof replicaStore.getReplicaRevision,
    'function',
    'hot-path revision reads need a revision-only API instead of getReplicaState() full snapshot clones',
  );

  const originalStructuredClone = globalThis.structuredClone;
  assert.equal(typeof originalStructuredClone, 'function');
  let wholeSnapshotClones = 0;
  globalThis.structuredClone = (value) => {
    if (Array.isArray(value?.canvas?.objects) && value.canvas.objects.length >= 2000) {
      wholeSnapshotClones += 1;
    }
    return originalStructuredClone(value);
  };

  try {
    assert.equal(replicaStore.getReplicaRevision('board-hot-path'), 20);
    assert.equal(wholeSnapshotClones, 0, 'reading only revision must not clone the board');

    const result = applyReplicaCommit('board-hot-path', {
      actionId: 'hot-21',
      revision: 21,
      ops: [{
        type: 'upsert',
        object: {
          boardObjectId: 'new-stroke',
          type: 'path',
          path: [['M', 0, 0], ['L', 2, 2]],
        },
      }],
    });
    assert.equal(result.applied, true);
    assert.equal(
      wholeSnapshotClones,
      0,
      'applying one Pencil commit must not structuredClone the entire replica snapshot',
    );
  } finally {
    globalThis.structuredClone = originalStructuredClone;
    clearReplicaState('board-hot-path');
  }
});