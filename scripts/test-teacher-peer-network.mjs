import assert from 'node:assert/strict';
import test from 'node:test';
import { createTeacherPeerNetwork } from '../src/lib/teacherPeerNetwork.js';
import { OWNER_INITIATED_PATH, STUDENT_INITIATED_PATH } from '../src/lib/dualPathPeerPair.js';

const flush = async () => { for (let i = 0; i < 20; i += 1) await Promise.resolve(); };

test('fresh student offer replaces an apparently open old session and ignores its late replay', async () => {
  const { network, created, added } = makeNetwork();
  const offer = id => ({ sourceId: 'student-a', signal: {
    type: 'offer', path: STUDENT_INITIATED_PATH, negotiationId: id,
    description: { type: 'offer', sdp: id },
  } });
  try {
    await network.handleSignal(offer('previous-session'));
    created.at(-1).options.onChannel({ label: 'alex-board-durable-v1', close() {} });
    assert.equal(added.length, 1);
    const old = created.at(-1);
    await network.handleSignal(offer('reconnected-session'));
    assert.equal(old.closed, 1, 'the teacher must release a stale open transport on a fresh student negotiation');
    const fresh = created.at(-1);
    fresh.options.onChannel({ label: 'alex-board-durable-v1', close() {} });
    assert.equal(added.length, 2, 'new student channel must reach the teacher hub');
    const count = created.length;
    await network.handleSignal(offer('previous-session'));
    assert.equal(created.length, count, 'delayed retired offer must not evict the replacement');
    assert.equal(fresh.closed, 0);
  } finally { network.close(); }
});

test('confirmed student abandonment escapes an owner-only open primary without another presence event', async () => {
  const { network, created, sent, added } = makeNetwork();
  try {
    network.updateParticipants(['student-a']);
    await flush();
    const primary = created[0];
    await primary.options.sendSignal({ type: 'offer', negotiationId: 'one-sided-primary', description: { type: 'offer', sdp: 'primary' } });
    primary.options.onChannel({ label: 'alex-board-durable-v1', close() {} });
    const request = { sourceId: 'student-a', signal: {
      type: 'path-select-request', path: STUDENT_INITIATED_PATH, negotiationId: 'one-sided-primary', abandoned: true,
    } };
    await network.handleSignal(request);
    assert.equal(primary.closed, 1, 'an owner-only open path must not trap the student on a dead generation');
    assert.ok(sent.some(({ signal }) => signal.type === 'path-switch'));
    const fallback = created.at(-1);
    assert.equal(fallback.options.initiator, false);
    fallback.options.onChannel({ label: 'alex-board-durable-v1', close() {} });
    assert.equal(added.length, 2);
    const count = created.length;
    await network.handleSignal(request);
    await network.handleSignal({ sourceId: 'student-a', signal: { type: 'ice', path: OWNER_INITIATED_PATH, negotiationId: 'one-sided-primary', candidate: {} } });
    primary.options.onConnectionState('failed');
    assert.equal(created.length, count);
    assert.equal(fallback.closed, 0);
    assert.equal(network.getSelectedPath('student-a'), STUDENT_INITIATED_PATH);
  } finally { network.close(); }
});

test('ordinary delayed watchdog request must not tear down a now healthy primary', async () => {
  const { network, created } = makeNetwork();
  try {
    network.updateParticipants(['student-a']);
    await flush();
    const primary = created[0];
    await primary.options.sendSignal({ type: 'offer', negotiationId: 'healthy', description: { type: 'offer', sdp: 'primary' } });
    primary.options.onChannel({ label: 'alex-board-durable-v1', close() {} });
    await network.handleSignal({ sourceId: 'student-a', signal: {
      type: 'path-select-request', path: STUDENT_INITIATED_PATH, negotiationId: 'healthy',
    } });
    assert.equal(primary.closed, 0);
    assert.equal(created.length, 1);
  } finally { network.close(); }
});

function makeNetwork(overrides = {}) {
  const created = [];
  const sent = [];
  const removed = [];
  const added = [];
  let transportOptions = null;
  const network = createTeacherPeerNetwork({
    clientId: 'teacher',
    signaling: { send: async (peerId, signal) => sent.push({ peerId, signal }) },
    peerHub: {
      addPeer(peerId, transport) { added.push({ peerId, transport }); return () => {}; },
      removePeer(peerId) { removed.push(peerId); },
      async handleMessage() {},
    },
    createConnection: (options) => {
      const record = { options, handled: [], closed: 0, starts: 0, replayed: 0 };
      record.connection = {
        async start() { record.starts += 1; },
        async handleSignal(signal) { record.handled.push(signal); },
        resendSignaling() { record.replayed += 1; },
        close() { record.closed += 1; },
      };
      created.push(record);
      return record.connection;
    },
    createTransport: (options) => {
      transportOptions = options;
      return { send: async () => {}, sendTextTransfer: async () => {}, close() {} };
    },
    ...overrides,
  });
  return { network, created, sent, removed, added, getTransportOptions: () => transportOptions };
}

test('teacher starts only owner-initiated primary path for a present student', async () => {
  const { network, created } = makeNetwork();
  network.updateParticipants(['student-a']);
  await flush();
  assert.equal(created.length, 1);
  assert.equal(created[0].options.initiator, true);
  assert.equal(network.getPeerCount(), 1);
  network.close();
});

test('teacher attaches primary owner path immediately when its durable channel opens', async () => {
  const { network, created, added, sent } = makeNetwork();
  network.updateParticipants(['student-a']);
  await flush();
  const owner = created[0];
  owner.options.onChannel({ label: 'alex-board-durable-v1', close() {} });
  assert.equal(added.length, 1);
  assert.equal(network.getSelectedPath('student-a'), OWNER_INITIATED_PATH);
  assert.ok(sent.some(({ signal }) => signal.type === 'path-select'
    && signal.path === OWNER_INITIATED_PATH));
  network.close();
});

test('student fallback offer retires primary owner path before creating responder', async () => {
  const { network, created } = makeNetwork();
  network.updateParticipants(['student-a']);
  await flush();
  const owner = created[0];

  await network.handleSignal({
    sourceId: 'student-a',
    signal: {
      type: 'offer',
      path: STUDENT_INITIATED_PATH,
      negotiationId: 'student-fallback-1',
      description: { type: 'offer', sdp: 'fallback' },
    },
  });

  assert.equal(created.length, 2);
  assert.equal(owner.closed, 1);
  assert.equal(created[1].options.initiator, false);
  assert.equal(network.getPeerCount(), 1);
  network.close();
});

test('teacher attaches student-initiated fallback when responder channel opens', async () => {
  const { network, created, added, sent } = makeNetwork();
  network.updateParticipants(['student-a']);
  await flush();

  await network.handleSignal({
    sourceId: 'student-a',
    signal: {
      type: 'offer',
      path: STUDENT_INITIATED_PATH,
      negotiationId: 'student-fallback-1',
      description: { type: 'offer', sdp: 'fallback' },
    },
  });
  const responder = created.at(-1);
  responder.options.onChannel({ label: 'alex-board-durable-v1', close() {} });

  assert.equal(added.length, 1);
  assert.equal(network.getSelectedPath('student-a'), STUDENT_INITIATED_PATH);
  assert.ok(sent.some(({ signal }) => signal.type === 'path-select'
    && signal.path === STUDENT_INITIATED_PATH));
  network.close();
});

test('new fallback negotiation replaces only stale fallback responder', async () => {
  const { network, created } = makeNetwork();
  network.updateParticipants(['student-a']);
  await flush();

  await network.handleSignal({
    sourceId: 'student-a',
    signal: { type: 'offer', path: STUDENT_INITIATED_PATH, negotiationId: 'one',
      description: { type: 'offer', sdp: 'one' } },
  });
  await network.handleSignal({
    sourceId: 'student-a',
    signal: { type: 'offer', path: STUDENT_INITIATED_PATH, negotiationId: 'two',
      description: { type: 'offer', sdp: 'two' } },
  });

  assert.equal(created.length, 3);
  assert.equal(created[0].closed, 1, 'primary was retired when fallback began');
  assert.equal(created[1].closed, 1, 'old fallback generation was retired');
  assert.equal(created[2].closed, 0);
  assert.equal(created[2].options.initiator, false);
  network.close();
});

test('selected durable path failure removes teacher peer', async () => {
  const { network, created, removed } = makeNetwork();
  network.updateParticipants(['student-a']);
  await flush();
  const owner = created[0];
  owner.options.onChannel({ label: 'alex-board-durable-v1', close() {} });
  owner.options.onConnectionState('failed');
  await flush();

  assert.equal(network.getPeerCount(), 0);
  assert.deepEqual(removed, ['student-a']);
  network.close();
});

test('unknown stale pair offer cannot evict a selected teacher transport', async t => {
  const {network,created,removed}=makeNetwork();t.after(()=>network.close());network.updateParticipants(['student-a']);await flush();
  const current=created[0];await current.options.sendSignal({type:'offer',negotiationId:'current-native',description:{type:'offer',sdp:'current'}});
  current.options.onChannel({readyState:'open',close(){}});
  assert.equal(await network.handleSignal({sourceId:'student-a',signal:{type:'offer',path:STUDENT_INITIATED_PATH,attemptId:'unseen-old-pair',negotiationId:'unseen-old-native',description:{type:'offer',sdp:'old'}}}),false);
  assert.equal(current.closed,0);assert.equal(created.length,1);assert.deepEqual(removed,[]);
});

test('successful wake probe clears pending recovery watchdog even without a connected event', async t => {
  t.mock.timers.enable({apis:['setTimeout']});let healthy=false;
  const {network,created,removed}=makeNetwork({createTransport:()=>({send:async()=>{},close(){},probe:async()=>healthy})});t.after(()=>network.close());
  network.updateParticipants(['student-a']);await flush();const current=created[0];
  current.connection.restartIce=async()=>true;
  await network.handleSignal({sourceId:'student-a',signal:{type:'answer',recoveryVersion:1,liveVersion:0,description:{type:'answer',sdp:'answer'}}});
  current.options.onChannel({readyState:'open',close(){}});
  await network.recoverConnections();await flush();healthy=true;await network.recoverConnections();
  assert.equal((await network.getConnectionDiagnostics())[0].recovering,false);
  t.mock.timers.tick(9000);await flush();assert.deepEqual(removed,[]);assert.equal(current.closed,0);
});
