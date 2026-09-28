import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createDualPathPeerPair,
  OWNER_INITIATED_PATH,
  STUDENT_INITIATED_PATH,
} from '../src/lib/dualPathPeerPair.js';

const flush = async () => { for (let i = 0; i < 30; i += 1) await Promise.resolve(); };

function harness(role, overrides = {}) {
  const created = [];
  const sent = [];
  const selected = [];
  const pair = createDualPathPeerPair({
    localRole: role,
    peerId: role === 'owner' ? 'student' : 'owner',
    signaling: { send: async (_peerId, signal) => { sent.push(signal); } },
    primaryPathTimeoutMs: 40,
    connectTimeoutMs: 200,
    createConnection: (options) => {
      const record = { options, starts: 0, closes: 0, handled: [] };
      record.connection = {
        async start() { record.starts += 1; },
        async handleSignal(signal) { record.handled.push(signal); },
        close() { record.closes += 1; },
      };
      created.push(record);
      return record.connection;
    },
    onSelectedChannel: (_channel, path) => selected.push(path),
    ...overrides,
  });
  return { pair, created, sent, selected };
}

test('owner tests only the preferred owner-initiated path first', async () => {
  const { pair, created } = harness('owner');
  await pair.start();
  assert.equal(created.length, 1);
  assert.equal(created[0].options.initiator, true);
  assert.equal(pair.getCandidateCount(), 1);
  pair.close();
});

test('student precreates only a silent responder while owner path is being tested', async () => {
  const { pair, created } = harness('student');
  await pair.start();
  assert.equal(created.length, 1);
  assert.equal(created[0].options.initiator, false);
  await pair.handleSignal({
    type: 'offer',
    path: OWNER_INITIATED_PATH,
    negotiationId: 'owner-1',
    description: { type: 'offer', sdp: 'owner' },
  });
  assert.equal(created.length, 1);
  pair.close();
});

test('owner switches to student-initiated fallback after primary timeout', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { pair, created, sent } = harness('owner');
  await pair.start();
  t.mock.timers.tick(40);
  await flush();
  assert.equal(created[0].closes, 1);
  assert.equal(created.length, 2);
  assert.equal(created[1].options.initiator, false);
  assert.ok(sent.some((signal) => signal.type === 'path-switch'
    && signal.path === STUDENT_INITIATED_PATH));
  pair.close();
});

test('student switches to its initiator fallback when owner requests it', async () => {
  const { pair, created } = harness('student');
  await pair.start();
  await pair.handleSignal({ type: 'path-switch', path: STUDENT_INITIATED_PATH });
  assert.equal(created.length, 1);
  assert.equal(created[0].options.initiator, true);
  pair.close();
});

test('fallback offer makes owner abandon preferred path without parallel candidates', async () => {
  const { pair, created } = harness('owner');
  await pair.start();
  await pair.handleSignal({
    type: 'offer',
    path: STUDENT_INITIATED_PATH,
    negotiationId: 'student-1',
    description: { type: 'offer', sdp: 'student' },
  });
  assert.equal(created.length, 2);
  assert.equal(created[0].closes, 1);
  assert.equal(created[1].options.initiator, false);
  assert.equal(pair.getCandidateCount(), 1);
  pair.close();
});

test('owner selects the currently active path when its durable channel opens', async () => {
  const { pair, created, selected, sent } = harness('owner');
  await pair.start();
  created[0].options.onChannel({ label: 'alex-board-durable-v1', close() {} });
  assert.deepEqual(selected, [OWNER_INITIATED_PATH]);
  assert.ok(sent.some((signal) => signal.type === 'path-select'
    && signal.path === OWNER_INITIATED_PATH));
  pair.close();
});

test('student attaches immediately when the only active durable path opens', async () => {
  const { pair, created, selected } = harness('student');
  await pair.start();
  await pair.handleSignal({
    type: 'offer',
    path: OWNER_INITIATED_PATH,
    negotiationId: 'owner-1',
    description: { type: 'offer', sdp: 'owner' },
  });
  created[0].options.onChannel({ label: 'alex-board-durable-v1', close() {} });
  assert.deepEqual(selected, [OWNER_INITIATED_PATH]);
  pair.close();
});
