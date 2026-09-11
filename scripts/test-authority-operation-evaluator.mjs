import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateAuthorityAction } from '../src/lib/authorityOperationEvaluator.js';

function snapshot(objects = []) {
  return { version: 2, background: 'grid', canvas: { objects } };
}

test('passes ordinary operations through without server-only conditions', () => {
  const action = evaluateAuthorityAction({
    snapshot: snapshot([{ boardObjectId: 'a', left: 1 }]),
    tombstones: {},
    ops: [{ type: 'patch', id: 'a', patch: { left: 2 }, updatedAt: 1 }],
    background: null,
  });
  assert.equal(action.changed, true);
  assert.deepEqual(action.appliedOps, [{ type: 'patch', id: 'a', patch: { left: 2 }, updatedAt: 1 }]);
  assert.deepEqual(action.skippedConflicts, []);
});

test('conditional delete applies only when object version and z-index still match', () => {
  const objects = [
    { boardObjectId: 'a', left: 1, fill: 'red' },
    { boardObjectId: 'b', left: 2 },
  ];
  const ok = evaluateAuthorityAction({
    snapshot: snapshot(objects),
    tombstones: {},
    ops: [{
      type: 'delete', id: 'a', ifObjectVersion: { left: 1, fill: 'red' }, ifZIndex: 0,
    }],
  });
  assert.deepEqual(ok.appliedOps, [{ type: 'delete', id: 'a' }]);

  const stale = evaluateAuthorityAction({
    snapshot: snapshot(objects),
    tombstones: {},
    ops: [{ type: 'delete', id: 'a', ifObjectVersion: { left: 999 }, ifZIndex: 0 }],
  });
  assert.equal(stale.changed, false);
  assert.deepEqual(stale.appliedOps, []);
  assert.deepEqual(stale.skippedConflicts, [{ objectId: 'a', reason: 'object_changed' }]);
});

test('conditional patch applies safe fields and reports fields changed by somebody else', () => {
  const result = evaluateAuthorityAction({
    snapshot: snapshot([{ boardObjectId: 'a', fill: 'red', left: 50 }]),
    tombstones: {},
    ops: [{
      type: 'patch',
      id: 'a',
      patch: { fill: 'blue', left: 20, opacity: 0.5 },
      unset: ['shadow'],
      ifFields: { fill: 'red', left: 10 },
      ifAbsent: ['opacity', 'shadow'],
      updatedAt: 123,
      updatedBy: 'teacher',
    }],
  });

  assert.deepEqual(result.appliedOps, [{
    type: 'patch',
    id: 'a',
    patch: { fill: 'blue', opacity: 0.5 },
    unset: ['shadow'],
    updatedAt: 123,
    updatedBy: 'teacher',
  }]);
  assert.deepEqual(result.skippedConflicts, [{
    objectId: 'a', reason: 'fields_changed', fields: ['left'],
  }]);
});

test('conditional patch on a missing object is skipped instead of recreating it', () => {
  const result = evaluateAuthorityAction({
    snapshot: snapshot([]),
    tombstones: {},
    ops: [{ type: 'patch', id: 'gone', patch: { left: 1 }, ifFields: { left: 0 } }],
  });
  assert.equal(result.changed, false);
  assert.deepEqual(result.skippedConflicts, [{ objectId: 'gone', reason: 'object_missing' }]);
});

test('conditional transform keeps only entries whose previous transform still matches', () => {
  const result = evaluateAuthorityAction({
    snapshot: snapshot([
      { boardObjectId: 'a', left: 10, top: 20 },
      { boardObjectId: 'b', left: 99, top: 30 },
    ]),
    tombstones: {},
    ops: [{
      type: 'transform',
      version: 1,
      objects: [
        { id: 'a', transform: { left: 15 }, ifTransform: { left: 10 } },
        { id: 'b', transform: { left: 35 }, ifTransform: { left: 20 } },
      ],
    }],
  });
  assert.deepEqual(result.appliedOps, [{
    type: 'transform',
    version: 1,
    objects: [{ id: 'a', transform: { left: 15 } }],
  }]);
  assert.deepEqual(result.skippedConflicts, [{ objectId: 'b', reason: 'transform_changed' }]);
});

test('restore upsert honors the persisted deletion owner and mutation id', () => {
  const tombstones = {
    a: { clientId: 'teacher-a', mutationId: 'delete-1' },
  };
  const result = evaluateAuthorityAction({
    snapshot: snapshot([]),
    tombstones,
    ops: [{
      type: 'upsert',
      object: { boardObjectId: 'a', left: 10 },
      ifDeletedBy: 'teacher-a',
      ifDeletedMutationId: 'delete-1',
      restore: true,
    }],
  });
  assert.equal(result.changed, true);
  assert.deepEqual(result.appliedOps, [{
    type: 'upsert', object: { boardObjectId: 'a', left: 10 }, restore: true,
  }]);

  const stale = evaluateAuthorityAction({
    snapshot: snapshot([]),
    tombstones,
    ops: [{
      type: 'upsert', object: { boardObjectId: 'a', left: 10 }, ifDeletedBy: 'student-x',
    }],
  });
  assert.equal(stale.changed, false);
  assert.deepEqual(stale.skippedConflicts, [{ objectId: 'a', reason: 'object_changed' }]);
});

test('a background-only action still counts as changed', () => {
  const result = evaluateAuthorityAction({ snapshot: snapshot([]), tombstones: {}, ops: [], background: 'dots' });
  assert.equal(result.changed, true);
  assert.equal(result.appliedBackground, 'dots');
});
