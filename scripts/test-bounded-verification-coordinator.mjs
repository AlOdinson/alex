import assert from 'node:assert/strict';
import test from 'node:test';
import { createVerificationView, applyVerificationRecords } from '../src/lib/boundedVerificationState.js';
import { applyAuthorityOpsInPlace } from '../src/lib/authoritySnapshot.js';
import { buildVerificationReply } from '../src/lib/boundedVerificationProtocol.js';
const impl = await import('../src/lib/boundedBoardVerifier.js').catch((e) => {
  if (e.code === 'ERR_MODULE_NOT_FOUND') return null;
  throw e;
});
test('bounded board coordinator exists', () => assert.equal(typeof impl?.createBoundedBoardVerifier, 'function'));
const feature = (name, fn) => test(name, { skip: !impl }, fn);
const object = (id, left = 0) => ({ boardObjectId: id, type: 'Path', left, top: 0, stroke: 'black', path: [['M', 0, 0], ['L', 1, 1]] });
function state(objects) {
  const snapshot = { version: 2, background: 'grid', canvas: { objects: structuredClone(objects) } };
  let revision = 3;
  const view = createVerificationView({ getSnapshot: () => snapshot, getRevision: () => revision });
  return { snapshot, view, change(ops) { applyAuthorityOpsInPlace(snapshot, ops); revision++; } };
}
function setup({ sourceObjects = [object('a')], localObjects = sourceObjects, ...options } = {}) {
  const source = state(sourceObjects); const local = state(localObjects);
  let config; const marks = []; const requests = []; const canvas = []; const controller = new AbortController();
  let sweeps = 0; let closed = false;
  const coordinator = impl.createBoundedBoardVerifier({
    enabled: true, epoch: 'teacher-epoch', view: local.view,
    request: async (request) => {
      requests.push(request);
      return buildVerificationReply(source.view, { ...request, version: 1, epoch: 'teacher-epoch', requestId: 'check' }, 'teacher-epoch');
    },
    applyRecords: (records, revision, background) => revision === local.view.revision()
      && applyVerificationRecords(local.snapshot, records, background),
    checkCanvas: async (records, context) => { canvas.push({ records: structuredClone(records), context }); return true; },
    createScheduler: (value) => {
      config = value;
      return { mark: (ids, meta) => marks.push({ ids: [...ids], meta }), requestSweep: () => { sweeps++; }, resume() {},
        close: () => { closed = true; controller.abort(); }, stats: () => ({ enabled: !closed }) };
    },
    ...options,
  });
  return { coordinator, local, source, marks, requests, canvas,
    get sweeps() { return sweeps; },
    older: (count, sweep = false, reset = false) => config.readOlder(count, { fullSweep: sweep, reset }),
    verify: (ids, overrides = {}) => config.verify({ ids, dirtyIds: ids, checkBackground: false,
      signal: controller.signal, fullSweep: false, ...overrides }),
  };
}
feature('same-revision wrong content gets a selective model and Canvas repair', async () => {
  const bad = object('a'); bad.stroke = 'red';
  const h = setup({ localObjects: [bad] });
  assert.equal((await h.verify(['a'])).complete, true);
  assert.equal(h.local.view.read('a').object.stroke, 'black');
  assert.equal(h.canvas[0].records[0].object.stroke, 'black');
  assert.equal(h.local.view.revision(), 3); h.coordinator.close();
});
feature('lost deletion checks absence and removes a local ghost without touching other records', async () => {
  const h = setup({ sourceObjects: [object('keep')], localObjects: [object('keep'), object('ghost')] });
  const keep = h.local.view.read('keep').object;
  await h.verify(['ghost']);
  assert.equal(h.local.view.read('ghost').object, null);
  assert.equal(h.local.view.read('keep').object, keep);
  assert.equal(h.canvas[0].records[0].object, null); h.coordinator.close();
});
feature('a newer local move invalidates an old reply instead of reverting the object', async () => {
  const h = setup({ request: async (request) => {
    const reply = await buildVerificationReply(h.source.view, { ...request, version: 1, epoch: 'teacher-epoch', requestId: 'c' }, 'teacher-epoch');
    h.local.change([{ type: 'transform', objects: [{ id: 'a', transform: { left: 50 } }] }]);
    return reply;
  } });
  assert.equal((await h.verify(['a'])).complete, false);
  assert.equal(h.local.view.read('a').object.left, 50);
  assert.equal(h.canvas.length, 0); h.coordinator.close();
});
feature('wrong session replies and unchecked repair identities are rejected', async () => {
  const h = setup({ request: async () => ({ version: 1, epoch: 'old-teacher', revision: 3, status: 'ok', checkedIds: ['a'], repairs: [] }) });
  assert.equal((await h.verify(['a'])).complete, false);
  assert.equal(h.canvas.length, 0); h.coordinator.close();
  const other = setup({ request: async () => ({ version: 1, epoch: 'teacher-epoch', revision: 3, status: 'ok', checkedIds: ['a'],
    repairs: [{ id: 'intruder', object: object('intruder'), zIndex: 0 }] }) });
  assert.equal((await other.verify(['a'])).complete, false);
  assert.equal(other.local.view.read('intruder').object, null); other.coordinator.close();
});
feature('busy input postpones checking without any request or mutation', async () => {
  const h = setup({ canCheck: () => false });
  assert.equal((await h.verify(['a'])).complete, false);
  assert.equal(h.requests.length, 0); assert.equal(h.canvas.length, 0); h.coordinator.close();
});
feature('confirmed transforms/deletes and undo outcomes mark the original object ids', () => {
  const h = setup();
  h.coordinator.notify({ changed: true, appliedOps: [{ type: 'transform', objects: [{ id: 'old-object', transform: { left: 90 } }] }] });
  h.coordinator.notify({ changed: true, appliedOps: [{ type: 'delete', id: 'old-object' }] });
  assert.deepEqual(h.marks.slice(0, 2).map((x) => x.ids), [['old-object'], ['old-object']]);
  h.coordinator.notify({ changed: false, appliedOps: [{ type: 'delete', id: 'wrong' }] });
  assert.equal(h.marks.length, 2); h.coordinator.close();
});
feature('background-only changes are checked with zero object identities', async () => {
  const h = setup(); h.local.snapshot.background = 'blank';
  h.coordinator.notify({ changed: true, appliedOps: [], appliedBackground: 'grid' });
  assert.equal(h.marks[0].meta.background, true);
  await h.verify([], { checkBackground: true });
  assert.equal(h.local.snapshot.background, 'grid'); h.coordinator.close();
});
feature('finite server membership pages discover objects missing entirely from the local replica', async () => {
  const h = setup({ sourceObjects: [object('a'), object('missing')], localObjects: [object('a')] });
  await h.verify(['a']);
  assert.ok(h.marks.some((m) => m.ids.includes('missing')));
  assert.equal(h.sweeps, 1);
  await h.verify(['missing']);
  assert.equal(h.local.view.read('missing').object.boardObjectId, 'missing'); h.coordinator.close();
});
feature('older candidates include Canvas-only ghosts without copying entire Canvas contents', () => {
  let calls = 0;
  const h = setup({ readCanvasIds: (limit) => { calls++; assert.ok(limit <= 100); return { ids: ['canvas-ghost'], done: true }; } });
  const candidates = h.older(20);
  assert.ok(candidates.ids.includes('a')); assert.ok(candidates.ids.includes('canvas-ghost'));
  assert.equal(calls, 1); assert.ok(candidates.ids.length <= 20); h.coordinator.close();
});
feature('owner local Canvas work uses the same CPU lane as student comparisons', async () => {
  let lane = 0;
  const h = setup({ request: null, runWork: async (work) => { lane++; return work(new AbortController().signal); } });
  assert.equal((await h.verify(['a'])).complete, true);
  assert.equal(lane, 1); assert.equal(h.canvas.length, 1); assert.equal(h.requests.length, 0); h.coordinator.close();
});
feature('no verification or Canvas repair is applied after closing an in-flight coordinator', async () => {
  const h = setup({ request: async (request) => {
    const reply = await buildVerificationReply(h.source.view, { ...request, version: 1, epoch: 'teacher-epoch', requestId: 'c' }, 'teacher-epoch');
    h.coordinator.close(); return reply;
  } });
  assert.equal((await h.verify(['a'])).complete, false); assert.equal(h.canvas.length, 0);
});
feature('disabled boards do not construct a scheduler or allocate verification work', () => {
  const verifier = impl.createBoundedBoardVerifier({ enabled: false, createScheduler: () => { throw new Error('old board'); } });
  verifier.notify({ appliedOps: [{ type: 'delete', id: 'a' }] }); verifier.resume(); verifier.close();
  assert.equal(verifier.stats().enabled, false);
});
feature('full sweep does not skip identities when repairs remove earlier array entries', async () => {
  const ghosts = Array.from({ length: 240 }, (_, i) => object(`ghost-${i}`));
  const h = setup({ sourceObjects: [], localObjects: ghosts });
  let rounds = 0;
  for (;;) {
    const batch = h.older(100, true, rounds === 0);
    await h.verify(batch.ids, { fullSweep: true });
    if (batch.done) break;
    assert.ok(++rounds < 20, 'sweep must terminate');
  }
  assert.equal(h.local.view.count(), 0, 'every ghost must be checked despite earlier removals shifting the array');
  h.coordinator.close();
});
