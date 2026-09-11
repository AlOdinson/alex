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
