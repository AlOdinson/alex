import assert from 'node:assert/strict';
import test from 'node:test';
import { createTeacherPeerNetwork } from '../src/lib/teacherPeerNetwork.js';
import { OWNER_INITIATED_PATH, STUDENT_INITIATED_PATH } from '../src/lib/dualPathPeerPair.js';

const flush = async () => { for (let i = 0; i < 20; i += 1) await Promise.resolve(); };

function makeNetwork(overrides = {}) {
  const created = [];
  const sent = [];
  const removed = [];
  const added = [];
  let transportOptions = null;
  const network = createTeacherPeerNetwork({
    clientId: 'teacher',
    signaling: { send: async (peerId, signal) => sent.push({ peerId, signal }) },
    peerHub: {
      addPeer(peerId, transport) { added.push({ peerId, transport }); return () => {}; },
      removePeer(peerId) { removed.push(peerId); },
      async handleMessage() {},
    },
    createConnection: (options) => {
      const record = { options, handled: [], closed: 0, starts: 0, replayed: 0 };
      record.connection = {
        async start() { record.starts += 1; },
        async handleSignal(signal) { record.handled.push(signal); },
        resendSignaling() { record.replayed += 1; },
        close() { record.closed += 1; },
      };
      created.push(record);
      return record.connection;
    },
    createTransport: (options) => {
      transportOptions = options;
      return { send: async () => {}, sendTextTransfer: async () => {}, close() {} };
    },
    ...overrides,
  });
  return { network, created, sent, removed, added, getTransportOptions: () => transportOptions };
}

test('teacher starts owner path and accepts independent student path', async () => {
  const { network, created } = makeNetwork();
  await network.handleSignal({
    sourceId: 'student-a',
    signal: { type: 'offer', negotiationId: 'student-a-1', description: { type: 'offer', sdp: 'x' } },
  });
  assert.equal(created.length, 2);
  assert.equal(created.filter((entry) => entry.options.initiator).length, 1);
  assert.equal(created.filter((entry) => !entry.options.initiator).length, 1);
  network.close();
});

test('preferred owner path is the only path attached to teacher hub when it opens', async () => {
  const { network, created, added } = makeNetwork();
  await network.handleSignal({
    sourceId: 'student-a',
    signal: { type: 'offer', path: STUDENT_INITIATED_PATH, negotiationId: 'student-a-1',
      description: { type: 'offer', sdp: 'x' } },
  });
  const owner = created.find((entry) => entry.options.initiator);
  const student = created.find((entry) => !entry.options.initiator);
  student.options.onChannel({ label: 'alex-board-durable-v1', close() {} });
  assert.equal(added.length, 0, 'fallback stays isolated while preferred path is being tested');
  owner.options.onChannel({ label: 'alex-board-durable-v1', close() {} });
  assert.equal(added.length, 1);
  assert.equal(network.getSelectedPath('student-a'), OWNER_INITIATED_PATH);
  network.close();
});

test('a new student negotiation replaces only the student-path candidate', async () => {
  const { network, created } = makeNetwork();
  await network.handleSignal({
    sourceId: 'student-a',
    signal: { type: 'offer', path: STUDENT_INITIATED_PATH, negotiationId: 'one',
      description: { type: 'offer', sdp: 'one' } },
  });
  await network.handleSignal({
    sourceId: 'student-a',
    signal: { type: 'offer', path: STUDENT_INITIATED_PATH, negotiationId: 'two',
      description: { type: 'offer', sdp: 'two' } },
  });
  assert.equal(created.length, 3);
  const owner = created.find((entry) => entry.options.initiator);
  const responders = created.filter((entry) => !entry.options.initiator);
  assert.equal(owner.closed, 0);
  assert.equal(responders[0].closed, 1);
  assert.equal(responders[1].closed, 0);
  network.close();
});

test('selected durable failure removes the peer without stale loser callbacks removing a replacement', async () => {
  const { network, created, removed } = makeNetwork();
  await network.handleSignal({
    sourceId: 'student-a',
    signal: { type: 'offer', path: STUDENT_INITIATED_PATH, negotiationId: 'one',
      description: { type: 'offer', sdp: 'one' } },
  });
  const owner = created.find((entry) => entry.options.initiator);
  owner.options.onChannel({ label: 'alex-board-durable-v1', close() {} });
  owner.options.onConnectionState('failed');
  await flush();
  assert.equal(network.getPeerCount(), 0);
  assert.deepEqual(removed, ['student-a']);
  network.close();
});
