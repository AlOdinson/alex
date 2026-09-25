import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserPeerConnection } from '../src/lib/browserPeerConnection.js';
import { createTeacherPeerNetwork } from '../src/lib/teacherPeerNetwork.js';
import { createStudentPeerNetwork } from '../src/lib/studentPeerNetwork.js';

const flush = async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); };
const desc = (type, id) => ({ type, sdp: `v=0\r\na=ice-ufrag:${id}\r\n` });
class NativeStub {
  constructor() {
    this.localDescription = null; this.remoteDescription = null;
    this.signalingState = 'stable'; this.created = []; this.added = []; this.remoteSets = 0;
  }
  createDataChannel(label) {
    const channel = { label, readyState: 'connecting', close() { this.readyState = 'closed'; } };
    this.created.push(channel); return channel;
  }
  async createOffer() { return desc('offer', 'local'); }
  async createAnswer() { return desc('answer', 'remote'); }
  async setLocalDescription(value) { this.localDescription = value; this.signalingState = value.type === 'offer' ? 'have-local-offer' : 'stable'; }
  async setRemoteDescription(value) { this.remoteSets++; this.remoteDescription = value; this.signalingState = value.type === 'answer' ? 'stable' : 'have-remote-offer'; }
  async addIceCandidate(candidate) { if (candidate.candidate === 'broken') throw new Error('bad current ICE'); this.added.push(candidate); }
  open() { const c = this.created[0]; c.readyState = 'open'; c.onopen?.(); }
  close() { this.signalingState = 'closed'; }
}
function fixture(t, options = {}) {
  const native = new NativeStub(), sent = [], errors = [];
  const connection = createBrowserPeerConnection({ initiator: true, assistSignaling: true,
    createPeerConnection: () => native, sendSignal: async (s) => { sent.push(s); },
    onError: (e) => errors.push(e), ...options });
  t.after(() => connection.close());
  return { native, sent, errors, connection };
}

test('unfinished setup resends the exact offer at 3s/8s, only twice, without a second channel', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { connection, native, sent } = fixture(t);
  await connection.start();
  assert.equal(sent.length, 1);
  t.mock.timers.tick(2999); await flush(); assert.equal(sent.length, 1);
  t.mock.timers.tick(1); await flush(); assert.equal(sent.filter(s => s.type === 'offer').length, 2);
  t.mock.timers.tick(5000); await flush(); assert.equal(sent.filter(s => s.type === 'offer').length, 3);
  t.mock.timers.tick(100000); await flush(); assert.equal(sent.length, 3);
  assert.deepEqual(sent[0], sent[1]); assert.deepEqual(sent[0], sent[2]);
  assert.equal(native.created.length, 1);
});

test('healthy channel cancels all bootstrap assistance and remains the same channel', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { connection, native, sent } = fixture(t);
  await connection.start(); native.open();
  t.mock.timers.tick(30000); await flush();
  assert.equal(sent.length, 1); assert.equal(native.created.length, 1);
});

test('closing before a retry cancels assistance permanently', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { connection, sent } = fixture(t);
  await connection.start(); connection.close();
  t.mock.timers.tick(30000); await flush(); assert.equal(sent.length, 1);
});

test('a lost publish receipt does not prevent the timed assistance attempt', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const { connection } = fixture(t, { sendSignal: () => { calls++; return new Promise(() => {}); } });
  void connection.start(); await flush(); assert.equal(calls, 1);
  t.mock.timers.tick(3000); await flush(); assert.equal(calls, 2);
  t.mock.timers.tick(5000); await flush(); assert.equal(calls, 3);
});

test('ICE assistance is bounded and paced; opening mid-replay cancels the rest', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { connection, native, sent } = fixture(t);
  await connection.start();
  for (let i = 0; i < 50; i++) native.onicecandidate({ candidate: { candidate: `candidate:${i}`, usernameFragment: 'local' } });
  await flush(); assert.equal(sent.length, 51, 'normal candidate delivery must not be truncated');
  t.mock.timers.tick(3000); await flush(); assert.equal(sent.length, 52, 'only description immediately, not a burst of ICE');
  for (let i = 0; i < 20; i++) { t.mock.timers.tick(150); await flush(); }
  assert.equal(sent.length, 68, 'at most 16 candidates cached for replay');
  t.mock.timers.tick(2000); await flush(); assert.equal(sent.length, 69);
  native.open(); t.mock.timers.tick(30000); await flush(); assert.equal(sent.length, 69);
});

test('assisted negotiation correlates answers and ICE with this exact attempt', async (t) => {
  const { connection, native, sent } = fixture(t);
  await connection.start();
  const id = sent[0].negotiationId;
  assert.ok(typeof id === 'string' && id.length > 10, 'offer needs an attempt identity');
  await connection.handleSignal({ type: 'answer', negotiationId: 'retired-attempt', description: desc('answer', 'bad') });
  await connection.handleSignal({ type: 'ice', negotiationId: 'retired-attempt', candidate: { candidate: 'candidate:bad' } });
  assert.equal(native.remoteSets, 0); assert.equal(native.added.length, 0);
  const answer = { type: 'answer', negotiationId: id, description: desc('answer', 'remote') };
  await connection.handleSignal(answer);
  await connection.handleSignal(answer);
  assert.equal(native.remoteSets, 1, 'replayed answers must not re-apply SDP');
});

test('replayed ICE is applied only once; real current-generation ICE errors are not hidden', async (t) => {
  const { connection, native, sent } = fixture(t);
  await connection.start(); const negotiationId = sent[0].negotiationId;
  const candidate = { candidate: 'candidate:one', usernameFragment: 'remote' };
  await connection.handleSignal({ type: 'ice', negotiationId, candidate });
  await connection.handleSignal({ type: 'ice', negotiationId, candidate });
  await connection.handleSignal({ type: 'answer', negotiationId, description: desc('answer', 'remote') });
  await connection.handleSignal({ type: 'ice', negotiationId, candidate });
  assert.equal(native.added.length, 1);
  await assert.rejects(connection.handleSignal({ type: 'ice', negotiationId, candidate: { candidate: 'broken', usernameFragment: 'remote' } }), /bad current ICE/);
});

function teacherFixture(t) {
  const created = [], sent = [], removed = [];
  const network = createTeacherPeerNetwork({ signaling: { send: async (id, signal) => sent.push({ id, signal }) },
    peerHub: { addPeer: () => () => {}, removePeer: id => removed.push(id), handleMessage: async () => {} },
    createConnection: options => {
      const record = { options, handled: [], replayed: 0, closed: 0 };
      record.connection = { start: async () => {}, handleSignal: async s => { record.handled.push(s); },
        resendSignaling: () => { record.replayed++; }, close: () => { record.closed++; } };
      created.push(record); return record.connection;
    },
  });
  t.after(() => network.close()); return { network, created, sent, removed };
}
const packet = (id, type = 'offer') => ({ sourceId: 'student', signal: { type, negotiationId: id, ...(type === 'offer' ? { description: desc(type, id) } : { candidate: { candidate: `candidate:${id}` } }) } });

test('teacher duplicate offer replays answer/ICE without replacing the connection', async (t) => {
  const { network, created } = teacherFixture(t);
  const offer = packet('attempt-a'); await network.handleSignal(offer); await network.handleSignal(offer);
  assert.equal(created.length, 1); assert.equal(created[0].closed, 0);
  assert.equal(created[0].replayed, 1); assert.equal(created[0].handled.length, 1);
});

test('delayed old offers and old ICE cannot replace a newer teacher connection', async (t) => {
  const { network, created } = teacherFixture(t);
  await network.handleSignal(packet('attempt-a')); await network.handleSignal(packet('attempt-b'));
  await network.handleSignal(packet('attempt-a')); await network.handleSignal(packet('attempt-a', 'ice'));
  assert.equal(created.length, 2); assert.equal(created[1].closed, 0);
  assert.equal(created[1].handled.length, 1); assert.equal(network.getPeerCount(), 1);
});

test('production teacher and student networks enable the same signaling helper', async (t) => {
  const { network, created } = teacherFixture(t); await network.handleSignal(packet('attempt-a'));
  assert.equal(created[0].options.assistSignaling, true);
  let opts;
  const student = createStudentPeerNetwork({ teacherId: 'teacher', signaling: { send: async () => {} },
    getRevision: () => 0, applyCommit: async () => {}, installSnapshot: async () => {},
    createConnection: input => { opts = input; return { start: async () => {}, close() {} }; },
  });
  t.after(() => student.close()); assert.equal(opts.assistSignaling, true);
});

test('responder echoes the attempt ID and replays its cached answer, not a new negotiation', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { connection, native, sent } = fixture(t, { initiator: false });
  const offer = packet('attempt-responder').signal;
  await connection.handleSignal(offer);
  assert.equal(sent[0].negotiationId, offer.negotiationId);
  await connection.handleSignal(offer); await flush();
  assert.equal(sent.length, 2); assert.deepEqual(sent[0], sent[1]); assert.equal(native.remoteSets, 1);
  t.mock.timers.tick(30000); await flush(); assert.equal(sent.length, 2, 'responder must not poll');
});

test('closing while offer creation is pending cannot publish or apply a late offer', async (t) => {
  let finishOffer;
  const native = new NativeStub(), sent = [];
  native.createOffer = () => new Promise(resolve => { finishOffer = resolve; });
  let localSets = 0; native.setLocalDescription = async () => { localSets++; };
  const { connection } = fixture(t, { createPeerConnection: () => native, sendSignal: async s => sent.push(s) });
  const starting = connection.start(); await flush(); connection.close();
  finishOffer(desc('offer', 'late')); await starting;
  assert.equal(localSets, 0); assert.deepEqual(sent, []);
});

test('a slow answer publish receipt does not block incoming ICE on the responder', async (t) => {
  const native = new NativeStub();
  const { connection } = fixture(t, { initiator: false, createPeerConnection: () => native, sendSignal: () => new Promise(() => {}) });
  void connection.handleSignal(packet('slow-receipt').signal); await flush();
  await connection.handleSignal({ type: 'ice', negotiationId: 'slow-receipt', candidate: { candidate: 'candidate:ok', usernameFragment: 'slow-receipt' } });
  assert.equal(native.added.length, 1);
});

test('Ably publication alone never declares editing ready; existing 15s failure path remains', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const native = new NativeStub(), sent = [];
  const student = createStudentPeerNetwork({ teacherId: 'teacher', signaling: { send: async (_id, s) => sent.push(s) },
    getRevision: () => 0, applyCommit: async () => {}, installSnapshot: async () => {},
    createConnection: options => createBrowserPeerConnection({ ...options, createPeerConnection: () => native }),
  });
  t.after(() => student.close());
  const result = student.start().catch(e => e); await flush();
  t.mock.timers.tick(3000); await flush(); t.mock.timers.tick(5000); await flush();
  assert.equal(sent.filter(s => s.type === 'offer').length, 3); assert.equal(student.isReady(), false);
  t.mock.timers.tick(7000); await flush(); assert.match((await result).message, /timed out/);
  t.mock.timers.tick(30000); await flush(); assert.equal(sent.length, 3);
});

test('untagged legacy answers still work with an updated student', async (t) => {
  const { connection, native } = fixture(t); await connection.start();
  await connection.handleSignal({ type: 'answer', description: desc('answer', 'legacy') });
  assert.equal(native.remoteDescription.sdp, desc('answer', 'legacy').sdp);
});
