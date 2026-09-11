import assert from 'node:assert/strict';
import test from 'node:test';
import { createTeacherBoardRuntime } from '../src/lib/teacherBoardRuntime.js';

test('durably commits teacher actions before broadcasting them to students', async () => {
  const order = [];
  const authority = {
    getRevision: () => 3,
    getSnapshot: () => ({ version: 2 }),
    getCommitsAfter: async () => [],
    compactSnapshot: async () => 3,
    async commitAction(action) {
      order.push('persist');
      return { ...action, revision: 4, duplicate: false };
    },
  };
  const hub = {
    addPeer: () => () => {}, removePeer: () => {}, handleMessage: async () => {},
    async broadcastCommit(commit) { order.push(`broadcast:${commit.revision}`); },
  };
  let signalHandler;
  const runtime = await createTeacherBoardRuntime({
    boardId: 'board-a',
    clientId: 'teacher-a',
    sendScreenShareSignal: async () => {},
    openAuthority: async () => authority,
    createHub: () => hub,
    createSignaling: ({ onSignal }) => {
      signalHandler = onSignal;
      return { send: async () => {}, handle: (payload) => onSignal(payload) };
    },
    createNetwork: () => ({
      handleSignal: async (message) => order.push(`signal:${message.sourceId}`),
      close() { order.push('close'); },
    }),
  });

  const commit = await runtime.commitTeacherAction({ actionId: 'teacher-action', clientId: 'teacher-a', ops: [] });
  assert.equal(commit.revision, 4);
  assert.deepEqual(order, ['persist', 'broadcast:4']);

  await signalHandler({ sourceId: 'student-a', signal: { type: 'offer' } });
  assert.deepEqual(order, ['persist', 'broadcast:4', 'signal:student-a']);
});

test('does not rebroadcast a durable duplicate teacher action', async () => {
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
      commitAction: async (action) => ({ ...action, revision: 9, duplicate: true }),
    }),
    createHub: () => ({
      addPeer: () => () => {}, removePeer: () => {}, handleMessage: async () => {},
      broadcastCommit: async () => { broadcasts += 1; },
    }),
    createSignaling: ({ onSignal }) => ({ send: async () => {}, handle: onSignal }),
    createNetwork: () => ({ handleSignal: async () => {}, close() {} }),
  });

  await runtime.commitTeacherAction({ actionId: 'same-action', ops: [] });
  assert.equal(broadcasts, 0);
});
