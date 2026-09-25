import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserPeerConnection } from '../src/lib/browserPeerConnection.js';

test('replayed answer uses its original identity even after native SDP accumulates ICE', async (t) => {
  let remoteSets = 0;
  const native = {
    createDataChannel: label => ({ label, readyState: 'connecting', close() {} }),
    createOffer: async () => ({ type: 'offer', sdp: 'v=0\r\na=ice-ufrag:local\r\n' }),
    async setLocalDescription(value) { this.localDescription = value; },
    async setRemoteDescription(value) { this.remoteDescription = value; remoteSets++; },
    addIceCandidate: async () => {}, close() {},
  };
  const sent = [];
  const peer = createBrowserPeerConnection({ initiator: true, assistSignaling: true,
    createPeerConnection: () => native, sendSignal: async s => sent.push(s) });
  t.after(() => peer.close());
  await peer.start();
  const answer = { type: 'answer', negotiationId: sent[0].negotiationId,
    description: { type: 'answer', sdp: 'v=0\r\na=ice-ufrag:remote\r\n' } };
  await peer.handleSignal(answer);
  native.remoteDescription = { ...native.remoteDescription,
    sdp: native.remoteDescription.sdp + 'a=candidate:later\r\n' };
  await peer.handleSignal(answer);
  assert.equal(remoteSets, 1, 'must not setRemoteDescription(answer) again in stable state');
});
