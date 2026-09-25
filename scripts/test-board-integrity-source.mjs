import assert from 'node:assert/strict';
import test from 'node:test';
import { createLocalBoardLibrary } from '../src/lib/localBoardLibrary.js';
import { createFreshOwnerBootstrap, recoverFreshOwnerBootstrap } from '../src/lib/freshOwnerBootstrap.js';
import { openBrowserBoardAuthority } from '../src/lib/browserBoardAuthority.js';
import * as replicas from '../src/lib/browserReplicaStore.js';

const empty = { version: 2, background: 'grid', canvas: { objects: [] } };
const storage = () => { const data = new Map(); return { getItem: (k) => data.get(k) ?? null, setItem: (k,v) => data.set(k,v), removeItem: (k) => data.delete(k) }; };

test('only new library-created boards explicitly opt into integrity v1', async () => {
  let input;
  const library = createLocalBoardLibrary({
    randomToken: (n) => `token-${n}`, deriveShareKey: async () => 'room', markFreshOwner() {},
    createBoardRecord: async (record) => { input = record; return record; },
  });
  await library.createBoard('new');
  assert.equal(input.integrityVersion, 1);
});

test('fresh owner handoff preserves explicit opt-in and never upgrades an old marker', async () => {
  for (const version of [undefined, 1]) {
    const s = storage();
    const board = { boardId: 'b', ownerKey: 'owner', shareKey: 'room', createdAt: 1000, ...(version ? { integrityVersion: version } : {}) };
    createFreshOwnerBootstrap(board, { storage: s, now: () => 1000 });
    const recovered = await recoverFreshOwnerBootstrap({ boardId: 'b', ownerKey: 'owner', storage: s, ownerStorage: storage(), now: () => 1100, getBoard: async () => null, createBoard: async (r) => r });
    assert.equal(Number(recovered.integrityVersion ?? 0), version ?? 0);
  }
});

async function authority(version) {
  return openBrowserBoardAuthority({
    boardId: 'b', loadBoard: async () => ({ revision: 0, snapshotRevision: 0, snapshot: empty, ...(version ? { integrityVersion: version } : {}) }),
    loadCommitsAfter: async () => [], loadActionOutcome: async () => null,
    persistCommit: async (_id, commit) => ({ commit, duplicate: false }),
  });
}
test('old authority does not expose enabled integrity source', async () => {
  const a = await authority();
  assert.equal(a.getIntegritySource?.() ?? null, null);
});
test('new authority exposes current read-only source without full cloning', async () => {
  const a = await authority(1);
  assert.equal(a.getIntegritySource?.().version, 1);
  const source = a.getIntegritySource();
  assert.equal(source.snapshot, a.getIntegritySource().snapshot);
  await a.commitAction({ actionId: '1', clientId: 'teacher', ops: [{ type: 'upsert', object: { boardObjectId: 'x', left: 10 } }] });
  assert.equal(a.getIntegritySource().revision, 1);
  assert.equal(a.getIntegritySource().snapshot.canvas.objects[0].left, 10);
});
test('same-revision targeted replica repair fixes ghosts/order without creating commits', () => {
  const id = 'integrity-replica';
  replicas.installReplicaSnapshot(id, { ...empty, canvas: { objects: [{ boardObjectId: 'ghost' }, { boardObjectId: 'x', left: 1 }] } }, 7);
  assert.equal(typeof replicas.repairReplicaIntegrityRecords, 'function');
  const repairs = [{ id: 'ghost', count: 0, object: null, zIndex: -1 }, { id: 'x', count: 1, object: { boardObjectId: 'x', left: 20 }, zIndex: 0 }];
  assert.equal(replicas.repairReplicaIntegrityRecords(id, 6, repairs), false);
  assert.equal(replicas.repairReplicaIntegrityRecords(id, 7, repairs), true);
  const s = replicas.getReplicaState(id);
  assert.equal(s.revision, 7); assert.deepEqual(s.snapshot.canvas.objects, [{ boardObjectId: 'x', left: 20 }]);
  assert.deepEqual(replicas.getReplicaChangesAfter(id), []);
  replicas.clearReplicaState(id);
});
