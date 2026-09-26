import assert from 'node:assert/strict';
import test from 'node:test';

import {
  COLLABORATION_LIVE_CAPABILITIES,
  normalizeCollaborationCapabilities,
  resolveCollaborationMode,
} from '../src/lib/collaborationTransportFlags.js';

test('feature flag off always keeps legacy transport', () => {
  assert.equal(resolveCollaborationMode({
    enabled: false,
    localCapabilities: { webrtcLiveV1: true },
    remoteCapabilities: { webrtcLiveV1: true },
  }), 'legacy');
});

test('both capable peers select WebRTC live mode', () => {
  assert.equal(resolveCollaborationMode({
    enabled: true,
    localCapabilities: COLLABORATION_LIVE_CAPABILITIES,
    remoteCapabilities: { webrtcLiveV1: true },
  }), 'webrtc-live-v1');
});

test('missing or false remote capability falls back to legacy', () => {
  for (const remoteCapabilities of [null, {}, { webrtcLiveV1: false }]) {
    assert.equal(resolveCollaborationMode({
      enabled: true,
      localCapabilities: { webrtcLiveV1: true },
      remoteCapabilities,
    }), 'legacy');
  }
});

test('normalization only accepts an explicit boolean true capability', () => {
  assert.deepEqual(normalizeCollaborationCapabilities({ webrtcLiveV1: true, permission: 'owner' }), {
    webrtcLiveV1: true,
  });
  assert.deepEqual(normalizeCollaborationCapabilities({ webrtcLiveV1: 'true' }), {
    webrtcLiveV1: false,
  });
  assert.deepEqual(normalizeCollaborationCapabilities(null), {
    webrtcLiveV1: false,
  });
});
