import assert from 'node:assert/strict';
import test from 'node:test';
import { createLocalBoardLibrary } from '../src/lib/localBoardLibrary.js';
import { applyAuthorityOpsInPlace } from '../src/lib/authoritySnapshot.js';
import * as replicas from '../src/lib/browserReplicaStore.js';
import { createFreshOwnerBootstrap, recoverFreshOwnerBootstrap } from '../src/lib/freshOwnerBootstrap.js';
const helpers = await import('../src/lib/boundedVerificationState.js').catch((e) => {
  if (e.code === 'ERR_MODULE_NOT_FOUND') return null;
  throw e;
});
test('new boards receive explicit verification version, not a timestamp heuristic', async () => {
  const library = createLocalBoardLibrary({ randomToken: (n) => `token${n}`, deriveShareKey: async () => 'share',
    createBoardRecord: async (data) => data, markFreshOwner: () => {} });
  const board = await library.createBoard();
  assert.equal(board.verificationVersion, 1);
});
test('verification state implementation exists', () => assert.equal(typeof helpers?.createVerificationView, 'function'));
const feature = (name, work) => test(name, { skip: !helpers }, work);
const sample = () => ({ version: 2, background: 'grid', canvas: { objects: [
  { boardObjectId: 'a', left: 10, stroke: 'black', path: [['M', 0, 0]] },
  { boardObjectId: 'b', left: 20, stroke: 'red' },
] } });
feature('old and malformed markers remain disabled', () => {
  for (const value of [undefined, null, 0, '1', 2, false]) assert.equal(helpers.isBoundedVerificationBoard({ verificationVersion: value }), false);
  assert.equal(helpers.isBoundedVerificationBoard({ verificationVersion: 1 }), true);
});
feature('lookup reads only requested data without cloning the whole snapshot', () => {
  const snapshot = sample();
  const view = helpers.createVerificationView({ getSnapshot: () => snapshot, getRevision: () => 7 });
  assert.equal(view.read('a').object, snapshot.canvas.objects[0]);
  assert.equal(view.read('a').zIndex, 0);
  assert.deepEqual(view.read('missing'), { id: 'missing', object: null, zIndex: -1 });
  assert.equal(view.revision(), 7);
});
feature('lookup reflects patch, transform, delete and restore from real reducer', () => {
  const snapshot = sample();
  const view = helpers.createVerificationView({ getSnapshot: () => snapshot, getRevision: () => 7 });
  const before = view.capture();
  applyAuthorityOpsInPlace(snapshot, [{ type: 'patch', id: 'a', patch: { stroke: 'blue' }, updatedAt: 123 }]);
  assert.equal(view.read('a').object.stroke, 'blue'); assert.equal(view.isCurrent(before), false);
  applyAuthorityOpsInPlace(snapshot, [{ type: 'transform', objects: [{ id: 'a', transform: { left: 100 }, updatedAt: 124 }] }]);
  assert.equal(view.read('a').object.left, 100);
  applyAuthorityOpsInPlace(snapshot, [{ type: 'delete', id: 'a' }]);
  assert.equal(view.read('a').object, null); assert.equal(view.read('b').zIndex, 0);
  applyAuthorityOpsInPlace(snapshot, [{ type: 'upsert', object: { boardObjectId: 'a', left: 10 }, zIndex: 0, restore: true }]);
  assert.equal(view.read('a').zIndex, 0); assert.equal(view.read('b').zIndex, 1);
});
feature('same revision snapshot replacement invalidates outstanding view capture', () => {
  let snapshot = sample();
  const view = helpers.createVerificationView({ getSnapshot: () => snapshot, getRevision: () => 7 });
  const stamp = view.capture(); snapshot = sample(); assert.equal(view.isCurrent(stamp), false);
});
feature('sweep returns limited finite pages and wraps only for normal sampling', () => {
  const snapshot = sample();
  const view = helpers.createVerificationView({ getSnapshot: () => snapshot, getRevision: () => 0 });
  assert.deepEqual(view.readOlder(1, { fullSweep: true, reset: true }), { ids: ['a'], done: false });
  assert.deepEqual(view.readOlder(1, { fullSweep: true }), { ids: ['b'], done: true });
  assert.deepEqual(view.readOlder(1, { fullSweep: true }), { ids: [], done: true });
  assert.equal(view.readOlder(100, {}).ids.length, 2);
});
feature('targeted replica repair fixes old color/deletion without advancing revision or history', () => {
  replicas.installReplicaSnapshot('verify', sample(), 7);
  const repaired = replicas.applyReplicaVerificationRecords('verify', [
    { id: 'a', object: { boardObjectId: 'a', left: 33, stroke: 'green' }, zIndex: 0 },
    { id: 'b', object: null, zIndex: -1 },
  ], 7);
  assert.equal(repaired, true);
  const state = replicas.getReplicaState('verify');
  assert.equal(state.revision, 7); assert.equal(state.snapshot.canvas.objects.length, 1);
  assert.equal(state.snapshot.canvas.objects[0].stroke, 'green');
  assert.deepEqual(replicas.getReplicaChangesAfter('verify', 0), []);
  replicas.clearReplicaState('verify');
});
feature('stale or malformed replica repair cannot overwrite newer state', () => {
  replicas.installReplicaSnapshot('verify', sample(), 8);
  assert.equal(replicas.applyReplicaVerificationRecords('verify', [{ id: 'a', object: null }], 7), false);
  assert.equal(replicas.applyReplicaVerificationRecords('verify', [{ id: 'a', object: { boardObjectId: 'b' }, zIndex: 0 }], 8), false);
  assert.equal(replicas.applyReplicaVerificationRecords('verify', new Array(101).fill({ id: 'a', object: null }), 8), false);
  assert.equal(replicas.getReplicaState('verify').snapshot.canvas.objects.length, 2);
  replicas.clearReplicaState('verify');
});
feature('targeted repair removes duplicate ghosts and preserves other objects', () => {
  const snapshot = sample(); snapshot.canvas.objects.push({ boardObjectId: 'a', left: 999 });
  replicas.installReplicaSnapshot('duplicates', snapshot, 8);
  replicas.applyReplicaVerificationRecords('duplicates', [{ id: 'a', object: null, zIndex: -1 }], 8);
  assert.deepEqual(replicas.getReplicaState('duplicates').snapshot.canvas.objects.map((o) => o.boardObjectId), ['b']);
  replicas.clearReplicaState('duplicates');
});
feature('fresh owner recovery preserves explicit marker but does not upgrade an old marker', async () => {
  const entries = new Map(); const storage = { getItem: (k) => entries.get(k), setItem: (k, v) => entries.set(k, v), removeItem: (k) => entries.delete(k) };
  for (const version of [undefined, 1]) {
    createFreshOwnerBootstrap({ boardId: 'new', ownerKey: 'owner', shareKey: 'share', createdAt: 100000, verificationVersion: version }, { storage, now: () => 100000 });
    const restored = await recoverFreshOwnerBootstrap({ boardId: 'new', ownerKey: 'owner', storage, ownerStorage: null,
      now: () => 100001, getBoard: async () => null, createBoard: async (v) => v });
    assert.equal(restored.verificationVersion, version);
  }
});
