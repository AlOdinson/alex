import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyReplicaCommit,
  clearReplicaState,
  getReplicaChangesAfter,
  getReplicaState,
  installReplicaSnapshot,
} from '../src/lib/browserReplicaStore.js';

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
