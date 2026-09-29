import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createDualPathPeerPair,
  OWNER_INITIATED_PATH,
  STUDENT_INITIATED_PATH,
} from '../src/lib/dualPathPeerPair.js';

const flush = async () => { for (let i = 0; i < 30; i += 1) await Promise.resolve(); };

for (const role of ['owner', 'student']) {
  for (const openBeforeStart of [false, true]) {
    test(`${role} preserves early fallback across start (open=${openBeforeStart})`, async (t) => {
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const failures = [];
      const { pair, created, selected } = harness(role, { onFatal: error => failures.push(error) });
      t.after(() => pair.close());
      await pair.handleSignal(role === 'student'
        ? { type: 'path-switch', path: STUDENT_INITIATED_PATH }
        : { type: 'offer', path: STUDENT_INITIATED_PATH, negotiationId: 'early-fallback',
          description: { type: 'offer', sdp: 'student' } });
      const channel = { label: 'alex-board-durable-v1', close() { throw new Error('Viable channel retired'); } };
      if (openBeforeStart) created[0].options.onChannel(channel);
      await pair.start();
      await pair.start();
      assert.equal(pair.getCandidateCount(), 1, 'startup must not create a competing primary');
      assert.equal(pair.getCandidateState(OWNER_INITIATED_PATH), null);
      if (!openBeforeStart) created[0].options.onChannel(channel);
      assert.deepEqual(selected, [STUDENT_INITIATED_PATH]);
      t.mock.timers.tick(1000);
      await flush();
      assert.equal(failures.length, 0);
      assert.equal(pair.getSelectedPath(), STUDENT_INITIATED_PATH);
    });
  }
}

function harness(role, overrides = {}) {
  const created = [];
  const sent = [];
  const selected = [];
  const pair = createDualPathPeerPair({
    localRole: role,
    peerId: role === 'owner' ? 'student' : 'owner',
    signaling: { send: async (_peerId, signal) => { sent.push(signal); } },
    primaryPathTimeoutMs: 50,
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

test('late start preserves the existing fallback deadline and cannot revive a failed pair', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const failures = [];
  const { pair, created } = harness('student', { onFatal: error => failures.push(error) });
  t.after(() => pair.close());
  await pair.handleSignal({ type: 'path-switch', path: STUDENT_INITIATED_PATH });
  t.mock.timers.tick(150);
  await pair.start();
  t.mock.timers.tick(51);
  await flush();
  assert.equal(failures.length, 1, 'start must not extend the already running fallback deadline');
  await pair.start();
  assert.equal(created.length, 1, 'failed startup must not create another native connection');
});

test('first explicit start cannot revive a fallback that already timed out', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const failures = [];
  const { pair, created } = harness('student', { onFatal: error => failures.push(error) });
  t.after(() => pair.close());
  await pair.handleSignal({ type: 'path-switch', path: STUDENT_INITIATED_PATH });
  t.mock.timers.tick(201);
  await flush();
  assert.equal(failures.length, 1);
  await pair.start();
  t.mock.timers.tick(1000);
  assert.equal(created.length, 1);
  assert.equal(failures.length, 1);
});

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
  t.mock.timers.tick(50);
  await flush();
  assert.equal(created[0].closes, 1);
  assert.equal(created.length, 2);
  assert.equal(created[1].options.initiator, false);
  assert.ok(sent.some((signal) => signal.type === 'path-switch'
    && signal.path === STUDENT_INITIATED_PATH));
  pair.close();
});

test('student never switches by itself and changes role only after owner path-switch', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { pair, created, sent } = harness('student', { connectTimeoutMs: 10_000 });
  await pair.start();
  assert.equal(created.length, 1);
  assert.equal(created[0].options.initiator, false);

  t.mock.timers.tick(6000);
  await flush();
  assert.equal(created.length, 1, 'student coordination timer must not change native role');
  assert.ok(sent.some((signal) => signal.type === 'path-select-request'
    && signal.path === STUDENT_INITIATED_PATH));

  await pair.handleSignal({ type: 'path-switch', path: STUDENT_INITIATED_PATH });
  assert.equal(created.length, 2);
  assert.equal(created[0].closes, 1);
  assert.equal(created[1].options.initiator, true);
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


test('student timer skew cannot kill a primary path before owner switches it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { pair, created, selected } = harness('student', { primaryPathTimeoutMs: 50 });
  await pair.start();
  t.mock.timers.tick(55);
  await flush();
  assert.equal(created.length, 1);
  assert.equal(created[0].closes, 0);

  created[0].options.onChannel({ label: 'alex-board-durable-v1', close() {} });
  assert.deepEqual(selected, [OWNER_INITIATED_PATH]);
  pair.close();
});
