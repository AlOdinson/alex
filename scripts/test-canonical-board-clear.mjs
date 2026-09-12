import assert from 'node:assert/strict';
import test from 'node:test';
import { planCanonicalBoardClear } from '../src/lib/canonicalBoardClear.js';

test('clear deletes hidden authority objects as well as the objects visible in Fabric', () => {
  const visibleRecords = [
    { object: { boardObjectId: 'visible-a', type: 'path' }, zIndex: 0 },
  ];
  const authoritySnapshot = {
    version: 2,
    canvas: {
      objects: [
        { boardObjectId: 'visible-a', type: 'path' },
        { boardObjectId: 'hidden-ghost-b', type: 'path' },
        { boardObjectId: 'hidden-ghost-c', type: 'textbox' },
      ],
    },
  };

  const plan = planCanonicalBoardClear({ visibleRecords, authoritySnapshot });

  assert.deepEqual(plan.deleteIds.sort(), ['hidden-ghost-b', 'hidden-ghost-c', 'visible-a']);
  assert.deepEqual(plan.undoRecords, visibleRecords,
    'undo must restore only what the user actually saw, not hidden corrupt remnants');
});

test('clear can purge authority remnants even when the local canvas is visually empty', () => {
  const plan = planCanonicalBoardClear({
    visibleRecords: [],
    authoritySnapshot: {
      canvas: { objects: [{ boardObjectId: 'invisible-old-object', type: 'path' }] },
    },
  });

  assert.deepEqual(plan.deleteIds, ['invisible-old-object']);
  assert.deepEqual(plan.undoRecords, []);
});

test('clear ignores transient or malformed serialized objects without durable ids', () => {
  const plan = planCanonicalBoardClear({
    visibleRecords: [{ object: { boardObjectId: 'real', type: 'path' }, zIndex: 0 }],
    authoritySnapshot: {
      canvas: {
        objects: [
          { boardObjectId: 'real', type: 'path' },
          { type: 'path', transientPreview: true },
          null,
        ],
      },
    },
  });

  assert.deepEqual(plan.deleteIds, ['real']);
});
