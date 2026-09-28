import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createDualPathPeerPair,
  OWNER_INITIATED_PATH,
  STUDENT_INITIATED_PATH,
} from '../src/lib/dualPathPeerPair.js';

const flush = async () => { for (let i = 0; i < 30; i += 1) await Promise.resolve(); };

function createHarness(role, { onSelectedChannel = () => {} } = {}) {
  const created = [];
  const sent = [];
  const pair = createDualPathPeerPair({
    localRole: role,
    peerId: role === 'owner' ? 'student' : 'owner',
    signaling: { send: async (_peerId, signal) => { sent.push(signal); } },
    ownerPreferenceGraceMs: 100,
    connectTimeoutMs: 1000,
    createConnection: (options) => {
      const record = { options, handled: [], starts: 0, closes: 0, replays: 0 };
      record.connection = {
        async start() { record.starts += 1; },
        async handleSignal(signal) { record.handled.push(signal); },
        resendSignaling() { record.replays += 1; },
        close() { record.closes += 1; },
      };
      created.push(record);
      return record.connection;
    },
    onSelectedChannel,
  });
  return { pair, created, sent };
}

test('owner starts the owner-initiated candidate and can also accept student offer', async () => {
  const { pair, created } = createHarness('owner');
  await pair.start();
  assert.equal(created.length, 1);
  assert.equal(created[0].options.initiator, true);

  await pair.handleSignal({
    type: 'offer',
    path: STUDENT_INITIATED_PATH,
    negotiationId: 'student-attempt',
    description: { type: 'offer', sdp: 'student' },
  });
  assert.equal(created.length, 2);
  assert.equal(created[1].options.initiator, false);
  assert.equal(created[1].handled.length, 1);
  pair.close();
});

test('owner prefers owner-initiated path when both durable channels open', async () => {
  const selected = [];
  const { pair, created } = createHarness('owner', {
    onSelectedChannel: (_channel, path) => selected.push(path),
  });
  await pair.start();
  await pair.handleSignal({
    type: 'offer',
    path: STUDENT_INITIATED_PATH,
    negotiationId: 'student-attempt',
    description: { type: 'offer', sdp: 'student' },
  });

  created[1].options.onChannel({ label: 'alex-board-durable-v1', close() {} });
  assert.deepEqual(selected, []);
  created[0].options.onChannel({ label: 'alex-board-durable-v1', close() {} });
  assert.deepEqual(selected, [OWNER_INITIATED_PATH]);
  assert.equal(pair.getSelectedPath(), OWNER_INITIATED_PATH);
  pair.close();
});

test('owner selects student-initiated fallback if preferred path does not open', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const selected = [];
  const { pair, created } = createHarness('owner', {
    onSelectedChannel: (_channel, path) => selected.push(path),
  });
  await pair.start();
  await pair.handleSignal({
    type: 'offer',
    path: STUDENT_INITIATED_PATH,
    negotiationId: 'student-attempt',
    description: { type: 'offer', sdp: 'student' },
  });
  created[1].options.onChannel({ label: 'alex-board-durable-v1', close() {} });
  t.mock.timers.tick(99); await flush();
  assert.deepEqual(selected, []);
  t.mock.timers.tick(1); await flush();
  assert.deepEqual(selected, [STUDENT_INITIATED_PATH]);
  pair.close();
});

test('student waits for owner path-select when peer supports dual-path signaling', async () => {
  const selected = [];
  const { pair, created } = createHarness('student', {
    onSelectedChannel: (_channel, path) => selected.push(path),
  });
  await pair.start();
  await pair.handleSignal({
    type: 'answer',
    path: STUDENT_INITIATED_PATH,
    negotiationId: 'student-local',
    description: { type: 'answer', sdp: 'answer' },
  });
  created[0].options.onChannel({ label: 'alex-board-durable-v1', close() {} });
  assert.deepEqual(selected, []);

  await pair.handleSignal({ type: 'path-select', path: STUDENT_INITIATED_PATH });
  assert.deepEqual(selected, [STUDENT_INITIATED_PATH]);
  pair.close();
});

test('student keeps compatibility with an older owner that does not send path-select', async () => {
  const selected = [];
  const { pair, created } = createHarness('student', {
    onSelectedChannel: (_channel, path) => selected.push(path),
  });
  await pair.start();
  created[0].options.onChannel({ label: 'alex-board-durable-v1', close() {} });
  assert.deepEqual(selected, [STUDENT_INITIATED_PATH]);
  pair.close();
});
