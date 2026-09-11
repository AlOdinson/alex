import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserBoardRepository } from '../src/lib/browserBoardRepositoryCompat.js';

const board = {
  boardId: 'board-a',
  ownerKey: 'owner-secret',
  shareKey: 'share-secret',
  realtimeKey: 'share-secret',
  title: 'Алгебра',
  studentName: 'Анна',
  guestMode: 'edit',
  gameLibraryVisible: false,
  revision: 3,
  snapshotRevision: 2,
  snapshot: { version: 2, background: 'grid', canvas: { objects: [] } },
  createdAt: 100,
  updatedAt: 200,
};

function makeRepository(overrides = {}) {
  const metadataUpdates = [];
  const deleted = [];
  const commits = [
    { actionId: 'a3', revision: 3, ops: [] },
  ];
  const repo = createBrowserBoardRepository({
    getBoard: async (boardId) => (boardId === 'board-a' ? { ...board } : null),
    listBoards: async () => [{ ...board }],
    createBoard: async () => ({ ...board }),
    updateBoard: async (boardId, patch) => { metadataUpdates.push({ boardId, patch }); return { ...board, ...patch }; },
    deleteBoardRecord: async (boardId) => { deleted.push(boardId); return true; },
    openAuthority: async () => ({
      getRevision: () => 3,
      getSnapshot: () => ({ version: 2, background: 'grid', canvas: { objects: [{ boardObjectId: 'x' }] } }),
      getCommitsAfter: async (revision, limit) => commits.filter((item) => item.revision > revision).slice(0, limit),
      commitAction: async (action) => ({ ...action, revision: 4, duplicate: false, needsSync: false }),
      compactSnapshot: async () => 3,
    }),
    getReplica: (boardId) => (boardId === 'student-board'
      ? { revision: 8, snapshot: { version: 2, background: 'dots', canvas: { objects: [] } } }
      : null),
    getReplicaChanges: () => [{ actionId: 'r8', revision: 8, ops: [] }],
    installReplicaSnapshot: () => {},
    ...overrides,
  });
  return { repo, metadataUpdates, deleted };
}

test('owner access is reconstructed from teacher browser authority', async () => {
  const { repo } = makeRepository();
  const access = await repo.getBoardAccess('board-a', 'owner-secret');
  assert.equal(access.permission, 'owner');
  assert.equal(access.realtimeKey, 'share-secret');
  assert.equal(access.revision, 3);
  assert.equal(access.snapshotRevision, 3);
  assert.equal(access.snapshot.canvas.objects[0].boardObjectId, 'x');
});

test('share access on the teacher browser uses local guest mode', async () => {
  const { repo } = makeRepository();
  const access = await repo.getBoardAccess('board-a', 'share-secret');
  assert.equal(access.permission, 'edit');
});

test('remote student can bootstrap from URL secret before teacher snapshot arrives', async () => {
  const { repo } = makeRepository();
  const access = await repo.getBoardAccess('student-board', 'remote-share-secret');
  assert.equal(access.permission, 'edit');
  assert.equal(access.realtimeKey, 'remote-share-secret');
  assert.equal(access.revision, 8);
  assert.equal(access.snapshot.background, 'dots');
});

test('revision, changes and recovery come from local authority or replica', async () => {
  const { repo } = makeRepository();
  assert.equal((await repo.getBoardRevision('board-a', 'owner-secret')).revision, 3);
  assert.deepEqual((await repo.getBoardChanges('board-a', 'owner-secret', 2)).map((x) => x.revision), [3]);
  assert.equal((await repo.getBoardRecovery('board-a', 'owner-secret')).revision, 3);

  assert.equal((await repo.getBoardRevision('student-board', 'remote-share-secret')).revision, 8);
  assert.deepEqual((await repo.getBoardChanges('student-board', 'remote-share-secret', 7)).map((x) => x.revision), [8]);
  assert.equal((await repo.getBoardRecovery('student-board', 'remote-share-secret')).snapshot.background, 'dots');
});

test('metadata and deletion remain entirely local', async () => {
  const { repo, metadataUpdates, deleted } = makeRepository();
  await repo.setBoardMetadata('board-a', 'owner-secret', { title: 'Geometry', studentName: 'Ben' });
  await repo.setGuestMode('board-a', 'owner-secret', 'view');
  await repo.deleteBoard('board-a', 'owner-secret');
  assert.deepEqual(metadataUpdates, [
    { boardId: 'board-a', patch: { title: 'Geometry', studentName: 'Ben' } },
    { boardId: 'board-a', patch: { guestMode: 'view' } },
  ]);
  assert.deepEqual(deleted, ['board-a']);
});

test('rejects owner-only mutations when owner key is wrong', async () => {
  const { repo } = makeRepository();
  await assert.rejects(() => repo.setGuestMode('board-a', 'share-secret', 'view'), /owner/i);
  await assert.rejects(() => repo.deleteBoard('board-a', 'wrong',), /owner/i);
});

test('remote student snapshot compaction cannot overwrite the authoritative replica', async () => {
  let replicaInstalls = 0;
  const { repo } = makeRepository({
    installReplicaSnapshot: () => { replicaInstalls += 1; },
  });
  const attempted = {
    version: 2,
    background: 'blank',
    canvas: { objects: [{ boardObjectId: 'local-only' }] },
  };

  const savedRevision = await repo.saveBoardSnapshot(
    'student-board',
    'remote-share-secret',
    attempted,
    8,
  );

  assert.equal(savedRevision, 8);
  assert.equal(replicaInstalls, 0, 'student compaction must never become a second replica writer');
  assert.equal((await repo.getBoardRecovery('student-board', 'remote-share-secret')).snapshot.background, 'dots');
});
