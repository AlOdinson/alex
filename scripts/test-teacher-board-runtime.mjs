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

test('peer edit authorization follows fresh local guest mode and never trusts the student', async () => {
  let guestMode = 'edit';
  let hubOptions = null;
  await createTeacherBoardRuntime({
    boardId: 'board-a',
    clientId: 'teacher-a',
    sendScreenShareSignal: async () => {},
    openAuthority: async () => ({
      getRevision: () => 0,
      getSnapshot: () => ({}),
      getCommitsAfter: async () => [],
      compactSnapshot: async () => 0,
      commitAction: async (action) => ({ ...action, revision: 1 }),
    }),
    getBoardMetadata: async (boardId) => ({ boardId, guestMode }),
    createHub: (options) => {
      hubOptions = options;
      return {
        addPeer: () => () => {}, removePeer: () => {}, handleMessage: async () => {},
        broadcastCommit: async () => {},
      };
    },
    createSignaling: ({ onSignal }) => ({ send: async () => {}, handle: onSignal }),
    createNetwork: () => ({ handleSignal: async () => {}, close() {} }),
  });

  assert.equal(typeof hubOptions?.canPeerEdit, 'function');
  assert.equal(await hubOptions.canPeerEdit('student-spoofing-edit'), true);
  guestMode = 'view';
  assert.equal(await hubOptions.canPeerEdit('student-spoofing-edit'), false);
});


test('exposes teacher live broadcast without changing durable authority', async () => {
  const live = [];
  let networkOptions = null;
  const onLiveEvent = () => {};
  const onLiveState = () => {};
  const runtime = await createTeacherBoardRuntime({
    boardId: 'board-live',
    clientId: 'teacher-live',
    sendScreenShareSignal: async () => {},
    onLiveEvent,
    onLiveState,
    openAuthority: async () => ({
      getRevision: () => 11,
      getSnapshot: () => ({}),
      getCommitsAfter: async () => [],
      compactSnapshot: async () => 11,
      commitAction: async (action) => ({ ...action, revision: 12, duplicate: false }),
    }),
    createHub: () => ({
      addPeer: () => () => {}, removePeer: () => {}, handleMessage: async () => {},
      broadcastCommit: async () => {},
    }),
    createSignaling: ({ onSignal }) => ({ send: async () => {}, handle: onSignal }),
    createNetwork: (options) => {
      networkOptions = options;
      return {
        async handleSignal() {},
        broadcastLive(type, payload, sendOptions) {
          live.push({ type, payload, sendOptions });
          return [{ peerId: 'student-a', result: 'sent' }];
        },
        sendLive(peerId, type, payload, sendOptions) {
          live.push({ peerId, type, payload, sendOptions });
          return 'sent';
        },
        getLiveState: () => 'open',
        getLiveStats: () => ({ sent: 2 }),
        close() {},
      };
    },
  });

  assert.equal(networkOptions.boardId, 'board-live');
  assert.equal(networkOptions.clientId, 'teacher-live');
  assert.equal(networkOptions.getRevision(), 11);
  assert.equal(networkOptions.onLiveEvent, onLiveEvent);
  assert.equal(networkOptions.onLiveState, onLiveState);

  assert.deepEqual(
    runtime.sendLive('cursor', { x: 1 }, { streamKey: 'cursor' }),
    [{ peerId: 'student-a', result: 'sent' }],
  );
  assert.equal(runtime.sendLiveTo('student-a', 'transform', { left: 4 }, { streamKey: 'transform:x' }), 'sent');
  assert.equal(runtime.getLiveState('student-a'), 'open');
  assert.deepEqual(runtime.getLiveStats('student-a'), { sent: 2 });
  assert.equal(live.length, 2);
});
