import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserPeerConnection } from '../src/lib/browserPeerConnection.js';
import { createTeacherPeerNetwork } from '../src/lib/teacherPeerNetwork.js';
import { createStudentPeerNetwork } from '../src/lib/studentPeerNetwork.js';
import { normalizeBoardPeerSignal, BOARD_PEER_SIGNAL_PROTOCOL, BOARD_PEER_SIGNAL_TYPE } from '../src/lib/boardPeerSignaling.js';

const flush = async () => { for (let i = 0; i < 30; i += 1) await Promise.resolve(); };

class PeerStub {
  constructor(config = {}) {
    this.config = config;
    this.localDescription = null;
    this.remoteDescription = null;
    this.connectionState = 'new';
    this.created = [];
  }
  createDataChannel(label, options) {
    const channel = { label, options, readyState: 'connecting', close() { this.readyState = 'closed'; } };
    this.created.push(channel);
    return channel;
  }
  async createOffer() { return { type: 'offer', sdp: 'v=0\r\na=ice-ufrag:offer\r\n' }; }
  async createAnswer() { return { type: 'answer', sdp: 'v=0\r\na=ice-ufrag:answer\r\n' }; }
  async setLocalDescription(value) { this.localDescription = value; }
  async setRemoteDescription(value) { this.remoteDescription = value; }
  async addIceCandidate() {}
  close() { this.connectionState = 'closed'; }
}

test('default WebRTC config pre-gathers ICE candidates', () => {
  let config;
  createBrowserPeerConnection({
    sendSignal: async () => {},
    createPeerConnection: (value) => { config = value; return new PeerStub(value); },
  });
  assert.equal(config.iceCandidatePoolSize, 2);
});

test('responder retries answer at 1s and 2.5s when the durable channel is still absent', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sent = [];
  const peer = createBrowserPeerConnection({
    initiator: false,
    assistSignaling: true,
    sendSignal: async (signal) => sent.push(signal),
    createPeerConnection: () => new PeerStub(),
  });
  await peer.handleSignal({
    type: 'offer',
    negotiationId: 'attempt-a',
    description: { type: 'offer', sdp: 'v=0\r\na=ice-ufrag:remote\r\n' },
  });
  assert.equal(sent.filter((signal) => signal.type === 'answer').length, 1);
  t.mock.timers.tick(1000); await flush();
  assert.equal(sent.filter((signal) => signal.type === 'answer').length, 2);
  t.mock.timers.tick(1500); await flush();
  assert.equal(sent.filter((signal) => signal.type === 'answer').length, 3);
  peer.close();
});

test('role-switch is a valid board signaling message', () => {
  const parsed = normalizeBoardPeerSignal({
    protocol: BOARD_PEER_SIGNAL_PROTOCOL,
    type: BOARD_PEER_SIGNAL_TYPE,
    sourceId: 'student',
    targetId: 'teacher',
    signal: { type: 'role-switch' },
  }, 'teacher');
  assert.equal(parsed.signal.type, 'role-switch');
});

test('student reverses to responder after 5s and asks teacher to become initiator', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const created = [];
  const sent = [];
  const network = createStudentPeerNetwork({
    teacherId: 'teacher',
    signaling: { send: async (peerId, signal) => sent.push({ peerId, signal }) },
    getRevision: () => 0,
    applyCommit: async () => {},
    installSnapshot: async () => {},
    createConnection: (options) => {
      const record = { options, closed: 0, started: 0 };
      record.connection = {
        async start() { record.started += 1; },
        async handleSignal() {},
        close() { record.closed += 1; },
      };
      created.push(record);
      return record.connection;
    },
    createTransport: () => ({ send: async () => {}, close() {} }),
    createSession: () => ({ async start() {}, close() {} }),
  });
  const starting = network.start();
  await flush();
  assert.equal(created[0].options.initiator, true);
  t.mock.timers.tick(5000); await flush();
  assert.equal(created[0].closed, 1);
  assert.equal(created[1].options.initiator, false);
  assert.deepEqual(sent.at(-1), { peerId: 'teacher', signal: { type: 'role-switch' } });
  created[1].options.onChannel({ label: 'alex-board-durable-v1' });
  await starting;
  assert.equal(network.isReady(), true);
  network.close();
});

test('teacher turns a role-switch request into a new initiator peer', async () => {
  const created = [];
  const network = createTeacherPeerNetwork({
    signaling: { send: async () => {} },
    peerHub: { addPeer: () => () => {}, removePeer: () => {}, handleMessage: async () => {} },
    createConnection: (options) => {
      const record = { options, closed: 0, started: 0, replayed: 0 };
      record.connection = {
        async start() { record.started += 1; },
        async handleSignal() {},
        resendSignaling() { record.replayed += 1; },
        close() { record.closed += 1; },
      };
      created.push(record);
      return record.connection;
    },
    createTransport: () => ({ send: async () => {}, close() {} }),
  });
  await network.handleSignal({ sourceId: 'student', signal: { type: 'offer' } });
  assert.equal(created[0].options.initiator, false);
  await network.handleSignal({ sourceId: 'student', signal: { type: 'role-switch' } });
  await flush();
  assert.equal(created[0].closed, 1);
  assert.equal(created[1].options.initiator, true);
  assert.equal(created[1].options.enableLiveChannel, true);
  await network.handleSignal({ sourceId: 'student', signal: { type: 'role-switch' } });
  assert.equal(created.length, 2);
  assert.equal(created[1].replayed, 1);
  network.close();
});
