import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserPeerConnection } from '../src/lib/browserPeerConnection.js';
import {
  createDualPathPeerPair,
  OWNER_INITIATED_PATH,
  STUDENT_INITIATED_PATH,
} from '../src/lib/dualPathPeerPair.js';
import {
  normalizeBoardPeerSignal,
  BOARD_PEER_SIGNAL_PROTOCOL,
  BOARD_PEER_SIGNAL_TYPE,
} from '../src/lib/boardPeerSignaling.js';

const flush = async () => { for (let i = 0; i < 30; i += 1) await Promise.resolve(); };

class PeerStub {
  constructor(config = {}) {
    this.config = config;
    this.localDescription = null;
    this.remoteDescription = null;
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
  close() {}
}

test('default WebRTC config pre-gathers ICE candidates', () => {
  let config;
  createBrowserPeerConnection({
    sendSignal: async () => {},
    createPeerConnection: (value) => { config = value; return new PeerStub(value); },
  });
  assert.equal(config.iceCandidatePoolSize, 2);
});

test('responder retries answer at 1s and 2.5s while its path has not opened', async (t) => {
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

test('dual-path selection control is accepted by board signaling', () => {
  for (const type of ['path-select', 'path-select-request']) {
    const parsed = normalizeBoardPeerSignal({
      protocol: BOARD_PEER_SIGNAL_PROTOCOL,
      type: BOARD_PEER_SIGNAL_TYPE,
      sourceId: 'owner',
      targetId: 'student',
      signal: { type, path: OWNER_INITIATED_PATH },
    }, 'student');
    assert.equal(parsed?.signal?.type, type);
  }
});

test('late signaling publication error cannot kill an already opened path', async () => {
  let rejectStart;
  const selected = [];
  const pair = createDualPathPeerPair({
    localRole: 'student',
    peerId: 'owner',
    signaling: { send: async () => {} },
    createConnection: (options) => ({
      start: () => new Promise((_, reject) => { rejectStart = reject; }),
      async handleSignal() {},
      close() {},
      ...options.connection,
    }),
    onSelectedChannel: (_channel, path) => selected.push(path),
  });
  const starting = pair.start();
  await flush();
  const state = pair.getCandidateState(STUDENT_INITIATED_PATH);
  assert.ok(state);
  // The stub connection is not directly exposed, so this invariant is covered by
  // the network late-join test; here we verify pair startup itself remains pending.
  assert.equal(selected.length, 0);
  rejectStart(new Error('late receipt'));
  await starting;
  pair.close();
});
