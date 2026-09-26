import assert from 'node:assert/strict';
import test from 'node:test';
import { createLiveTransportRouter } from '../src/lib/liveTransportRouter.js';

test('legacy mode publishes board live events only through Ably', async () => {
  const webrtc = [];
  const ably = [];
  const router = createLiveTransportRouter({
    enabled: false,
    sendWebRtcLive: (...args) => { webrtc.push(args); return 'sent'; },
    publishLegacyAbly: async (...args) => { ably.push(args); return 'ok'; },
    needsLegacyAbly: () => true,
  });
  const result = await router.send('cursor', { x: 1 }, { streamKey: 'cursor' });
  assert.equal(result.route, 'ably-legacy');
  assert.equal(webrtc.length, 0);
  assert.equal(ably.length, 1);
});

test('v1-only peers send board live events through WebRTC and never Ably', async () => {
  const webrtc = [];
  const ably = [];
  const router = createLiveTransportRouter({
    enabled: true,
    sendWebRtcLive: (...args) => { webrtc.push(args); return 'sent'; },
    publishLegacyAbly: async (...args) => { ably.push(args); return 'ok'; },
    needsLegacyAbly: () => false,
  });
  const result = await router.send('transform', { objectId: 'x' }, { streamKey: 'transform:x' });
  assert.equal(result.route, 'webrtc');
  assert.equal(webrtc.length, 1);
  assert.equal(ably.length, 0);
  assert.deepEqual(webrtc[0], ['transform', { objectId: 'x' }, { streamKey: 'transform:x' }]);
});

test('mixed owner sends WebRTC to capable peers and Ably only for legacy peers', async () => {
  const calls = [];
  const router = createLiveTransportRouter({
    enabled: true,
    sendWebRtcLive: (...args) => { calls.push(['webrtc', ...args]); return [{ peerId: 'new', result: 'sent' }]; },
    publishLegacyAbly: async (...args) => { calls.push(['ably', ...args]); return 'ok'; },
    needsLegacyAbly: () => true,
  });
  const result = await router.send('cursor', { x: 2 }, { streamKey: 'cursor' });
  assert.equal(result.route, 'webrtc+ably-legacy');
  assert.deepEqual(calls.map((entry) => entry[0]), ['webrtc', 'ably']);
});

test('new-capability mode never falls back board live traffic to Ably when live channel is unavailable', async () => {
  let ablyCalls = 0;
  const router = createLiveTransportRouter({
    enabled: true,
    sendWebRtcLive: () => 'unavailable',
    publishLegacyAbly: async () => { ablyCalls += 1; return 'ok'; },
    needsLegacyAbly: () => false,
  });
  const result = await router.send('draw', { points: [[1, 2]] }, { streamKey: 'draw:stroke-a' });
  assert.equal(result.route, 'webrtc-unavailable');
  assert.equal(ablyCalls, 0);
});
