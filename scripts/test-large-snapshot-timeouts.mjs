import assert from 'node:assert/strict';
import test from 'node:test';
import { createPeerDataChannelTransport } from '../src/lib/peerDataChannel.js';
import { createStudentPeerNetwork } from '../src/lib/studentPeerNetwork.js';
import { createTeacherPeerHub } from '../src/lib/teacherPeerHub.js';

const flush = async () => { for (let i = 0; i < 30; i += 1) await Promise.resolve(); };

function congestedChannel() {
  return Object.assign(new EventTarget(), {
    readyState: 'open',
    bufferedAmount: 900_000,
    sent: [],
    send(value) { this.sent.push(value); },
  });
}

test('bulk snapshot transfer can use a longer inactivity deadline than ordinary writes', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const ordinaryChannel = congestedChannel();
  const ordinary = createPeerDataChannelTransport({ ordinaryChannel, channel: ordinaryChannel, writeTimeoutMs: 100 });
  t.after(() => ordinary.close());
  let ordinaryFailure = null;
  ordinary.send('head', { revision: 1 }).catch((error) => { ordinaryFailure = error; });
  await flush();
  t.mock.timers.tick(101);
  await flush();
  assert.match(ordinaryFailure?.message ?? '', /timed out/i, 'ordinary writes keep their short deadline');

  const bulkChannel = congestedChannel();
  const bulk = createPeerDataChannelTransport({ channel: bulkChannel, writeTimeoutMs: 100 });
  t.after(() => bulk.close());
  let bulkFailure = null;
  const sending = bulk.sendTextTransfer('snapshot', 'x'.repeat(80_000), {
    transferId: 'large-snapshot',
    writeTimeoutMs: 400,
  }).catch((error) => { bulkFailure = error; });
  await flush();
  t.mock.timers.tick(150);
  await flush();
  assert.equal(bulkFailure, null, 'a large snapshot must not inherit the ordinary 100ms inactivity deadline');
  bulkChannel.bufferedAmount = 0;
  bulkChannel.dispatchEvent(new Event('bufferedamountlow'));
  await sending;
  assert.equal(bulkFailure, null);
  assert.ok(bulkChannel.sent.length > 1);
});

test('teacher snapshot requests pass the dedicated bulk write deadline to the transport', async () => {
  const transfers = [];
  const transport = {
    async send() {},
    async sendTextTransfer(kind, text, options) { transfers.push({ kind, text, options }); },
  };
  const hub = createTeacherPeerHub({
    authority: { getRevision: () => 4, commitAction: async () => null },
    getSnapshot: async () => ({ snapshot: { objects: [{ src: 'data:image/png;base64,large' }] }, revision: 4 }),
    getCommitsAfter: async () => [],
    createTransferId: () => 'snapshot-transfer',
    snapshotWriteTimeoutMs: 120_000,
  });
  hub.addPeer('student', transport);
  await hub.handleMessage('student', { type: 'snapshot-request', payload: {} });
  assert.equal(transfers.length, 1);
  assert.equal(transfers[0].kind, 'snapshot');
  assert.equal(transfers[0].options.writeTimeoutMs, 120_000);
});

test('default initial snapshot inactivity deadline tolerates a slow WebKit bulk transfer but remains bounded', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let connectionOptions;
  let failure = null;
  const network = createStudentPeerNetwork({
    teacherId: 'teacher',
    signaling: { send: async () => {} },
    getRevision: () => 0,
    applyCommit: async () => {},
    installSnapshot: async () => {},
    createConnection: (options) => {
      connectionOptions = options;
      return { start: async () => {}, close() {} };
    },
    createTransport: () => ({ send: async () => {}, close() {} }),
    createSession: () => ({ start: () => new Promise(() => {}), close() {} }),
  });
  t.after(() => network.close());
  network.start().catch((error) => { failure = error; });
  connectionOptions.onChannel({});
  await flush();
  t.mock.timers.tick(31_000);
  await flush();
  assert.equal(failure, null, '30 seconds of Safari snapshot silence must not kill an otherwise-open bulk channel');
  t.mock.timers.tick(60_001);
  await flush();
  assert.match(failure?.message ?? '', /snapshot timed out/i, 'the extended startup wait is still bounded');
});
