import assert from 'node:assert/strict';
import {
  BOARD_PEER_SIGNAL_PROTOCOL,
  BOARD_PEER_SIGNAL_TYPE,
  createBoardPeerSignalingBridge,
  normalizeBoardPeerSignal,
} from '../src/lib/boardPeerSignaling.js';

const sent = [];
const received = [];
const bridge = createBoardPeerSignalingBridge({
  clientId: 'teacher-a',
  sendScreenShareSignal: async (payload) => {
    sent.push(payload);
    return 'ok';
  },
  onSignal: async (payload) => received.push(payload),
});

await bridge.send('student-b', {
  type: 'offer',
  description: { type: 'offer', sdp: 'offer-sdp' },
});

assert.equal(sent.length, 1);
assert.equal(sent[0].protocol, BOARD_PEER_SIGNAL_PROTOCOL);
assert.equal(sent[0].type, BOARD_PEER_SIGNAL_TYPE);
assert.equal(sent[0].sourceId, 'teacher-a');
assert.equal(sent[0].targetId, 'student-b');
assert.equal(sent[0].signal.type, 'offer');
assert.ok(sent[0].sessionId.includes('teacher-a'));
assert.ok(sent[0].sessionId.includes('student-b'));

const accepted = await bridge.handle({
  protocol: BOARD_PEER_SIGNAL_PROTOCOL,
  type: BOARD_PEER_SIGNAL_TYPE,
  sessionId: 'student-b:teacher-a',
  sourceId: 'student-b',
  targetId: 'teacher-a',
  signal: { type: 'answer', description: { type: 'answer', sdp: 'answer-sdp' } },
});
assert.equal(accepted, true);
assert.equal(received.length, 1);
assert.equal(received[0].sourceId, 'student-b');
assert.equal(received[0].signal.type, 'answer');

assert.equal(await bridge.handle({
  protocol: BOARD_PEER_SIGNAL_PROTOCOL,
  type: BOARD_PEER_SIGNAL_TYPE,
  sourceId: 'student-c',
  targetId: 'somebody-else',
  signal: { type: 'ice', candidate: { candidate: 'candidate' } },
}), false);

assert.equal(normalizeBoardPeerSignal({
  protocol: BOARD_PEER_SIGNAL_PROTOCOL,
  type: BOARD_PEER_SIGNAL_TYPE,
  sourceId: 'student-b',
  targetId: 'teacher-a',
  signal: { type: 'mystery' },
}, 'teacher-a'), null);

console.log('browser authority realtime signaling bridge: ok');
