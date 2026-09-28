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

test('teacher starts only owner-initiated primary path for a present student', async () => {
  const { network, created } = makeNetwork();
  network.updateParticipants(['student-a']);
  await flush();
  assert.equal(created.length, 1);
  assert.equal(created[0].options.initiator, true);
  assert.equal(network.getPeerCount(), 1);
  network.close();
});

test('teacher attaches primary owner path immediately when its durable channel opens', async () => {
  const { network, created, added, sent } = makeNetwork();
  network.updateParticipants(['student-a']);
  await flush();
  const owner = created[0];
  owner.options.onChannel({ label: 'alex-board-durable-v1', close() {} });
  assert.equal(added.length, 1);
  assert.equal(network.getSelectedPath('student-a'), OWNER_INITIATED_PATH);
  assert.ok(sent.some(({ signal }) => signal.type === 'path-select'
    && signal.path === OWNER_INITIATED_PATH));
  network.close();
});

test('student fallback offer retires primary owner path before creating responder', async () => {
  const { network, created } = makeNetwork();
  network.updateParticipants(['student-a']);
  await flush();
  const owner = created[0];

  await network.handleSignal({
    sourceId: 'student-a',
    signal: {
      type: 'offer',
      path: STUDENT_INITIATED_PATH,
      negotiationId: 'student-fallback-1',
      description: { type: 'offer', sdp: 'fallback' },
    },
  });

  assert.equal(created.length, 2);
  assert.equal(owner.closed, 1);
  assert.equal(created[1].options.initiator, false);
  assert.equal(network.getPeerCount(), 1);
  network.close();
});

test('teacher attaches student-initiated fallback when responder channel opens', async () => {
  const { network, created, added, sent } = makeNetwork();
  network.updateParticipants(['student-a']);
  await flush();

  await network.handleSignal({
    sourceId: 'student-a',
    signal: {
      type: 'offer',
      path: STUDENT_INITIATED_PATH,
      negotiationId: 'student-fallback-1',
      description: { type: 'offer', sdp: 'fallback' },
    },
  });
  const responder = created.at(-1);
  responder.options.onChannel({ label: 'alex-board-durable-v1', close() {} });

  assert.equal(added.length, 1);
  assert.equal(network.getSelectedPath('student-a'), STUDENT_INITIATED_PATH);
  assert.ok(sent.some(({ signal }) => signal.type === 'path-select'
    && signal.path === STUDENT_INITIATED_PATH));
  network.close();
});

test('new fallback negotiation replaces only stale fallback responder', async () => {
  const { network, created } = makeNetwork();
  network.updateParticipants(['student-a']);
  await flush();

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
  assert.equal(created[0].closed, 1, 'primary was retired when fallback began');
  assert.equal(created[1].closed, 1, 'old fallback generation was retired');
  assert.equal(created[2].closed, 0);
  assert.equal(created[2].options.initiator, false);
  network.close();
});

test('selected durable path failure removes teacher peer', async () => {
  const { network, created, removed } = makeNetwork();
  network.updateParticipants(['student-a']);
  await flush();
  const owner = created[0];
  owner.options.onChannel({ label: 'alex-board-durable-v1', close() {} });
  owner.options.onConnectionState('failed');
  await flush();

  assert.equal(network.getPeerCount(), 0);
  assert.deepEqual(removed, ['student-a']);
  network.close();
});
