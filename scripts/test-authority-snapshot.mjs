import assert from 'node:assert/strict';
import test from 'node:test';
import { applyAuthorityActions, applyAuthorityOps } from '../src/lib/authoritySnapshot.js';

function baseSnapshot() {
  return {
    version: 2,
    background: 'grid',
    canvas: {
      objects: [
        { type: 'rect', boardObjectId: 'a', left: 10, top: 20, fill: 'red', updatedAt: 1 },
        { type: 'rect', boardObjectId: 'b', left: 30, top: 40, fill: 'blue', updatedAt: 1 },
      ],
    },
  };
}

test('applies upsert patch transform delete and background without mutating source', () => {
  const source = baseSnapshot();
  const result = applyAuthorityOps(source, [
    { type: 'patch', id: 'a', patch: { fill: 'green' }, updatedAt: 2, updatedBy: 'teacher' },
    { type: 'transform', objects: [{ id: 'b', transform: { left: 99, top: 88 }, updatedAt: 3 }] },
    { type: 'delete', id: 'a' },
    { type: 'upsert', object: { type: 'circle', boardObjectId: 'c', left: 5, top: 6 }, zIndex: 0 },
  ], 'dots');

  assert.equal(source.canvas.objects.length, 2);
  assert.equal(source.background, 'grid');
  assert.equal(result.background, 'dots');
  assert.deepEqual(result.canvas.objects.map((object) => object.boardObjectId), ['c', 'b']);
  assert.equal(result.canvas.objects[1].left, 99);
  assert.equal(result.canvas.objects[1].top, 88);
});

test('replays a sequence of committed actions', () => {
  const result = applyAuthorityActions({ version: 2, background: 'grid', canvas: { objects: [] } }, [
    { ops: [{ type: 'upsert', object: { boardObjectId: 'a', type: 'rect', left: 1 }, zIndex: 0 }] },
    { ops: [{ type: 'transform', objects: [{ id: 'a', transform: { left: 42 } }] }] },
    { background: 'blank', ops: [] },
  ]);
  assert.equal(result.canvas.objects[0].left, 42);
  assert.equal(result.background, 'blank');
});

test('drops serialized ActiveSelection wrappers from authoritative snapshots', () => {
  const result = applyAuthorityOps({
    version: 2,
    background: 'grid',
    canvas: {
      objects: [
        { type: 'ActiveSelection', boardObjectId: 'temp-selection' },
        { type: 'rect', boardObjectId: 'real' },
      ],
    },
  }, []);
  assert.deepEqual(result.canvas.objects.map((object) => object.boardObjectId), ['real']);
});
