import assert from 'node:assert/strict';
import test from 'node:test';
import { createLiveTransportRouter } from '../src/lib/liveTransportRouter.js';

test('disabled WebRTC never routes board traffic through Ably', async () => {
  const webrtc = [];
  const router = createLiveTransportRouter({
    enabled: false,
    sendWebRtcLive: (...args) => { webrtc.push(args); return 'sent'; },
  });
  const result = await router.send('cursor', { x: 1 }, { streamKey: 'cursor' });
  assert.equal(result.route, 'webrtc-disabled');
  assert.equal(result.liveResult, 'disabled');
  assert.equal(result.legacyResult, null);
  assert.equal(webrtc.length, 0);
});

test('enabled board live events use WebRTC only', async () => {
  const webrtc = [];
  const router = createLiveTransportRouter({
    enabled: true,
    sendWebRtcLive: (...args) => { webrtc.push(args); return 'sent'; },
  });
  const result = await router.send('transform', { objectId: 'x' }, { streamKey: 'transform:x' });
  assert.equal(result.route, 'webrtc');
  assert.equal(webrtc.length, 1);
  assert.deepEqual(webrtc[0], ['transform', { objectId: 'x' }, { streamKey: 'transform:x' }]);
});

test('legacy participant presence cannot turn Ably back into a live fallback', async () => {
  const calls = [];
  const router = createLiveTransportRouter({
    enabled: true,
    sendWebRtcLive: (...args) => {
      calls.push(['webrtc', ...args]);
      return [{ peerId: 'new', result: 'sent' }, { peerId: 'legacy', result: 'unavailable' }];
    },
  });
  const result = await router.send('cursor', { x: 2 }, { streamKey: 'cursor' });
  assert.equal(result.route, 'webrtc');
  assert.deepEqual(calls.map((entry) => entry[0]), ['webrtc']);
});

test('unavailable WebRTC live never falls back to Ably', async () => {
  const router = createLiveTransportRouter({
    enabled: true,
    sendWebRtcLive: () => 'unavailable',
  });
  const result = await router.send('draw', { points: [[1, 2]] }, { streamKey: 'draw:stroke-a' });
  assert.equal(result.route, 'webrtc-unavailable');
  assert.equal(result.legacyResult, null);
});

test('routing diagnostics keep Ably counters permanently at zero', async () => {
  let liveResult = 'sent';
  const router = createLiveTransportRouter({
    enabled: true,
    sendWebRtcLive: () => liveResult,
  });

  await router.send('cursor', { x: 1 });
  await router.send('cursor', { x: 2 });
  liveResult = 'unavailable';
  await router.send('draw', { points: [] });
  router.close();
  await router.send('view', { zoom: 1 });

  assert.deepEqual(router.stats(), {
    total: 4,
    webrtc: 2,
    mixed: 0,
    ablyLegacy: 0,
    unavailable: 1,
    closed: 1,
  });
});
