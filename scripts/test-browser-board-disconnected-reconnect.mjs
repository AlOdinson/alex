import assert from 'node:assert/strict';
import test from 'node:test';
import { createStudentPeerNetwork } from '../src/lib/studentPeerNetwork.js';

test('student treats disconnected as terminal failure because teacher already retires that peer', async () => {
  let connectionOptions = null;
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
        close() {},
      };
    },
    createTransport: () => ({ send: async () => {}, close() {} }),
  });

  await network.start();
  assert.ok(connectionOptions, 'student peer connection was not created');

  connectionOptions.onConnectionState('disconnected');
  assert.deepEqual(
    states,
    ['failed'],
    'student must enter the existing terminal recovery path immediately when teacher has already dropped disconnected peers',
  );

  network.close();
});
