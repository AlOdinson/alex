import assert from 'node:assert/strict';
import test from 'node:test';
import { createTeacherPeerNetwork } from '../src/lib/teacherPeerNetwork.js';

test('creates one responder connection per student and routes signaling', async () => {
  const sentSignals = [];
  const created = [];
  const handled = [];
  const network = createTeacherPeerNetwork({
    signaling: { send: async (peerId, signal) => sentSignals.push({ peerId, signal }) },
    peerHub: { addPeer: () => () => {}, removePeer: () => {}, handleMessage: async () => {} },
    createConnection: (options) => {
      const connection = {
        async start() {},
        async handleSignal(signal) { handled.push(signal); },
        close() {},
      };
      created.push({ options, connection });
      return connection;
    },
    createTransport: () => ({ send: async () => {}, sendTextTransfer: async () => {}, close() {} }),
  });

  await network.handleSignal({ sourceId: 'student-a', signal: { type: 'offer' } });
  await network.handleSignal({ sourceId: 'student-a', signal: { type: 'ice' } });

  assert.equal(created.length, 1);
  assert.equal(created[0].options.initiator, false);
  assert.deepEqual(handled, [{ type: 'offer' }, { type: 'ice' }]);

  await created[0].options.sendSignal({ type: 'answer' });
  assert.deepEqual(sentSignals, [{ peerId: 'student-a', signal: { type: 'answer' } }]);
});

test('attaches an opened data channel to the teacher hub and removes it on failure', async () => {
  const added = [];
  const removed = [];
  const hubMessages = [];
  let connectionOptions;
  let transportOptions;
  let transportClosed = 0;
  let unregisterCount = 0;

  const network = createTeacherPeerNetwork({
    signaling: { send: async () => {} },
    peerHub: {
      addPeer(peerId, transport) {
        added.push({ peerId, transport });
        return () => { unregisterCount += 1; };
      },
      removePeer(peerId) { removed.push(peerId); },
      async handleMessage(peerId, message) { hubMessages.push({ peerId, message }); },
    },
    createConnection: (options) => {
      connectionOptions = options;
      return { async start() {}, async handleSignal() {}, close() {} };
    },
    createTransport: (options) => {
      transportOptions = options;
      return {
        send: async () => {},
        sendTextTransfer: async () => {},
        close() { transportClosed += 1; },
      };
    },
  });

  await network.handleSignal({ sourceId: 'student-b', signal: { type: 'offer' } });
  connectionOptions.onChannel({ label: 'alex-board-durable-v1' });

  assert.equal(added.length, 1);
  assert.equal(added[0].peerId, 'student-b');
  await transportOptions.onMessage({ type: 'head-request', payload: {} });
  assert.deepEqual(hubMessages, [{ peerId: 'student-b', message: { type: 'head-request', payload: {} } }]);

  connectionOptions.onConnectionState('failed');
  assert.equal(transportClosed, 1);
  assert.equal(unregisterCount, 1);
  assert.deepEqual(removed, ['student-b']);
});

test('late terminal state from a replaced connection cannot close the reconnect', async () => {
  const created = [];
  const removed = [];
  const network = createTeacherPeerNetwork({
    signaling: { send: async () => {} },
    peerHub: {
      addPeer: () => () => {},
      removePeer(peerId) { removed.push(peerId); },
      async handleMessage() {},
    },
    createConnection: (options) => {
      const record = { options, closed: 0 };
      const connection = {
        async start() {},
        async handleSignal() {},
        close() { record.closed += 1; },
      };
      record.connection = connection;
      created.push(record);
      return connection;
    },
    createTransport: () => ({ send: async () => {}, sendTextTransfer: async () => {}, close() {} }),
  });

  await network.handleSignal({ sourceId: 'student-reload', signal: { type: 'offer', generation: 1 } });
  assert.equal(created.length, 1);
  assert.equal(network.getPeerCount(), 1);

  // The first connection disconnects and is removed. A new offer can now create the
  // replacement before the old RTCPeerConnection emits its final "closed" state.
  created[0].options.onConnectionState('disconnected');
  assert.equal(network.getPeerCount(), 0);
  await network.handleSignal({ sourceId: 'student-reload', signal: { type: 'offer', generation: 2 } });
  assert.equal(created.length, 2);
  assert.equal(network.getPeerCount(), 1);

  // This callback belongs to connection #1. It must not resolve student-reload to the
  // newly-created connection #2 and close that replacement.
  created[0].options.onConnectionState('closed');

  assert.equal(network.getPeerCount(), 1, 'stale old connection callback removed the replacement peer');
  assert.equal(created[1].closed, 0, 'stale old connection callback closed the replacement connection');
  assert.equal(removed.length, 1, 'replacement peer was removed from the hub by stale cleanup');
});


test('attaches live transport separately and a live-only close does not remove durable peer', async () => {
  let connectionOptions;
  let liveOptions;
  let durableClosed = 0;
  let liveClosed = 0;
  const removed = [];
  const liveEvents = [];
  const liveStates = [];
  const sentLive = [];

  const network = createTeacherPeerNetwork({
    boardId: 'board-live',
    clientId: 'teacher-a',
    getRevision: () => 12,
    signaling: { send: async () => {} },
    peerHub: {
      addPeer: () => () => {},
      removePeer(peerId) { removed.push(peerId); },
      async handleMessage() {},
    },
    createConnection: (options) => {
      connectionOptions = options;
      return { async start() {}, async handleSignal() {}, close() {} };
    },
    createTransport: () => ({
      send: async () => {},
      sendTextTransfer: async () => {},
      close() { durableClosed += 1; },
    }),
    createLiveTransport: (options) => {
      liveOptions = options;
      return {
        send(type, payload, sendOptions) {
          sentLive.push({ type, payload, sendOptions });
          return 'sent';
        },
        stats: () => ({ sent: 1 }),
        close() { liveClosed += 1; },
      };
    },
    onLiveEvent: (peerId, type, payload) => liveEvents.push({ peerId, type, payload }),
    onLiveState: (peerId, state) => liveStates.push({ peerId, state }),
  });

  await network.handleSignal({ sourceId: 'student-live', signal: { type: 'offer' } });
  connectionOptions.onChannel({ label: 'alex-board-durable-v1' });
  connectionOptions.onLiveChannel({ label: 'alex-board-live-v1' });

  assert.equal(network.getPeerCount(), 1);
  assert.equal(network.sendLive('student-live', 'cursor', { x: 4 }, { streamKey: 'cursor' }), 'sent');
  assert.deepEqual(sentLive, [{
    type: 'cursor',
    payload: { x: 4 },
    sendOptions: { streamKey: 'cursor' },
  }]);

  liveOptions.onEvent('cursor', { x: 8 }, { seq: 3 });
  assert.deepEqual(liveEvents, [{
    peerId: 'student-live',
    type: 'cursor',
    payload: { x: 8 },
  }]);

  liveOptions.onState('closed');
  assert.equal(network.getPeerCount(), 1, 'live-only close must not retire durable peer');
  assert.equal(durableClosed, 0);
  assert.deepEqual(removed, []);
  assert.deepEqual(liveStates.at(-1), { peerId: 'student-live', state: 'closed' });

  connectionOptions.onConnectionState('failed');
  assert.equal(durableClosed, 1);
  assert.equal(liveClosed, 1);
  assert.deepEqual(removed, ['student-live']);
});
