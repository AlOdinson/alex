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
