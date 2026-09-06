import assert from 'node:assert/strict';
import * as screenShare from '../src/lib/screenShare.js';

assert.equal(
  typeof screenShare.screenShareCloudTrackName,
  'function',
  'screen-share protocol should expose a deterministic Cloud track-name helper',
);
assert.equal(
  typeof screenShare.normalizeCloudScreenShareRoute,
  'function',
  'screen-share protocol should expose a Cloud route validator',
);

assert.equal(
  screenShare.screenShareCloudTrackName('boardABC', 'sessionXYZ'),
  'screen:boardABC:sessionXYZ',
  'Cloud track names are scoped to the board and current screen-share session',
);
assert.equal(
  screenShare.screenShareCloudTrackName('bad board', 'sessionXYZ'),
  '',
  'invalid board identifiers are rejected rather than silently rewritten',
);
assert.equal(
  screenShare.screenShareCloudTrackName('boardABC', 'bad session'),
  '',
  'invalid session identifiers are rejected rather than silently rewritten',
);

assert.deepEqual(
  screenShare.normalizeCloudScreenShareRoute({
    publisherSessionId: 'pub_123456',
    trackName: 'screen:boardABC:sessionXYZ',
  }),
  {
    publisherSessionId: 'pub_123456',
    trackName: 'screen:boardABC:sessionXYZ',
  },
  'valid Cloud routing identifiers are preserved',
);
assert.equal(
  screenShare.normalizeCloudScreenShareRoute({
    publisherSessionId: '',
    trackName: 'screen:boardABC:sessionXYZ',
  }),
  null,
  'empty publisher session ids are rejected',
);
assert.equal(
  screenShare.normalizeCloudScreenShareRoute({
    publisherSessionId: 'pub_123456',
    trackName: 'screen:other:sessionXYZ',
  }, {
    boardId: 'boardABC',
    screenShareSessionId: 'sessionXYZ',
  }),
  null,
  'a route for another board is rejected when expected scope is supplied',
);

const cloudTrack = screenShare.normalizeScreenShareSignal({
  protocol: screenShare.SCREEN_SHARE_PROTOCOL,
  type: 'cloud-track',
  clientId: 'teacher',
  permission: 'owner',
  sessionId: 'sessionXYZ',
  publisherSessionId: 'pub_123456',
  trackName: 'screen:boardABC:sessionXYZ',
});
assert.equal(cloudTrack?.type, 'cloud-track', 'Cloud track announcement is a first-class signal');
assert.equal(cloudTrack?.publisherSessionId, 'pub_123456');
assert.equal(cloudTrack?.trackName, 'screen:boardABC:sessionXYZ');

const cloudDisable = screenShare.normalizeScreenShareSignal({
  protocol: screenShare.SCREEN_SHARE_PROTOCOL,
  type: 'cloud-disable',
  clientId: 'teacher',
  permission: 'owner',
  sessionId: 'sessionXYZ',
});
assert.equal(cloudDisable?.type, 'cloud-disable', 'Cloud disable is a first-class signal');

const cloudReady = screenShare.normalizeScreenShareSignal({
  protocol: screenShare.SCREEN_SHARE_PROTOCOL,
  type: 'cloud-viewer-ready',
  clientId: 'student',
  permission: 'view',
  sessionId: 'sessionXYZ',
  targetId: 'teacher',
});
assert.equal(cloudReady?.type, 'cloud-viewer-ready', 'viewer Cloud readiness is a first-class signal');

assert.equal(
  screenShare.normalizeScreenShareSignal({
    protocol: screenShare.SCREEN_SHARE_PROTOCOL,
    type: 'cloud-track',
    clientId: 'teacher',
    permission: 'owner',
    sessionId: 'sessionXYZ',
    publisherSessionId: '',
    trackName: 'screen:boardABC:sessionXYZ',
  }),
  null,
  'malformed Cloud track announcements are rejected',
);

const legacyOffer = screenShare.normalizeScreenShareSignal({
  protocol: screenShare.SCREEN_SHARE_PROTOCOL,
  type: 'offer',
  clientId: 'teacher',
  permission: 'owner',
  sessionId: 'sessionXYZ',
  targetId: 'student',
  description: { type: 'offer', sdp: 'test' },
});
assert.equal(legacyOffer?.type, 'offer', 'existing P2P signaling still normalizes');

console.log('Cloud screen-share protocol tests passed');
