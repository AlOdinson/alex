import assert from 'node:assert/strict';
import test from 'node:test';
import { createStudentPeerNetwork } from '../src/lib/studentPeerNetwork.js';
import { createStudentBoardRuntime } from '../src/lib/studentBoardRuntime.js';

test('student peer network forwards lock requests to the active session', async () => {
  let connectionOptions;
  const lockRequests = [];
  const network = createStudentPeerNetwork({
    teacherId: 'teacher-a',
    signaling: { send: async () => {} },
    getRevision: () => 0,
    applyCommit: async () => {},
    installSnapshot: async () => {},
    createConnection: (options) => {
      connectionOptions = options;
      return { async start() {}, async handleSignal() {}, close() {} };
    },
    createTransport: () => ({ send: async () => {}, close() {} }),
    createSession: () => ({
      async start() {},
      async handleMessage() {},
      async handleTransfer() {},
      async proposeAction() {},
      async requestLock(operation, payload) {
        lockRequests.push({ operation, payload });
        return { operation, ok: true };
      },
      whenIdle: async () => {},
    }),
  });

  await assert.rejects(
    () => network.requestLock('acquire', { objectIds: ['shape-1'] }),
    /data channel is not ready/i,
  );

  connectionOptions.onChannel({ label: 'alex-board-durable-v1' });
  await Promise.resolve();
  const result = await network.requestLock('refresh', {
    lockToken: 'token-student-a', ttlMs: 12_000,
  });
  assert.deepEqual(result, { operation: 'refresh', ok: true });
  assert.deepEqual(lockRequests, [{
    operation: 'refresh',
    payload: { lockToken: 'token-student-a', ttlMs: 12_000 },
  }]);
});

test('student board runtime exposes lock requests without knowing transport details', async () => {
  const calls = [];
  const runtime = createStudentBoardRuntime({
    clientId: 'student-a',
    teacherId: 'teacher-a',
    sendScreenShareSignal: async () => {},
    getRevision: () => 0,
    applyCommit: async () => {},
    installSnapshot: async () => {},
    createSignaling: () => ({ send: async () => {}, handle: async () => true }),
    createNetwork: () => ({
      start: async () => {},
      handleSignal: async () => true,
      proposeAction: async () => {},
      requestLock: async (operation, payload) => {
        calls.push({ operation, payload });
        return { released: 1 };
      },
      whenIdle: async () => {},
      isReady: () => true,
      close() {},
    }),
  });

  assert.equal(typeof runtime.requestLock, 'function');
  const result = await runtime.requestLock('release', { lockToken: 'token-student-a' });
  assert.deepEqual(result, { released: 1 });
  assert.deepEqual(calls, [{ operation: 'release', payload: { lockToken: 'token-student-a' } }]);
});
