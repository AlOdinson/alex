import assert from 'node:assert/strict';
import test from 'node:test';
import { createStudentPeerSession } from '../src/lib/studentPeerSession.js';
import { createTeacherPeerHub } from '../src/lib/teacherPeerHub.js';
import { createStudentPeerNetwork } from '../src/lib/studentPeerNetwork.js';
import { createTeacherPeerNetwork } from '../src/lib/teacherPeerNetwork.js';
import { createPeerDataChannelTransport } from '../src/lib/peerDataChannel.js';
import { createBrowserBoardSession } from '../src/lib/browserBoardSession.js';

const turn = () => new Promise((resolve) => setImmediate(resolve));

class Channel extends EventTarget {
  readyState = 'open';
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  sent = [];
  send(frame) {
    if (Buffer.byteLength(frame, 'utf8') > 65_536) throw new TypeError('SCTP message exceeds negotiated 64 KiB limit');
    this.sent.push(frame);
  }
  receive(frame) { this.dispatchEvent(new MessageEvent('message', { data: frame })); }
}

for (const head of [0, 200]) {
  test(`fresh device receives the full filled snapshot at revision ${head} without replaying history`, async () => {
    const snapshot = { version: 2, background: 'dots', canvas: { objects: [
      { boardObjectId: 'existing-text', type: 'text', text: 'Уже написано на доске' },
      { boardObjectId: 'existing-path', type: 'path', path: [['M', 5, 8], ['L', 20, 30]] },
    ] } };
    let installed = null;
    let revision = 0;
    let journalReads = 0;
    let commitsApplied = 0;
    let student;
    const hub = createTeacherPeerHub({
      authority: { getRevision: () => head, commitAction: async () => {} },
      getSnapshot: async () => ({ snapshot, revision: head }),
      getCommitsAfter: async () => {
        journalReads += 1;
        return Array.from({ length: head }, (_, i) => ({ revision: i + 1, ops: [] }));
      },
    });
    hub.addPeer('new-device', {
      send: (type, payload) => student.handleMessage({ type, payload }),
      sendTextTransfer: (kind, text) => student.handleTransfer({ kind, text }),
    });
    student = createStudentPeerSession({
      transport: { send: (type, payload) => hub.handleMessage('new-device', { type, payload }) },
      getRevision: () => revision,
      applyCommit: async (commit) => { commitsApplied += 1; revision = commit.revision; },
      installSnapshot: async (value, nextRevision) => { installed = value; revision = nextRevision; },
    });
    await student.start();
    assert.deepEqual(installed, snapshot, 'a new device must not mistake revision zero for an already populated replica');
    assert.equal(revision, head);
    assert.equal(journalReads, 0, 'initial join must not read the complete edit journal');
    assert.equal(commitsApplied, 0, 'initial join should paint one current snapshot, not replay 200 historical edits');
  });
}

test('failed snapshot installation rejects initial synchronization instead of hanging', async (t) => {
  const failure = new Error('Snapshot could not be installed');
  const student = createStudentPeerSession({
    transport: { send: async () => {} }, getRevision: () => 0,
    applyCommit: async () => {}, installSnapshot: async () => { throw failure; },
  });
  let startupError = null;
  student.start().catch((error) => { startupError = error; });
  t.after(() => student.close());
  await assert.rejects(student.handleTransfer({
    kind: 'snapshot', text: JSON.stringify({ snapshot: { canvas: { objects: [] } }, revision: 12 }),
  }), /could not be installed/);
  await turn();
  assert.equal(startupError, failure);
});

test('a closed old student cannot apply late snapshot messages', async () => {
  let installs = 0;
  const student = createStudentPeerSession({
    transport: { send: async () => {} }, getRevision: () => 0,
    applyCommit: async () => {}, installSnapshot: async () => { installs += 1; },
  });
  const starting = student.start().catch(() => {});
  student.close();
  await starting;
  await student.handleTransfer({ kind: 'snapshot', text: '{"snapshot":{"canvas":{"objects":[]}},"revision":8}' });
  assert.equal(installs, 0, 'a retired connection must not repaint the new connection');
});

test('ordinary Unicode commits fit the negotiated byte limit and round trip unchanged', async () => {
  const senderChannel = new Channel();
  const receiverChannel = new Channel();
  const received = [];
  const sender = createPeerDataChannelTransport({ channel: senderChannel });
  const receiver = createPeerDataChannelTransport({ channel: receiverChannel, onMessage: (message) => received.push(message) });
  const payload = { revision: 1, ops: [{ type: 'upsert', object: { boardObjectId: 'text', text: '数学🙂'.repeat(10_000) } }] };
  await sender.send('commit', payload);
  for (const frame of senderChannel.sent) {
    assert.ok(Buffer.byteLength(frame) <= 16_384, 'wire envelopes, escaping and UTF-8 must all fit the frame budget');
    receiverChannel.receive(frame);
  }
  assert.deepEqual(received, [{ v: 1, type: 'commit', payload }]);
  sender.close(); receiver.close();
});

test('large snapshot chunks are byte-bounded including JSON escaping and preserve all text', async () => {
  const channel = new Channel();
  const transfers = [];
  const receiver = new Channel();
  const receivedTransport = createPeerDataChannelTransport({ channel: receiver, onTransfer: (value) => transfers.push(value) });
  const transport = createPeerDataChannelTransport({ channel });
  const text = JSON.stringify({ text: ('Математика 数学 🙂 " \\ \n').repeat(10_000) });
  await transport.sendTextTransfer('snapshot', text, { transferId: 'large' });
  for (const frame of channel.sent) {
    assert.ok(Buffer.byteLength(frame) <= 16_384, `frame contains ${Buffer.byteLength(frame)} bytes`);
    receiver.receive(frame);
  }
  assert.equal(transfers[0]?.text, text);
  receivedTransport.close(); transport.close();
});

test('closing a transport cancels backpressure waits and never sends after close', async () => {
  const channel = new Channel();
  channel.bufferedAmount = 900_000;
  const transport = createPeerDataChannelTransport({ channel });
  let settled = false;
  let failure = null;
  const pending = transport.send('head', { revision: 4 }).then(
    () => { settled = true; }, (error) => { settled = true; failure = error; },
  );
  await turn();
  transport.close();
  await turn();
  const cancelledBeforeDrain = settled;
  channel.bufferedAmount = 0;
  channel.dispatchEvent(new Event('bufferedamountlow'));
  await pending;
  assert.ok(cancelledBeforeDrain, 'close must reject the blocked sender without waiting for a buffer event');
  assert.match(failure?.message ?? '', /closed/);
  assert.equal(channel.sent.length, 0);
});

test('silent WebRTC startup has a deadline even when signaling never settles', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let failure = null;
  let closes = 0;
  const states = [];
  const network = createStudentPeerNetwork({
    teacherId: 'teacher', signaling: { send: async () => {} },
    getRevision: () => 0, applyCommit: async () => {}, installSnapshot: async () => {},
    connectTimeoutMs: 100,
    onState: (state) => states.push(state),
    createConnection: () => ({ start: () => new Promise(() => {}), close: () => { closes += 1; } }),
  });
  network.start().catch((error) => { failure = error; });
  t.after(() => network.close());
  t.mock.timers.tick(101);
  await turn();
  assert.match(failure?.message ?? '', /timed out/i);
  assert.equal(network.isReady(), false);
  assert.equal(closes, 1);
  assert.equal(states.at(-1), 'failed');
});

test('stalled initial snapshot transfer closes and rejects the peer', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let options;
  let failure = null;
  const network = createStudentPeerNetwork({
    teacherId: 'teacher', signaling: { send: async () => {} },
    getRevision: () => 0, applyCommit: async () => {}, installSnapshot: async () => {},
    connectTimeoutMs: 100, initialSyncTimeoutMs: 200,
    createConnection: (input) => { options = input; return { async start() {}, close() {} }; },
    createTransport: () => ({ send: async () => {}, close() {} }),
    createSession: () => ({ start: () => new Promise(() => {}), close() {} }),
  });
  network.start().catch((error) => { failure = error; });
  t.after(() => network.close());
  options.onChannel(new Channel());
  t.mock.timers.tick(201);
  await turn();
  assert.match(failure?.message ?? '', /timed out/i);
  assert.equal(network.isReady(), false);
});

test('healthy slow snapshot progress extends the idle deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let connectionOptions;
  let transportOptions;
  let finish;
  let failure = null;
  const network = createStudentPeerNetwork({
    teacherId: 'teacher', signaling: { send: async () => {} },
    getRevision: () => 0, applyCommit: async () => {}, installSnapshot: async () => {},
    connectTimeoutMs: 100, initialSyncTimeoutMs: 200,
    createConnection: (input) => { connectionOptions = input; return { async start() {}, close() {} }; },
    createTransport: (input) => { transportOptions = input; return { send: async () => {}, close() {} }; },
    createSession: () => ({ start: () => new Promise((resolve) => { finish = resolve; }), close() {} }),
  });
  const starting = network.start().catch((error) => { failure = error; });
  t.after(() => network.close());
  connectionOptions.onChannel(new Channel());
  for (let i = 0; i < 4; i += 1) {
    t.mock.timers.tick(150);
    transportOptions.onProgress?.();
    await turn();
    assert.equal(failure, null, 'an actively arriving large snapshot must not be timed out');
  }
  finish();
  await starting;
  assert.equal(network.isReady(), true);
});

test('new offer replaces a silent old teacher peer; late old channel cannot hijack the replacement', async () => {
  const peers = [];
  const added = [];
  const network = createTeacherPeerNetwork({
    signaling: { send: async () => {} },
    peerHub: { addPeer: (id, transport) => { added.push(transport); return () => {}; }, removePeer() {}, async handleMessage() {} },
    createConnection: (options) => {
      const record = { options, closes: 0 };
      peers.push(record);
      return { async start() {}, async handleSignal() {}, close() { record.closes += 1; } };
    },
    createTransport: ({ channel }) => ({ channel, send: async () => {}, sendTextTransfer: async () => {}, close() {} }),
  });
  await network.handleSignal({ sourceId: 'student', signal: { type: 'offer', description: { sdp: 'old' } } });
  await network.handleSignal({ sourceId: 'student', signal: { type: 'offer', description: { sdp: 'new' } } });
  assert.equal(peers.length, 2);
  assert.equal(peers[0].closes, 1);
  peers[0].options.onChannel(new Channel());
  assert.equal(added.length, 0, 'late old datachannel must not be registered as the new connection');
  peers[1].options.onChannel(new Channel());
  assert.equal(added.length, 1);
  network.close();
});

test('teacher closes a failed snapshot sender instead of leaving the joining student waiting', async () => {
  let options;
  let transportOptions;
  const network = createTeacherPeerNetwork({
    signaling: { send: async () => {} },
    peerHub: { addPeer: () => () => {}, removePeer() {}, async handleMessage() { throw new Error('snapshot send failed'); } },
    createConnection: (input) => { options = input; return { async start() {}, async handleSignal() {}, close() {} }; },
    createTransport: (input) => { transportOptions = input; return { send: async () => {}, sendTextTransfer: async () => {}, close() {} }; },
  });
  await network.handleSignal({ sourceId: 'student', signal: { type: 'offer' } });
  options.onChannel(new Channel());
  await transportOptions.onMessage({ type: 'snapshot-request', payload: {} });
  assert.equal(network.getPeerCount(), 0);
});

test('a new device reports that the owner is offline instead of an endless connecting label', async () => {
  const session = createBrowserBoardSession({
    boardId: 'filled-board', clientId: 'new-device', permission: 'edit',
    sendScreenShareSignal: async () => {},
  });
  await session.start();
  await session.updateParticipants([{ clientId: 'new-device', permission: 'edit' }]);
  assert.equal(session.getRuntimeState(), 'teacher-offline');
  session.close();
});

test('retry after a failed canvas install requests a full snapshot, not an already-cached head', async () => {
  let replica = { revision: 0 };
  let attempts = 0;
  const snapshot = { canvas: { objects: [{ boardObjectId: 'restored' }] } };
  const session = createBrowserBoardSession({
    boardId: 'failed-install', clientId: 'student', permission: 'edit', sendScreenShareSignal: async () => {},
    getReplica: () => replica,
    installReplicaSnapshot: (_id, value, revision) => { replica = { snapshot: value, revision }; },
    onAuthoritativeSnapshot: async () => { if (attempts === 1) throw new Error('canvas install failed'); },
    registerRuntime: () => () => {},
    createStudentRuntime: (options) => ({
      async start() {
        attempts += 1;
        assert.equal(options.getRevision(), 0, 'unpainted replica must request a full baseline on retry');
        await options.installSnapshot(snapshot, 9);
      },
      proposeActionAndWait: async () => {}, close() {},
    }),
  });
  await session.start();
  const users = [{ clientId: 'teacher', permission: 'owner' }];
  await assert.rejects(session.updateParticipants(users), /canvas install failed/);
  assert.equal(replica.revision, 9, 'test reproduces the replica advancing before the canvas rejects');
  await session.updateParticipants(users);
  assert.equal(session.getRuntimeState(), 'ready');
  assert.equal(session.getRevision(), 9);
  session.close();
});

test('teacher teardown retires every connected device and its pending transfer', async () => {
  let closedPeers = 0;
  const network = createTeacherPeerNetwork({
    signaling: { send: async () => {} },
    peerHub: { addPeer: () => () => {}, removePeer() {}, async handleMessage() {} },
    createConnection: () => ({ async start() {}, async handleSignal() {}, close() { closedPeers += 1; } }),
  });
  for (const sourceId of ['device-1', 'device-2', 'device-3']) {
    await network.handleSignal({ sourceId, signal: { type: 'offer', description: { sdp: sourceId } } });
  }
  network.close();
  assert.equal(network.getPeerCount(), 0, 'teardown must not leave later devices connected to a retired authority');
  assert.equal(closedPeers, 3);
});

for (const source of ['frame', 'handler']) {
  test(`student retires a broken ${source} immediately instead of waiting for the watchdog`, async (t) => {
    let connectionOptions;
    let transportOptions;
    let failure;
    let closes = 0;
    const error = new Error(`Broken ${source}`);
    const network = createStudentPeerNetwork({
      teacherId: 'teacher', signaling: { send: async () => {} },
      getRevision: () => 0, applyCommit: async () => {}, installSnapshot: async () => {},
      createConnection: (options) => {
        connectionOptions = options;
        return { async start() {}, close() { closes += 1; } };
      },
      createTransport: (options) => {
        transportOptions = options;
        return { send: async () => {}, close() {} };
      },
      createSession: () => ({
        start: () => new Promise(() => {}),
        handleTransfer() { throw error; },
        close() {},
      }),
    });
    t.after(() => network.close());
    network.start().catch((value) => { failure = value; });
    connectionOptions.onChannel(new Channel());
    if (source === 'frame') transportOptions.onError(error);
    else {
      try { await transportOptions.onTransfer({ kind: 'snapshot' }); }
      catch { /* old handler throws without rejecting startup */ }
    }
    await turn();
    assert.equal(failure, error);
    assert.equal(closes, 1);
    assert.equal(network.isReady(), false);
  });
}
