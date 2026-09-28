import assert from 'node:assert/strict';
import test from 'node:test';
import { createStudentPeerNetwork } from '../src/lib/studentPeerNetwork.js';

const flush = async () => { for (let i = 0; i < 30; i += 1) await Promise.resolve(); };

function fixture() {
  let options;
  let transportOptions;
  let rejectSignaling;
  let closed = 0;
  const signalingStart = new Promise((_, reject) => { rejectSignaling = reject; });
  const errors = [];
  const network = createStudentPeerNetwork({
    teacherId: 'teacher', signaling: { send: async () => {} },
    getRevision: () => 0, applyCommit: async () => {}, installSnapshot: async () => {},
    connectTimeoutMs: 100, initialSyncTimeoutMs: 100,
    onError: (error) => { errors.push(error); },
    createConnection: (nextOptions) => {
      options = nextOptions;
      return { start: () => signalingStart, close: () => { closed += 1; } };
    },
    createTransport: (nextOptions) => {
      transportOptions = nextOptions;
      return { send: async () => {}, close() {} };
    },
    createSession: () => ({ start: async () => {}, close() {} }),
  });
  let state = 'pending';
  let failure;
  const starting = network.start().then(
    () => { state = 'fulfilled'; },
    (error) => { state = 'rejected'; failure = error; },
  );
  return {
    network, starting, errors, rejectSignaling,
    open: () => options.onChannel({ label: 'alex-board-durable-v1' }),
    progress: () => transportOptions.onProgress(),
    state: () => state, failure: () => failure, closed: () => closed,
  };
}

test('late join: an open channel with installed snapshot completes despite a lost signaling ack', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  t.after(() => f.network.close());
  f.open();
  await flush();
  assert.equal(f.state(), 'fulfilled');
  assert.equal(f.network.isReady(), true);
  f.progress();
  t.mock.timers.tick(1000);
  await flush();
  assert.equal(f.network.isReady(), true, 'completed startup must clear all watchdogs');
  assert.equal(f.closed(), 0);
});

test('late join: signaling failure before readiness closes and rejects the attempt', async (t) => {
  const f = fixture();
  t.after(() => f.network.close());
  const failure = new Error('Offer publish failed');
  f.rejectSignaling(failure);
  await f.starting;
  assert.equal(f.state(), 'rejected');
  assert.equal(f.failure(), failure);
  assert.equal(f.closed(), 1);
});

test('late join: late signaling rejection cannot tear down an already synchronized channel', async (t) => {
  const f = fixture();
  t.after(() => f.network.close());
  f.open();
  await flush();
  const failure = new Error('Signaling receipt timed out after delivery');
  f.rejectSignaling(failure);
  await f.starting;
  await flush();
  assert.equal(f.state(), 'fulfilled');
  assert.equal(f.network.isReady(), true);
  assert.equal(f.closed(), 0);
  assert.ok(f.errors.includes(failure), 'the late error remains observable');
});
