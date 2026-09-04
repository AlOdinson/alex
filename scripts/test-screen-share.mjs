import assert from 'node:assert/strict';
import {
  MAX_SCREEN_SHARE_VIEWERS,
  normalizeScreenShareBoardLayout,
  normalizeScreenShareSignal,
  preferredScreenShareSession,
  SCREEN_SHARE_PROTOCOL,
  screenShareBoardLayoutForViewport,
  screenShareCapability,
  screenShareNetworkIsDegraded,
  screenSharePermissionCanHost,
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
    advice: 'iPhone и iPad не разрешают веб-странице захватывать другую вкладку. Для показа сайтов запустите Alex Browser Server на Mac.',
  },
);

assert.equal(screenShareCapability({
  platform: 'MacIntel',
  maxTouchPoints: 5,
  mediaDevices: { getDisplayMedia() {} },
}).supported, true);

assert.equal(screenSharePermissionCanHost('owner'), true, 'the owner may present');
assert.equal(screenSharePermissionCanHost('edit'), true, 'an editor may present');
assert.equal(screenSharePermissionCanHost('view'), false, 'a view-only participant may not present');

assert.deepEqual(
  normalizeScreenShareBoardLayout({ left: 120, top: -40, width: 640, height: 360 }),
  { left: 120, top: -40, width: 640, height: 360 },
  'valid scene-space layout is preserved',
);
assert.equal(
  normalizeScreenShareBoardLayout({ left: Number.NaN, top: 0, width: 640, height: 360 }),
  null,
  'non-finite placement is rejected',
);
assert.equal(
  normalizeScreenShareBoardLayout({ left: 0, top: 0, width: 0, height: 360 }),
  null,
  'non-positive dimensions are rejected',
);

const viewportLayout = screenShareBoardLayoutForViewport({
  centerX: 1000,
  centerY: 500,
  viewportWidth: 1200,
  viewportHeight: 800,
  zoom: 1,
});
assert.equal(Number((viewportLayout.width / viewportLayout.height).toFixed(6)), Number((16 / 9).toFixed(6)));
assert.equal(viewportLayout.left + viewportLayout.width / 2, 1000, 'initial share is horizontally centered');
assert.equal(viewportLayout.top + viewportLayout.height / 2, 500, 'initial share is vertically centered');
assert.ok(viewportLayout.width <= 720, 'initial share does not dominate a desktop board');

const first = { sessionId: 'first', hostId: 'teacher-b', startedAt: 100 };
const second = { sessionId: 'second', hostId: 'teacher-a', startedAt: 101 };
assert.equal(preferredScreenShareSession(first, second), first, 'the first session wins simultaneous starts');
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

const normalizedLayoutSignal = normalizeScreenShareSignal({
  protocol: SCREEN_SHARE_PROTOCOL,
  type: 'screen-layout',
  clientId: 'student-editor',
  sessionId: 'session',
  permission: 'edit',
  layout: { left: 10, top: 20, width: 800, height: 450 },
});
assert.equal(normalizedLayoutSignal?.type, 'screen-layout', 'layout is a first-class screen-share signal');
assert.equal(normalizedLayoutSignal?.permission, 'edit');

assert.equal(normalizeScreenShareSignal({
  protocol: 'wrong-protocol',
  type: 'offer',
  clientId: 'teacher',
  sessionId: 'session',
}), null);

console.log('screen-share protocol tests passed');