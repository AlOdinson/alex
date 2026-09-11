import assert from 'node:assert/strict';
import test from 'node:test';
import { createTeacherBoardRuntime } from '../src/lib/teacherBoardRuntime.js';

function makeNetwork() {
  return { handleSignal: async () => {}, getPeerCount: () => 0, close() {} };
}

test('teacher runtime uses the same lock authority for local lock requests and peer hub', async () => {
  const calls = [];
  const lockAuthority = {
    acquire(input) { calls.push(['acquire', input]); return { granted: true, objectIds: input.objectIds }; },
    refresh(input) { calls.push(['refresh', input]); return { refreshed: true, objectIds: ['shape-1'] }; },
    release(input) { calls.push(['release', input]); return { released: 1, objectIds: ['shape-1'] }; },
    getConflicts() { return []; },
  };
  let hubOptions;
  const runtime = await createTeacherBoardRuntime({
    boardId: 'board-a',
    clientId: 'teacher-a',
    sendScreenShareSignal: async () => {},
    openAuthority: async () => ({
      getRevision: () => 0,
      getSnapshot: () => ({}),
      getCommitsAfter: async () => [],
      compactSnapshot: async () => 0,
      commitAction: async (action) => ({ ...action, revision: 1, duplicate: false }),
    }),
    createLockAuthority: () => lockAuthority,
    createHub: (options) => {
      hubOptions = options;
      return {
        addPeer: () => () => {}, removePeer: () => {}, handleMessage: async () => {},
        broadcastCommit: async () => {},
      };
    },
    createSignaling: ({ onSignal }) => ({ send: async () => {}, handle: onSignal }),
    createNetwork: makeNetwork,
  });

  assert.equal(hubOptions.lockAuthority, lockAuthority);
  assert.equal(typeof runtime.requestLock, 'function');
  await runtime.requestLock('acquire', {
    lockToken: 'teacher-token', objectIds: ['shape-1'], ttlMs: 12_000,
  });
  await runtime.requestLock('refresh', { lockToken: 'teacher-token', ttlMs: 12_000 });
  await runtime.requestLock('release', { lockToken: 'teacher-token' });
  assert.deepEqual(calls, [
    ['acquire', { clientId: 'teacher-a', lockToken: 'teacher-token', objectIds: ['shape-1'], ttlMs: 12_000 }],
    ['refresh', { clientId: 'teacher-a', lockToken: 'teacher-token', ttlMs: 12_000 }],
    ['release', { clientId: 'teacher-a', lockToken: 'teacher-token' }],
  ]);
});

test('teacher durable action is rejected before persistence when a student owns the lock', async () => {
  let persistCalls = 0;
  let broadcasts = 0;
  const runtime = await createTeacherBoardRuntime({
    boardId: 'board-a',
    clientId: 'teacher-a',
    sendScreenShareSignal: async () => {},
    openAuthority: async () => ({
      getRevision: () => 9,
      getSnapshot: () => ({}),
      getCommitsAfter: async () => [],
      compactSnapshot: async () => 9,
      async commitAction() { persistCalls += 1; return null; },
    }),
    createLockAuthority: () => ({
      acquire: () => null,
      refresh: () => null,
      release: () => null,
      getConflicts({ clientId, objectIds }) {
        assert.equal(clientId, 'teacher-a');
        assert.deepEqual(objectIds, ['shape-1']);
        return [{ objectId: 'shape-1', clientId: 'student-a', expiresAt: 20_000 }];
      },
    }),
    createHub: () => ({
      addPeer: () => () => {}, removePeer: () => {}, handleMessage: async () => {},
      broadcastCommit: async () => { broadcasts += 1; },
    }),
    createSignaling: ({ onSignal }) => ({ send: async () => {}, handle: onSignal }),
    createNetwork: makeNetwork,
  });

  const result = await runtime.commitTeacherAction({
    actionId: 'teacher-blocked',
    clientId: 'spoofed-teacher',
    ops: [{ type: 'delete', id: 'shape-1' }],
  });

  assert.equal(persistCalls, 0);
  assert.equal(broadcasts, 0);
  assert.deepEqual(result, {
    actionId: 'teacher-blocked',
    revision: 9,
    changed: false,
    duplicate: false,
    needsSync: false,
    appliedOps: [],
    appliedBackground: null,
    rejectedObjectIds: ['shape-1'],
    skippedConflicts: [],
  });
});
