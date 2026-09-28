import assert from 'node:assert/strict';
import test from 'node:test';
import { createStudentPeerNetwork } from '../src/lib/studentPeerNetwork.js';

test('student gives disconnected peer 3.5 seconds to recover', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let connectionOptions = null;
  let closedCount = 0;
  const states = [];
  const network = createStudentPeerNetwork({
    teacherId: 'teacher-a',
    signaling: { send: async () => {} },
    getRevision: () => 5,
    applyCommit: async () => {},
    installSnapshot: async () => {},
    onState: (state) => states.push(state),
    createConnection: (options) => {
      connectionOptions = options;
      return {
        async start() {},
        async handleSignal() {},
        close() { closedCount += 1; },
      };
    },
    createTransport: () => ({ send: async () => {}, close() {} }),
    createSession: () => ({ async start() {}, close() {} }),
  });

  const starting = network.start();
  await Promise.resolve();
  connectionOptions.onChannel({ label: 'alex-board-durable-v1' });
  await starting;
  connectionOptions.onConnectionState('disconnected');
  assert.deepEqual(states, ['disconnected']);
  t.mock.timers.tick(3499);
  assert.equal(network.isReady(), true);
  assert.equal(closedCount, 0);

  connectionOptions.onConnectionState('connected');
  t.mock.timers.tick(10000);
  assert.equal(network.isReady(), true);
  assert.equal(closedCount, 0);
  network.close();
});
