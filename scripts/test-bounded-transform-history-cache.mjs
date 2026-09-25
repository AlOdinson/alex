import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createInitialHistoryOps } from '../src/lib/historyOperations.js';
import { applyAuthorityOps } from '../src/lib/authoritySnapshot.js';

const board = readFileSync(new URL('../src/components/Board.jsx', import.meta.url), 'utf8');
const start = board.indexOf('    function cacheLightweightTransformEntry(entry) {');
const end = board.indexOf('\n    function queueDeferredTransformPersistence', start);
assert.ok(start >= 0 && end > start, 'exercise the real Board cache writer');
function cacheWriter(cache, enabled) {
  return new Function('serializedObjectCacheRef', 'realtimeRef', `${board.slice(start, end)}; return cacheLightweightTransformEntry;`)(
    { current: cache }, { current: { getVerificationStats: () => ({ enabled }) } },
  );
}

for (const count of [1, 300]) {
  test(`new-board ${count}-object move preserves history baseline across cache update and undo/redo`, () => {
    const cache = new WeakMap();
    const write = cacheWriter(cache, true);
    const objects = Array.from({ length: count }, (_, i) => ({ boardObjectId: `p${i}`, left: i, top: i * 2,
      angle: 0, scaleX: 1, scaleY: 1, path: [['M', i, i], ['L', i + 10, i + 5]] }));
    const beforeRecords = objects.map((o, zIndex) => ({ object: structuredClone(o), zIndex }));
    const entries = objects.map((object, i) => {
      const cached = beforeRecords[i].object;
      cache.set(object, cached);
      return { id: object.boardObjectId, object, cached,
        transform: { left: object.left + 35, top: object.top + 25, angle: 0, scaleX: 1, scaleY: 1 },
        updatedAt: 100 + i, updatedBy: 'owner', zIndex: i };
    });
    const afterRecords = entries.map((entry) => ({ object: { boardObjectId: entry.id, ...entry.transform }, zIndex: entry.zIndex }));
    entries.forEach(write);
    assert.equal(beforeRecords[0].object.left, 0, 'cache mutation must not move the saved BEFORE position');
    assert.equal(cache.get(objects[0]).left, 35, 'live cache must still hold the new position');
    assert.equal(cache.get(objects[0]).path, beforeRecords[0].object.path, 'unchanged path bytes must not be copied');
    const action = { type: 'transform', beforeRecords, afterRecords };
    const moved = { canvas: { objects: afterRecords.map((r) => r.object) } };
    const undone = applyAuthorityOps(moved, createInitialHistoryOps(action, 'undo', 'owner'));
    assert.deepEqual(undone.canvas.objects.map((o) => [o.left, o.top]), objects.map((o) => [o.left, o.top]));
    const redone = applyAuthorityOps(undone, createInitialHistoryOps(action, 'redo', 'owner'));
    assert.deepEqual(redone.canvas.objects.map((o) => [o.left, o.top]), afterRecords.map((r) => [r.object.left, r.object.top]));
    // A second immediate move must not rewrite history of the first gesture.
    const firstCached = cache.get(objects[0]);
    write({ ...entries[0], cached: firstCached, transform: { left: 100, top: 100 } });
    assert.equal(firstCached.left, 35);
    assert.equal(beforeRecords[0].object.left, 0);
  });
}

test('unmarked old boards retain the existing cache path', () => {
  const object = {}; const cached = { left: 1, top: 2 }; const cache = new WeakMap([[object, cached]]);
  cacheWriter(cache, false)({ id: 'legacy', object, cached, transform: { left: 4, top: 5 }, updatedAt: 1 });
  assert.equal(cache.get(object), cached);
  assert.equal(cached.left, 4);
});
