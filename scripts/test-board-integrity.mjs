import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';

const queueUrl = new URL('../src/lib/boardIntegrityQueue.js', import.meta.url);
test('bounded integrity queue module is present', () => assert.ok(existsSync(queueUrl), 'missing optional integrity scheduler'));
const queueModule = existsSync(queueUrl) ? await import(queueUrl.href) : null;

function fakeClock() {
  let time = 0; let serial = 0; const timers = new Map();
  const turn = async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); };
  return {
    now: () => time,
    setTimer(fn, delay) { const id = ++serial; timers.set(id, { fn, at: time + delay }); return id; },
    clearTimer(id) { timers.delete(id); },
    async advance(ms) {
      const end = time + ms;
      for (let n = 0; n < 10000; n++) {
        await turn();
        const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > end) { time = end; await turn(); return; }
        time = next[1].at; timers.delete(next[0]); next[1].fn();
      }
      throw new Error('unbounded scheduler loop');
    },
    turn, timers,
  };
}
function setup(run = async () => ({ status: 'done' }), options = {}) {
  assert.ok(queueModule, 'scheduler must exist');
  const clock = fakeClock(); const calls = [];
  const queue = queueModule.createBoardIntegrityQueue({
    ...clock, sample: () => [], ...options,
    run: async (ids) => { calls.push({ ids, at: clock.now() }); return run(ids); },
  });
  return { clock, calls, queue };
}

for (const [name, fn] of [
  ['exact agreed limits', async () => {
    const c = queueModule.INTEGRITY_LIMITS;
    assert.equal(c.batchSize, 100); assert.equal(c.changedSlots, 80); assert.equal(c.queueSize, 1000);
    assert.equal(c.debounceMs, 200); assert.equal(c.maxWaitMs, 1000); assert.equal(c.intervalMs, 250); assert.equal(c.sliceMs, 4);
  }],
  ['no work or periodic timers before a confirmed change', async () => {
    const { queue, clock, calls } = setup(); await clock.advance(60000);
    assert.equal(calls.length, 0); assert.equal(clock.timers.size, 0); queue.close();
  }],
  ['200ms quiet debounce coalesces different changed objects', async () => {
    const { queue, clock, calls } = setup(); queue.mark(['a']); await clock.advance(100); queue.mark(['b']);
    await clock.advance(199); assert.equal(calls.length, 0); await clock.advance(1);
    assert.deepEqual(calls[0].ids.sort(), ['a', 'b']); queue.close();
  }],
  ['continuous edits cannot reset maximum scheduling wait', async () => {
    const { queue, clock, calls } = setup();
    for (let i = 0; i < 10; i++) { queue.mark([`x${i}`]); await clock.advance(100); }
    assert.equal(calls[0].at, 1000); queue.close();
  }],
  ['one active check; repeated IDs use latest generation', async () => {
    let finish; const blocked = new Promise((r) => { finish = r; });
    const { queue, clock, calls } = setup(async () => { await blocked; return { status: 'done' }; });
    queue.mark(['same']); await clock.advance(200); queue.mark(['same', 'other']);
    await clock.advance(10000); assert.equal(calls.length, 1); finish(); await clock.turn();
    await clock.advance(250); assert.equal(calls.length, 2); assert.ok(calls[1].ids.includes('same')); queue.close();
  }],
  ['300 affected objects drain in >=3 batches without another action', async () => {
    const { queue, clock, calls } = setup(); queue.mark(Array.from({ length: 300 }, (_, i) => `x${i}`));
    await clock.advance(5000); assert.ok(calls.length >= 3); assert.ok(calls.every((x) => x.ids.length <= 100));
    assert.equal(new Set(calls.flatMap((x) => x.ids)).size, 300);
    for (let i = 1; i < calls.length; i++) assert.ok(calls[i].at - calls[i - 1].at >= 250);
    assert.equal(clock.timers.size, 0); queue.close();
  }],
  ['closed queue does not apply deferred work', async () => {
    const { queue, clock, calls } = setup(); queue.mark(['x']); queue.close(); await clock.advance(5000);
    assert.equal(calls.length, 0); assert.equal(clock.timers.size, 0);
  }],
  ['1001 IDs never create 1001 queued records and request rescan', async () => {
    const { queue } = setup(); queue.mark(Array.from({ length: 1001 }, (_, i) => `x${i}`));
    assert.ok(queue.inspect().pending <= 1000); assert.equal(queue.inspect().rescan, true); queue.close();
  }],
]) test(name, { skip: !queueModule }, fn);

const dataUrl = new URL('../src/lib/boardIntegrityData.js', import.meta.url);
test('cooperative integrity data module is present', () => assert.ok(existsSync(dataUrl), 'missing cooperative data checker'));
const data = existsSync(dataUrl) ? await import(dataUrl.href) : null;
const budget = (options = {}) => data.createIntegrityBudget({ ...options });
for (const [name, fn] of [
  ['fingerprints are key-order stable and content/order sensitive', async () => {
    const r = { id: 'x', count: 1, zIndex: 0, object: { type: 'Path', boardObjectId: 'x', stroke: 'black', path: [['M', 1, 2]] } };
    const h = await data.fingerprintIntegrityRecord(r, budget());
    assert.equal(h, await data.fingerprintIntegrityRecord({ ...r, object: { path: [['M', 1, 2]], stroke: 'black', boardObjectId: 'x', type: 'Path' } }, budget()));
    assert.notEqual(h, await data.fingerprintIntegrityRecord({ ...r, object: { ...r.object, stroke: 'red' } }, budget()));
    assert.notEqual(h, await data.fingerprintIntegrityRecord({ ...r, zIndex: 1 }, budget()));
    assert.notEqual(h, await data.fingerprintIntegrityRecord({ ...r, count: 0, object: null }, budget()));
  }],
  ['capture verifies absence and duplicate membership without cloning paths', async () => {
    const path = [['M', 1, 2]]; const object = { boardObjectId: 'x', path };
    const s = { snapshot: { canvas: { objects: [object, object] } }, revision: 3 };
    const records = await data.captureIntegrityRecords(s, ['x', 'deleted'], budget());
    assert.equal(records[0].count, 2); assert.equal(records[0].object.path, path);
    assert.equal(records[1].count, 0); assert.equal(records[1].object, null);
  }],
  ['large path hashing yields and rejects a changing revision', async () => {
    let yields = 0; let ticks = 0;
    const b = budget({ now: () => ++ticks, yieldTask: async () => { yields++; } });
    await data.fingerprintIntegrityRecord({ id: 'x', object: { path: Array.from({ length: 20000 }, (_, i) => ['L', i, i]) } }, b);
    assert.ok(yields > 0, 'must yield during one large object');
    await assert.rejects(() => data.fingerprintIntegrityRecord({ id: 'x' }, budget({ isCurrent: () => false })), /stale|aborted/i);
  }],
  ['cooperative serialization preserves unicode and numeric values', async () => {
    const value = { text: '😀"\\\n'.repeat(500), array: [null, false, 1.2345], gone: undefined };
    const encoded = await data.serializeIntegrityValue(value, budget());
    assert.deepEqual(JSON.parse(encoded), JSON.parse(JSON.stringify(value)));
  }],
  ['Canvas comparison detects color, coordinates, order and ghosts', async () => {
    const r = { id: 'x', count: 1, zIndex: 0, object: { type: 'Path', left: 10, stroke: 'black', path: [['M', 1, 2]] } };
    assert.deepEqual(await data.compareIntegrityCanvas([r], [{ ...r, object: { ...r.object, type: 'path', left: 10.0001 } }], budget()), []);
    for (const changed of [{ ...r, zIndex: 2 }, { ...r, object: { ...r.object, left: 20 } }, { ...r, object: { ...r.object, stroke: 'red' } }]) {
      assert.deepEqual(await data.compareIntegrityCanvas([r], [changed], budget()), ['x']);
    }
    assert.deepEqual(await data.compareIntegrityCanvas([{ id: 'x', count: 0, object: null, zIndex: -1 }], [r], budget()), ['x']);
  }],
]) test(name, { skip: !data }, fn);
test('rescan cursor is acknowledged only after a completed batch, never while paused', async () => {
  let acknowledged = 0;
  const { queue, clock } = setup(async () => ({ status: 'paused' }), {
    sample: () => ({ ids: ['old'], more: false, acknowledge: () => { acknowledged++; } }),
  });
  queue.mark(['new']); await clock.advance(1000);
  assert.equal(acknowledged, 0);
  queue.close();
  const done = setup(async () => ({ status: 'done' }), {
    sample: () => ({ ids: ['old'], more: false, acknowledge: () => { acknowledged++; } }),
  });
  done.queue.mark(['new']); await done.clock.advance(1000);
  assert.equal(acknowledged, 1);
  done.queue.close();
});

test('an input wake during an active deferred batch is not lost', async () => {
  let release; let calls=0;
  const stalled=new Promise(r=>release=r);
  const {queue,clock}=setup(async()=>{calls++;return calls===1?stalled:{status:'done'};});
  queue.mark(['A']);await clock.advance(200);
  queue.wake();release({status:'paused'});
  await clock.advance(1000);
  assert.equal(calls,2,'finish of gesture must resume pending checking even during async capture');
  assert.equal(queue.inspect().pending,0);queue.close();
});
