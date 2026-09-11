import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserBoardRepository } from '../src/lib/browserBoardRepositoryCompat.js';

function makeRepository(runtime = null) {
  return createBrowserBoardRepository({
    getRuntime: () => runtime,
    getBoard: async () => null,
    listBoards: async () => [],
    getReplica: () => null,
    getReplicaChanges: () => [],
    installReplicaSnapshot: () => {},
  });
}

test('legacy acquire and refresh lock APIs delegate to the active board runtime', async () => {
  const calls = [];
  const runtime = {
    async requestLock(operation, payload) {
      calls.push({ operation, payload });
      if (operation === 'acquire') {
        return {
          granted: true,
          objectIds: payload.objectIds,
          lockToken: payload.lockToken,
          expiresAt: 50_000,
          conflicts: [],
        };
      }
      return {
        refreshed: true,
        objectIds: ['shape-1'],
        lockToken: payload.lockToken,
        expiresAt: 55_000,
      };
    },
  };
  const repo = makeRepository(runtime);

  const acquired = await repo.acquireBoardObjectLocks(
    'board-a', 'ignored-secret', 'ignored-client', 'lock-token-123', ['shape-1'],
  );
  const refreshed = await repo.refreshBoardObjectLocks(
    'board-a', 'ignored-secret', 'ignored-client', 'lock-token-123',
  );

  assert.equal(acquired.granted, true);
  assert.equal(refreshed.refreshed, true);
  assert.deepEqual(calls, [
    {
      operation: 'acquire',
      payload: { lockToken: 'lock-token-123', objectIds: ['shape-1'], ttlMs: 12_000 },
    },
    {
      operation: 'refresh',
      payload: { lockToken: 'lock-token-123', ttlMs: 12_000 },
    },
  ]);
});

test('legacy release returns the old numeric count while using peer runtime internally', async () => {
  const calls = [];
  const repo = makeRepository({
    async requestLock(operation, payload) {
      calls.push({ operation, payload });
      return { released: 2, objectIds: ['shape-1', 'shape-2'] };
    },
  });

  const released = await repo.releaseBoardObjectLocks(
    'board-a', 'ignored-secret', 'ignored-client', 'lock-token-123',
  );
  assert.equal(released, 2);
  assert.deepEqual(calls, [{
    operation: 'release',
    payload: { lockToken: 'lock-token-123' },
  }]);
});

test('acquire fails clearly before a board runtime is ready while cleanup stays harmless', async () => {
  const repo = makeRepository(null);
  await assert.rejects(
    () => repo.acquireBoardObjectLocks('board-a', 'key', 'client', 'lock-token-123', ['shape-1']),
    /runtime.*not ready/i,
  );
  assert.deepEqual(await repo.refreshBoardObjectLocks('board-a', 'key', 'client', 'lock-token-123'), {
    refreshed: false,
    objectIds: [],
  });
  assert.equal(await repo.releaseBoardObjectLocks('board-a', 'key', 'client', 'lock-token-123'), 0);
  assert.deepEqual(await repo.getBoardObjectLocks('board-a', 'key'), []);
});
