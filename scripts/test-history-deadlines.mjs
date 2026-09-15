import assert from 'node:assert/strict';
import test from 'node:test';
import { createStudentPeerNetwork } from '../src/lib/studentPeerNetwork.js';
import { createPeerDataChannelTransport } from '../src/lib/peerDataChannel.js';
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

for (const operation of ['proposeActionAndWait', 'requestLock']) {
  test(`missing ${operation} acknowledgement releases the command and reconnects`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let connectionOptions;
    let closes = 0;
    const states = [];
    const network = createStudentPeerNetwork({
      teacherId: 'teacher', signaling: { send: async () => {} }, getRevision: () => 1,
      applyCommit: async () => {}, installSnapshot: async () => {}, requestTimeoutMs: 100,
      onState: (state) => states.push(state),
      createConnection: (options) => {
        connectionOptions = options;
        return { start: async () => {}, close: () => { closes++; } };
      },
      createTransport: () => ({ send: async () => {}, close() {} }),
      createSession: () => ({ start: async () => {}, close() {},
        proposeActionAndWait: () => new Promise(() => {}), requestLock: () => new Promise(() => {}),
      }),
    });
    t.after(() => network.close());
    const start = network.start();
    connectionOptions.onChannel({});
    await start;
    let error;
    network[operation]({ actionId: 'same-id-on-retry' }).catch((reason) => { error = reason; });
    await flush();
    t.mock.timers.tick(101);
    await flush();
    assert.match(error?.message ?? '', /timed out/i);
    assert.equal(closes, 1);
    assert.equal(network.isReady(), false);
    assert.equal(states.at(-1), 'failed');
  });
}

test('a silent congested channel rejects blocked sends without waiting for close', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const channel = Object.assign(new EventTarget(), { readyState: 'open', bufferedAmount: 900000, send() { assert.fail('must not send'); } });
  const transport = createPeerDataChannelTransport({ channel, writeTimeoutMs: 100 });
  t.after(() => transport.close());
  let error;
  transport.send('commit', { revision: 3 }).catch((reason) => { error = reason; });
  await flush();
  t.mock.timers.tick(101);
  await flush();
  assert.match(error?.message ?? '', /timed out/i);
});
