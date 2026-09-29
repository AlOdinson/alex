import assert from 'node:assert/strict';
import test from 'node:test';
import { createStudentPeerNetwork } from '../src/lib/studentPeerNetwork.js';

const OWNER = 'owner-initiated';
const FALLBACK = 'student-initiated';

async function openOwnerPath(network, teacherId, connectionOptions, { live = false } = {}) {
  await network.handleSignal({
    sourceId: teacherId,
    signal: {
      type: 'offer',
      path: OWNER,
      negotiationId: 'owner-test',
      description: { type: 'offer', sdp: 'owner-test' },
    },
  });
  if (live) connectionOptions().onLiveChannel({ label: 'alex-board-live-v1' });
  connectionOptions().onChannel({ label: 'alex-board-durable-v1' });
  await network.handleSignal({
    sourceId: teacherId,
    signal: { type: 'path-select', path: OWNER },
  });
}

async function startFallback(network, teacherId) {
  await network.handleSignal({
    sourceId: teacherId,
    signal: { type: 'path-switch', path: FALLBACK },
  });
}

test('waits for owner path, then starts student fallback only after path-switch', async () => {
  const sentSignals = [];
  let options = null;
  let started = 0;
  const network = createStudentPeerNetwork({
    teacherId: 'teacher-a',
    signaling: { send: async (peerId, signal) => sentSignals.push({ peerId, signal }) },
    getRevision: () => 0, applyCommit: async () => {}, installSnapshot: async () => {},
    createConnection: (input) => {
      options = input;
      return { async start() { started += 1; }, async handleSignal() {}, close() {} };
    },
    createTransport: () => ({ send: async () => {}, close() {} }),
    createSession: () => ({ async start() {}, close() {} }),
  });

  const starting = network.start();
  await Promise.resolve();
  assert.equal(started, 1);
  assert.equal(options.initiator, false);
  await startFallback(network, 'teacher-a');
  assert.equal(started, 2);
  assert.equal(options.initiator, true);

  await options.sendSignal({ type: 'offer' });
  assert.deepEqual(sentSignals.at(-1), {
    peerId: 'teacher-a',
    signal: { type: 'offer', path: FALLBACK, recoveryVersion: 1, liveVersion: 1, pathSequence: 1 },
  });

  options.onChannel({ label: 'alex-board-durable-v1' });
  await network.handleSignal({
    sourceId: 'teacher-a',
    signal: { type: 'path-select', path: FALLBACK },
  });
  await starting;
  assert.equal(network.isReady(), true);
  network.close();
});

test('owner path opens student sync and routes messages/transfers', async () => {
  let connectionOptions = null;
  let transportOptions = null;
  const sessionEvents = [];
  const network = createStudentPeerNetwork({
    teacherId: 'teacher-a',
    signaling: { send: async () => {} },
    getRevision: () => 5, applyCommit: async () => {}, installSnapshot: async () => {},
    createConnection: (options) => {
      connectionOptions = options;
      return { async start() {}, async handleSignal() {}, close() {} };
    },
    createTransport: (options) => {
      transportOptions = options;
      return { send: async () => {}, close() {} };
    },
    createSession: () => ({
      async start() {},
      async handleMessage(message) { sessionEvents.push(['message', message]); },
      async handleTransfer(transfer) { sessionEvents.push(['transfer', transfer]); },
      async proposeAction(action) { sessionEvents.push(['proposal', action]); return 'sent'; },
      async proposeActionAndWait(action) { return { accepted: true, revision: 6, action }; },
      whenIdle: async () => {},
      close() {},
    }),
  });

  const starting = network.start();
  await openOwnerPath(network, 'teacher-a', () => connectionOptions);
  await starting;
  assert.equal(network.isReady(), true);

  await transportOptions.onMessage({ type: 'head', payload: { revision: 5 } });
  await transportOptions.onTransfer({ kind: 'snapshot', text: '{}' });
  assert.deepEqual(sessionEvents.slice(0, 2), [
    ['message', { type: 'head', payload: { revision: 5 } }],
    ['transfer', { kind: 'snapshot', text: '{}' }],
  ]);
  assert.equal(await network.proposeAction({ actionId: 'a', ops: [] }), 'sent');
  network.close();
});

test('accepts signaling only from configured teacher', async () => {
  const handled = [];
  const network = createStudentPeerNetwork({
    teacherId: 'teacher-a', signaling: { send: async () => {} },
    getRevision: () => 0, applyCommit: async () => {}, installSnapshot: async () => {},
    createConnection: () => ({
      async start() {}, async handleSignal(signal) { handled.push(signal); }, close() {},
    }),
    createTransport: () => ({ send: async () => {}, close() {} }),
  });

  const offer = { type: 'offer', path: OWNER, negotiationId: 'one',
    description: { type: 'offer', sdp: 'x' } };
  await network.handleSignal({ sourceId: 'teacher-b', signal: offer });
  assert.equal(handled.length, 0);
  await network.handleSignal({ sourceId: 'teacher-a', signal: offer });
  assert.equal(handled.length, 1);
  network.close();
});

test('closing student network closes selected peer session and transport', async () => {
  let connectionOptions = null;
  let sessionCloseCount = 0;
  let transportCloseCount = 0;
  let connectionCloseCount = 0;
  const network = createStudentPeerNetwork({
    teacherId: 'teacher-a', signaling: { send: async () => {} },
    getRevision: () => 0, applyCommit: async () => {}, installSnapshot: async () => {},
    createConnection: (options) => {
      connectionOptions = options;
      return { async start() {}, async handleSignal() {}, close() { connectionCloseCount += 1; } };
    },
    createTransport: () => ({ send: async () => {}, close() { transportCloseCount += 1; } }),
    createSession: () => ({ async start() {}, close() { sessionCloseCount += 1; } }),
  });

  const starting = network.start();
  await openOwnerPath(network, 'teacher-a', () => connectionOptions);
  await starting;
  network.close();
  assert.equal(sessionCloseCount, 1);
  assert.equal(transportCloseCount, 1);
  assert.equal(connectionCloseCount, 1);
});

test('live transport attaches only after its owner path is selected', async () => {
  let connectionOptions = null;
  let liveOptions = null;
  const sentLive = [];
  const network = createStudentPeerNetwork({
    boardId: 'board-live', clientId: 'student-a', teacherId: 'teacher-a',
    signaling: { send: async () => {} },
    getRevision: () => 3, applyCommit: async () => {}, installSnapshot: async () => {},
    createConnection: (options) => {
      connectionOptions = options;
      return { async start() {}, async handleSignal() {}, close() {} };
    },
    createTransport: () => ({ send: async () => {}, close() {} }),
    createSession: () => ({ async start() {}, whenIdle: async () => {}, close() {} }),
    createLiveTransport: (options) => {
      liveOptions = options;
      return {
        send(type, payload, sendOptions) { sentLive.push({ type, payload, sendOptions }); return 'sent'; },
        stats: () => ({ sent: 1 }),
        close() {},
      };
    },
  });

  const starting = network.start();
  await network.handleSignal({
    sourceId: 'teacher-a',
    signal: { type: 'offer', path: OWNER, negotiationId: 'live-owner',
      description: { type: 'offer', sdp: 'x' } },
  });
  connectionOptions.onLiveChannel({ label: 'alex-board-live-v1' });
  connectionOptions.onChannel({ label: 'alex-board-durable-v1' });
  await starting;
  assert.equal(network.sendLive('cursor', { x: 2 }, { streamKey: 'cursor' }), 'sent');
  assert.ok(liveOptions);
  assert.equal(sentLive.length, 1);
  network.close();
});

test('legacy mode disables live DataChannel on selected owner path', async () => {
  let connectionOptions = null;
  const network = createStudentPeerNetwork({
    boardId: 'board-legacy', clientId: 'student-a', teacherId: 'teacher-legacy', liveEnabled: false,
    signaling: { send: async () => {} },
    getRevision: () => 0, applyCommit: async () => {}, installSnapshot: async () => {},
    createConnection: (options) => {
      connectionOptions = options;
      return { async start() {}, async handleSignal() {}, close() {} };
    },
    createTransport: () => ({ send: async () => {}, close() {} }),
    createSession: () => ({ async start() {}, close() {} }),
  });
  const starting = network.start();
  await network.handleSignal({
    sourceId: 'teacher-legacy',
    signal: { type: 'offer', path: OWNER, negotiationId: 'legacy',
      description: { type: 'offer', sdp: 'x' } },
  });
  assert.equal(connectionOptions.enableLiveChannel, false);
  connectionOptions.onChannel({ label: 'alex-board-durable-v1' });
  await network.handleSignal({ sourceId: 'teacher-legacy', signal: { type: 'path-select', path: OWNER } });
  await starting;
  network.close();
});

test('board-control uses selected durable session', async () => {
  let connectionOptions = null;
  const controls = [];
  const network = createStudentPeerNetwork({
    boardId: 'board-control', clientId: 'student-control', teacherId: 'teacher-control',
    signaling: { send: async () => {} },
    getRevision: () => 0, applyCommit: async () => {}, installSnapshot: async () => {},
    createConnection: (options) => {
      connectionOptions = options;
      return { async start() {}, async handleSignal() {}, close() {} };
    },
    createTransport: () => ({ send: async () => {}, close() {} }),
    createSession: () => ({
      async start() {},
      async sendBoardControl(event, payload) { controls.push({ event, payload }); return true; },
      close() {},
    }),
  });
  const starting = network.start();
  await openOwnerPath(network, 'teacher-control', () => connectionOptions);
  await starting;
  assert.equal(await network.sendBoardControl('mode', { mode: 'edit' }), true);
  assert.deepEqual(controls, [{ event: 'mode', payload: { mode: 'edit' } }]);
  network.close();
});

test('durable selected channel failure retires network and live transport', async () => {
  let connectionOptions = null;
  let durableOptions = null;
  let liveClosed = 0;
  let connectionClosed = 0;
  const states = [];
  const network = createStudentPeerNetwork({
    boardId: 'board-failure', clientId: 'student-a', teacherId: 'teacher-a',
    signaling: { send: async () => {} },
    getRevision: () => 4, applyCommit: async () => {}, installSnapshot: async () => {},
    onState: (state) => states.push(state),
    createConnection: (options) => {
      connectionOptions = options;
      return { async start() {}, async handleSignal() {}, close() { connectionClosed += 1; } };
    },
    createTransport: (options) => {
      durableOptions = options;
      return { send: async () => {}, close() {} };
    },
    createSession: () => ({ async start() {}, whenIdle: async () => {}, close() {} }),
    createLiveTransport: () => ({
      send: () => 'sent', stats: () => ({}), close() { liveClosed += 1; },
    }),
  });

  const starting = network.start();
  await network.handleSignal({
    sourceId: 'teacher-a',
    signal: { type: 'offer', path: OWNER, negotiationId: 'failure',
      description: { type: 'offer', sdp: 'x' } },
  });
  connectionOptions.onLiveChannel({ label: 'alex-board-live-v1' });
  connectionOptions.onChannel({ label: 'alex-board-durable-v1' });
  await network.handleSignal({ sourceId: 'teacher-a', signal: { type: 'path-select', path: OWNER } });
  await starting;

  durableOptions.onClose();
  await Promise.resolve();
  assert.equal(network.isReady(), false);
  assert.equal(liveClosed, 1);
  assert.equal(connectionClosed, 1);
  assert.equal(states.at(-1), 'failed');
});

test('wake probes a ready channel and repairs only an unresponsive route', async t => {
  let options;let healthy=true;let recoveries=0;let probes=0;
  const network=createStudentPeerNetwork({teacherId:'owner',getRevision:()=>1,applyCommit:async()=>{},installSnapshot:async()=>{},signaling:{send:async()=>{}},
    createPair:o=>{options=o;return {start:async()=>{},close(){},canProbe:()=>true,recover:()=>{recoveries++;}};},
    createTransport:()=>({send:async()=>{},close(){},probe:async()=>{probes++;return healthy;}}),
    createSession:()=>({start:async()=>{},close(){}})});
  t.after(()=>network.close());const start=network.start();options.onSelectedChannel({readyState:'open'},'owner-initiated');await start;
  await network.recoverConnections();assert.equal(probes,1);assert.equal(recoveries,0);
  healthy=false;await network.recoverConnections();assert.equal(recoveries,1);
});
