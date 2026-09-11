import assert from 'node:assert/strict';
import test from 'node:test';
import { createStudentPeerNetwork } from '../src/lib/studentPeerNetwork.js';

test('starts an initiator connection and targets teacher signaling', async () => {
  const sentSignals = [];
  let options;
  let started = 0;
  const network = createStudentPeerNetwork({
    teacherId: 'teacher-a',
    signaling: { send: async (peerId, signal) => sentSignals.push({ peerId, signal }) },
    getRevision: () => 0,
    applyCommit: async () => {},
    installSnapshot: async () => {},
    createConnection: (input) => {
      options = input;
      return {
        async start() { started += 1; },
        async handleSignal() {},
        close() {},
      };
    },
    createTransport: () => ({ send: async () => {}, close() {} }),
  });

  await network.start();
  assert.equal(started, 1);
  assert.equal(options.initiator, true);
  await options.sendSignal({ type: 'offer' });
  assert.deepEqual(sentSignals, [{ peerId: 'teacher-a', signal: { type: 'offer' } }]);
});

test('starts student sync when data channel opens and routes messages/transfers', async () => {
  let connectionOptions;
  let transportOptions;
  const sessionEvents = [];
  let sessionStartCount = 0;

  const network = createStudentPeerNetwork({
    teacherId: 'teacher-a',
    signaling: { send: async () => {} },
    getRevision: () => 5,
    applyCommit: async () => {},
    installSnapshot: async () => {},
    createConnection: (options) => {
      connectionOptions = options;
      return { async start() {}, async handleSignal() {}, close() {} };
    },
    createTransport: (options) => {
      transportOptions = options;
      return { send: async () => {}, close() {} };
    },
    createSession: () => ({
      async start() { sessionStartCount += 1; },
      async handleMessage(message) { sessionEvents.push(['message', message]); },
      async handleTransfer(transfer) { sessionEvents.push(['transfer', transfer]); },
      async proposeAction(action) { sessionEvents.push(['proposal', action]); return 'sent'; },
      async proposeActionAndWait(action) { sessionEvents.push(['proposal-wait', action]); return { accepted: true, revision: 6 }; },
      whenIdle: async () => {},
    }),
  });

  await network.start();
  connectionOptions.onChannel({ label: 'alex-board-durable-v1' });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(sessionStartCount, 1);

  await transportOptions.onMessage({ type: 'head', payload: { revision: 5 } });
  await transportOptions.onTransfer({ kind: 'snapshot', text: '{}' });
  assert.deepEqual(sessionEvents.slice(0, 2), [
    ['message', { type: 'head', payload: { revision: 5 } }],
    ['transfer', { kind: 'snapshot', text: '{}' }],
  ]);

  const result = await network.proposeAction({ actionId: 'student-action', ops: [] });
  assert.equal(result, 'sent');
  assert.deepEqual(sessionEvents.at(-1), ['proposal', { actionId: 'student-action', ops: [] }]);

  const ack = await network.proposeActionAndWait({ actionId: 'student-action-wait', ops: [] });
  assert.deepEqual(ack, { accepted: true, revision: 6 });
  assert.deepEqual(sessionEvents.at(-1), ['proposal-wait', { actionId: 'student-action-wait', ops: [] }]);
});

test('accepts only signaling from the configured teacher', async () => {
  const handled = [];
  const network = createStudentPeerNetwork({
    teacherId: 'teacher-a',
    signaling: { send: async () => {} },
    getRevision: () => 0,
    applyCommit: async () => {},
    installSnapshot: async () => {},
    createConnection: () => ({
      async start() {},
      async handleSignal(signal) { handled.push(signal); },
      close() {},
    }),
    createTransport: () => ({ send: async () => {}, close() {} }),
  });

  await network.handleSignal({ sourceId: 'teacher-b', signal: { type: 'answer' } });
  await network.handleSignal({ sourceId: 'teacher-a', signal: { type: 'answer' } });
  assert.deepEqual(handled, [{ type: 'answer' }]);
});
