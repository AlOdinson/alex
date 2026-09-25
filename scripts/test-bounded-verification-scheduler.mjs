import assert from 'node:assert/strict';
import test from 'node:test';

const implementation = await import('../src/lib/boundedVerificationScheduler.js').catch((error) => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return null;
  throw error;
});
test('bounded verification scheduler implementation exists', () => {
  assert.equal(typeof implementation?.createBoundedVerificationScheduler, 'function');
});
const featureTest = (name, fn) => test(name, { skip: !implementation }, fn);

class Clock {
  time = 0;
  serial = 0;
  timers = new Map();
  now = () => this.time;
  schedule = (fn, delay) => {
    const id = ++this.serial;
    this.timers.set(id, { fn, at: this.time + delay });
    return id;
  };
  cancel = (id) => this.timers.delete(id);
  async tick(milliseconds) {
    const end = this.time + milliseconds;
    for (let safety = 0; safety < 10_000; safety++) {
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
      const next = [...this.timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > end) break;
      this.time = next[1].at;
      this.timers.delete(next[0]);
      next[1].fn();
    }
    this.time = end;
    for (let i = 0; i < 10; i++) await Promise.resolve();
  }
}
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};
function setup(options = {}) {
  const clock = new Clock();
  const calls = [];
  const errors = [];
  const queue = implementation.createBoundedVerificationScheduler({
    enabled: true,
    now: clock.now, schedule: clock.schedule, cancel: clock.cancel,
    verify: async (batch) => { calls.push({ at: clock.time, ...batch }); },
    onError: (error) => errors.push(error),
    ...options,
  });
  return { clock, calls, queue, errors };
}
featureTest('approved constants are fixed and explicit', () => {
  assert.deepEqual(implementation.BOUNDED_VERIFICATION_LIMITS, {
    maxObjects: 100, dirtyQuota: 80, olderQuota: 20, maxDirtyIds: 1000,
    debounceMs: 200, maxDeferralMs: 1000, minIntervalMs: 250, cpuBudgetMs: 4,
  });
});
featureTest('unmarked/disabled boards schedule no work', async () => {
  const { queue, clock, calls } = setup({ enabled: false });
  queue.mark(['a']); queue.resume();
  await clock.tick(60_000);
  assert.equal(calls.length, 0);
  assert.equal(clock.timers.size, 0);
  assert.equal(queue.stats().pendingIds, 0);
});
featureTest('default is disabled, not automatically active on old boards', () => {
  const queue = implementation.createBoundedVerificationScheduler({ verify: async () => {} });
  queue.mark(['a']);
  assert.equal(queue.stats().enabled, false);
  assert.equal(queue.stats().pendingIds, 0);
  queue.close();
});
featureTest('a stroke is checked after 200ms, not immediately', async () => {
  const { queue, clock, calls } = setup();
  queue.mark(['a']); await clock.tick(199); assert.equal(calls.length, 0);
  await clock.tick(1); assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].ids, ['a']);
});
featureTest('rapid strokes coalesce into one batch after the pause', async () => {
  const { queue, clock, calls } = setup();
  queue.mark(['a']); await clock.tick(100); queue.mark(['b']);
  await clock.tick(199); assert.equal(calls.length, 0);
  await clock.tick(1); assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].ids, ['a', 'b']);
});
featureTest('continuous writing cannot debounce past 1000ms', async () => {
  const { queue, clock, calls } = setup();
  for (let i = 0; i < 10; i++) { queue.mark([`s${i}`]); await clock.tick(100); }
  assert.equal(calls.length, 1); assert.equal(calls[0].at, 1000);
  assert.equal(calls[0].ids.length, 10);
});
featureTest('minimum interval remains 250ms while backlog drains', async () => {
  const { queue, clock, calls } = setup();
  queue.mark(Array.from({ length: 300 }, (_, i) => `s${i}`));
  await clock.tick(2000);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map((c) => c.ids.length), [100, 100, 100]);
  assert.ok(calls.every((c, i) => !i || c.at - calls[i - 1].at >= 250));
});
featureTest('slow asynchronous verification never overlaps a second batch', async () => {
  const wait = deferred(); let active = 0; let maximum = 0; let runs = 0;
  const { queue, clock } = setup({ verify: async () => {
    runs++; maximum = Math.max(maximum, ++active);
    if (runs === 1) await wait.promise;
    active--;
  } });
  queue.mark(['a']); await clock.tick(200);
  for (let i = 0; i < 100; i++) queue.mark([`b${i}`]);
  await clock.tick(5000);
  assert.equal(runs, 1); assert.equal(maximum, 1); assert.equal(clock.timers.size, 0);
  wait.resolve(); await clock.tick(1000);
  assert.equal(runs, 2); assert.equal(maximum, 1);
});
featureTest('repeated changes use one pending id but preserve newest generation', async () => {
  const wait = deferred(); let runs = 0;
  const { queue, clock, calls } = setup({ verify: async (batch) => {
    calls.push({ at: clock.time, ...batch }); runs++;
    if (runs === 1) await wait.promise;
  } });
  queue.mark(['a']); await clock.tick(200);
  for (let i = 0; i < 30; i++) queue.mark(['a']);
  assert.equal(queue.stats().pendingIds, 1);
  wait.resolve(); await clock.tick(1000);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].ids, ['a']);
  assert.equal(queue.stats().pendingIds, 0);
});
featureTest('up to 80 dirty plus 20 older ids, without duplicate entries', async () => {
  const { queue, clock, calls } = setup({ readOlder: (limit) => ({
    ids: Array.from({ length: limit }, (_, i) => `old${i}`), done: true,
  }) });
  queue.mark(Array.from({ length: 100 }, (_, i) => `s${i}`));
  await clock.tick(200);
  assert.equal(calls[0].ids.length, 100);
  assert.equal(calls[0].dirtyIds.length, 80);
  assert.equal(calls[0].ids.filter((id) => id.startsWith('old')).length, 20);
});
featureTest('unused older capacity is loaned to dirty ids', async () => {
  const { queue, clock, calls } = setup({ readOlder: () => ({ ids: [], done: true }) });
  queue.mark(Array.from({ length: 120 }, (_, i) => `s${i}`)); await clock.tick(200);
  assert.equal(calls[0].dirtyIds.length, 100);
});
featureTest('unused dirty capacity is loaned to older ids', async () => {
  const { queue, clock, calls } = setup({ readOlder: (limit) => ({
    ids: Array.from({ length: limit }, (_, i) => `old${i}`), done: true,
  }) });
  queue.mark(['new']); await clock.tick(200);
  assert.equal(calls[0].ids.length, 100); assert.equal(calls[0].dirtyIds.length, 1);
});
featureTest('duplicate older ids cannot exceed 100 or duplicate dirty ids', async () => {
  const { queue, clock, calls } = setup({ readOlder: () => ({ ids: ['a', 'a', 'b', 'b'], done: true }) });
  queue.mark(['a']); await clock.tick(200);
  assert.deepEqual(calls[0].ids, ['a', 'b']);
});
featureTest('dirty memory stays at 1000 ids and overflow requests a sweep', async () => {
  const { queue, clock, calls } = setup();
  queue.mark(Array.from({ length: 5000 }, (_, i) => `s${i}`));
  assert.equal(queue.stats().pendingIds, 1000);
  assert.equal(queue.stats().sweepPending, true);
  await clock.tick(200);
  assert.equal(calls[0].fullSweep, true); assert.ok(calls[0].ids.length <= 100);
});
featureTest('overflow during active work survives its completion', async () => {
  const wait = deferred(); let first = true;
  const { queue, clock } = setup({ verify: async () => { if (first) { first = false; await wait.promise; } } });
  queue.mark(['a']); await clock.tick(200);
  queue.mark(Array.from({ length: 2000 }, (_, i) => `s${i}`));
  wait.resolve(); await clock.tick(0);
  assert.equal(queue.stats().sweepPending, true);
  queue.close();
});
featureTest('sweep drains finite pages even after input stops', async () => {
  let page = 0;
  const { queue, clock, calls } = setup({ readOlder: (limit, { fullSweep }) => ({
    ids: fullSweep ? Array.from({ length: Math.min(4, limit) }, (_, i) => `page${page}-${i}`) : [],
    done: !fullSweep || ++page >= 3,
  }) });
  queue.requestSweep(); await clock.tick(2000);
  assert.equal(calls.length, 3); assert.equal(queue.stats().sweepPending, false);
  assert.equal(clock.timers.size, 0);
});
featureTest('no repeated polling after all pending work is done', async () => {
  const { queue, clock, calls } = setup();
  queue.mark(['a']); await clock.tick(60_000);
  assert.equal(calls.length, 1); assert.equal(clock.timers.size, 0);
});
featureTest('a failed verification pauses without adding retry timers', async () => {
  const { queue, clock, calls, errors } = setup({ verify: async () => { calls.push('attempt'); throw new Error('offline'); } });
  queue.mark(['a']); await clock.tick(60_000);
  assert.equal(calls.length, 1); assert.equal(errors.length, 1);
  assert.equal(queue.stats().pendingIds, 1); assert.equal(clock.timers.size, 0);
  queue.resume(); await clock.tick(1000);
  assert.equal(calls.length, 2);
});
featureTest('new input wakes work paused by a stale/pending state', async () => {
  let runs = 0;
  const { queue, clock } = setup({ verify: async () => ({ complete: ++runs > 1 }) });
  queue.mark(['a']); await clock.tick(60_000);
  assert.equal(runs, 1); assert.equal(queue.stats().pendingIds, 1);
  queue.mark(['b']); await clock.tick(1000);
  assert.equal(runs, 2); assert.equal(queue.stats().pendingIds, 0);
});
featureTest('background-only change schedules a check', async () => {
  const { queue, clock, calls } = setup();
  queue.mark([], { background: true }); await clock.tick(200);
  assert.equal(calls.length, 1); assert.equal(calls[0].checkBackground, true);
  assert.equal(clock.timers.size, 0);
});
featureTest('background change during active check is retained', async () => {
  const wait = deferred(); let first = true;
  const { queue, clock, calls } = setup({ verify: async (batch) => {
    calls.push(batch); if (first) { first = false; await wait.promise; }
  } });
  queue.mark([], { background: true }); await clock.tick(200);
  queue.mark([], { background: true }); wait.resolve(); await clock.tick(1000);
  assert.equal(calls.length, 2);
});
featureTest('close aborts an in-flight batch and prevents later work', async () => {
  const wait = deferred(); let received;
  const { queue, clock } = setup({ verify: async (batch) => { received = batch; await wait.promise; } });
  queue.mark(['a']); await clock.tick(200); queue.close();
  assert.equal(received.signal.aborted, true);
  queue.mark(['b']); wait.resolve(); await clock.tick(60_000);
  assert.equal(queue.stats().pendingIds, 0); assert.equal(clock.timers.size, 0);
});
featureTest('observer failure cannot create an unhandled retry loop', async () => {
  const { queue, clock } = setup({ verify: async () => { throw new Error('network'); }, onError: () => { throw new Error('observer'); } });
  queue.mark(['a']); await clock.tick(60_000);
  assert.equal(clock.timers.size, 0); assert.equal(queue.stats().paused, true);
});
