import assert from 'node:assert/strict';
import test from 'node:test';
import { createVerificationView } from '../src/lib/boundedVerificationState.js';
import { verificationDigest } from '../src/lib/boundedVerificationDigest.js';
const module = await import('../src/lib/boundedVerificationProtocol.js').catch((e) => {
  if (e.code === 'ERR_MODULE_NOT_FOUND') return null;
  throw e;
});
test('bounded verification protocol exists', () => assert.equal(typeof module?.buildVerificationReply, 'function'));
const feature = (name, work) => test(name, { skip: !module }, work);
function state() {
  const snapshot = { background: 'grid', canvas: { objects: [{ boardObjectId: 'a', stroke: 'black', left: 1 }, { boardObjectId: 'b', left: 2 }] } };
  let revision = 10;
  return { snapshot, setRevision: (r) => { revision = r; }, view: createVerificationView({ getSnapshot: () => snapshot, getRevision: () => revision }) };
}
const request = (entries = []) => ({ version: 1, requestId: 'check1', epoch: 'teacher1', revision: 10, entries, scanCursor: 0, scanLimit: 20 });
feature('matching checks return no copies of untouched objects', async () => {
  const { view } = state(); const record = view.read('a');
  const reply = await module.buildVerificationReply(view, request([{ id: 'a', hash: await verificationDigest(record) }]), 'teacher1');
  assert.equal(reply.status, 'ok'); assert.deepEqual(reply.repairs, []);
  assert.deepEqual(reply.checkedIds, ['a']); assert.deepEqual(reply.scan.ids, ['a', 'b']);
});
feature('same revision wrong color is detected and only that object is returned', async () => {
  const { view } = state();
  const bad = { ...view.read('a'), object: { ...view.read('a').object, stroke: 'red' } };
  const reply = await module.buildVerificationReply(view, request([{ id: 'a', hash: await verificationDigest(bad) }]), 'teacher1');
  assert.equal(reply.repairs.length, 1); assert.equal(reply.repairs[0].object.stroke, 'black');
});
feature('a ghost deletion produces an explicit absence record', async () => {
  const { view } = state();
  const reply = await module.buildVerificationReply(view, request([{ id: 'ghost', hash: '0'.repeat(64) }]), 'teacher1');
  assert.deepEqual(reply.repairs, [{ id: 'ghost', object: null, zIndex: -1 }]);
});
feature('wrong revision or teacher epoch cannot produce repair data', async () => {
  const { view } = state();
  for (const change of [{ revision: 9 }, { epoch: 'old-teacher' }]) {
    const reply = await module.buildVerificationReply(view, { ...request([{ id: 'a', hash: '0'.repeat(64) }]), ...change }, 'teacher1');
    assert.notEqual(reply.status, 'ok'); assert.equal(reply.repairs, undefined);
  }
});
feature('oversized, duplicate and malformed requests are rejected before reading objects', async () => {
  let reads = 0; const view = { revision: () => 10, read: () => { reads++; } };
  for (const entries of [new Array(101).fill({ id: 'a', hash: '0'.repeat(64) }),
    [{ id: 'a', hash: 'bad' }], [{ id: 'a', hash: '0'.repeat(64) }, { id: 'a', hash: '0'.repeat(64) }]]) {
    const reply = await module.buildVerificationReply(view, request(entries), 'teacher1');
    assert.equal(reply.status, 'invalid');
  }
  assert.equal(reads, 0);
});
feature('source changes during cooperative digest invalidate the whole response', async () => {
  const { snapshot, view, setRevision } = state();
  snapshot.canvas.objects[0].path = Array.from({ length: 10000 }, (_, i) => ['L', i, i]);
  let clock = 0;
  const reply = await module.buildVerificationReply(view, request([{ id: 'a', hash: '0'.repeat(64) }]), 'teacher1', {
    now: () => ++clock, yieldControl: async () => setRevision(11),
  });
  assert.equal(reply.status, 'stale'); assert.equal(reply.repairs, undefined);
});
feature('work lane serializes local and peer checks and spaces starts by 250ms', async () => {
  let active = 0; let maximum = 0; const starts = [];
  const lane = module.createVerificationWorkLane({ minIntervalMs: 1 });
  const work = async () => { starts.push(performance.now()); maximum = Math.max(maximum, ++active);
    await new Promise((r) => setTimeout(r, 3)); active--; return 'ok'; };
  assert.deepEqual(await Promise.all([lane.run('peer-a', work), lane.run('local', work), lane.run('peer-b', work)]), ['ok', 'ok', 'ok']);
  assert.equal(maximum, 1); assert.ok(starts[1] - starts[0] >= 240); assert.ok(starts[2] - starts[1] >= 240);
  lane.close();
});
feature('work lane rejects overlapping jobs from the same peer', async () => {
  const lane = module.createVerificationWorkLane(); let release;
  const running = lane.run('peer', () => new Promise((r) => { release = r; }));
  await new Promise((r) => setTimeout(r, 10));
  await assert.rejects(lane.run('peer', async () => {}), /already pending/);
  release(); await running; lane.close();
});
