import assert from 'node:assert/strict';
import {
  isRealtimeMutationCausallyStale,
  normalizeRealtimeBaseRevision,
  shouldRejectRealtimeObjectFrame,
} from '../src/lib/convergence.js';

assert.equal(normalizeRealtimeBaseRevision(undefined), null);
assert.equal(normalizeRealtimeBaseRevision('41'), 41);

const winner = {
  kind: 'upsert',
  revision: 41,
  updatedAt: 1_000,
};

// A rejected concurrent iPad gesture can have a much larger wall-clock timestamp.
// Its base revision still proves that it started before the server winner.
assert.equal(isRealtimeMutationCausallyStale(winner, 40), true);
assert.equal(shouldRejectRealtimeObjectFrame(winner, {
  baseRevision: 40,
  updatedAt: 9_999_999,
}), true);

// A new gesture starting from the winner is allowed to preview immediately.
assert.equal(shouldRejectRealtimeObjectFrame(winner, {
  baseRevision: 41,
  updatedAt: 1_001,
}), false);

// A delayed final frame sharing the durable timestamp cannot overwrite the winner.
assert.equal(shouldRejectRealtimeObjectFrame(winner, {
  baseRevision: 40,
  updatedAt: 1_000,
}), true);

assert.equal(shouldRejectRealtimeObjectFrame({
  kind: 'delete',
  revision: 42,
  updatedAt: 0,
}, {
  baseRevision: 42,
  updatedAt: 50_000,
}), true);

console.log('Sync convergence fence tests passed.');
