import assert from 'node:assert/strict';
import {
  MAX_SCREEN_SHARE_VIEWERS,
  normalizeScreenShareSignal,
  preferredScreenShareSession,
  SCREEN_SHARE_PROTOCOL,
  screenShareCapability,
  screenShareNetworkIsDegraded,
  screenShareProfileForActivity,
} from '../src/lib/screenShare.js';

assert.equal(MAX_SCREEN_SHARE_VIEWERS, 3, 'three viewers plus the presenter must fit the four-person limit');

assert.deepEqual(
  screenShareCapability({
    platform: 'MacIntel',
    maxTouchPoints: 5,
    userAgent: 'iPad Safari',
    mediaDevices: {},
  }),
  {
    supported: false,
    iosLike: true,
    advice: 'Этот браузер не разрешает захват экрана. Откройте эту же ссылку в Safari и попробуйте снова.',
  },
);

assert.equal(screenShareCapability({
  platform: 'MacIntel',
  maxTouchPoints: 5,
  mediaDevices: { getDisplayMedia() {} },
}).supported, true);

const first = { sessionId: 'first', hostId: 'teacher-b', startedAt: 100 };
const second = { sessionId: 'second', hostId: 'teacher-a', startedAt: 101 };
assert.equal(preferredScreenShareSession(first, second), first, 'the first session wins simultaneous owner starts');
assert.equal(
  preferredScreenShareSession(
    { sessionId: 'z', hostId: 'teacher-z', startedAt: 100 },
    { sessionId: 'a', hostId: 'teacher-a', startedAt: 100 },
  ).sessionId,
  'a',
  'the client id provides a deterministic tie break',
);

assert.equal(screenShareProfileForActivity({
  now: 5_000,
  lastMotionAt: 4_500,
  lastInteractionAt: 4_500,
}).id, 'motion');
assert.equal(screenShareProfileForActivity({
  now: 5_000,
  lastMotionAt: 3_000,
  lastInteractionAt: 4_000,
}).id, 'active');
assert.equal(screenShareProfileForActivity({
  now: 5_000,
  lastMotionAt: 1_000,
  lastInteractionAt: 1_000,
}).id, 'idle');

assert.equal(screenShareNetworkIsDegraded({ fractionLost: 0.09, roundTripTime: 0.05 }), true);
assert.equal(screenShareNetworkIsDegraded({ fractionLost: 0.01, roundTripTime: 0.4 }), true);
assert.equal(screenShareNetworkIsDegraded({ fractionLost: 0.01, roundTripTime: 0.1 }), false);

const normalized = normalizeScreenShareSignal({
  protocol: SCREEN_SHARE_PROTOCOL,
  type: 'offer',
  clientId: 'teacher',
  sessionId: 'session',
  targetId: 'student',
  permission: 'owner',
  description: { type: 'offer', sdp: 'test' },
});
assert.equal(normalized.clientId, 'teacher');
assert.equal(normalized.targetId, 'student');
assert.equal(normalizeScreenShareSignal({
  protocol: 'wrong-protocol',
  type: 'offer',
  clientId: 'teacher',
  sessionId: 'session',
}), null);

console.log('screen-share protocol tests passed');
