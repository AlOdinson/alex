import assert from 'node:assert/strict';
import fs from 'node:fs';

const screenSharePath = new URL('../src/components/ScreenShare.jsx', import.meta.url);
const cloudHookPath = new URL('../src/components/useCloudScreenShareFallback.js', import.meta.url);
const source = fs.readFileSync(screenSharePath, 'utf8');

assert.equal(
  fs.existsSync(cloudHookPath),
  true,
  'Cloud fallback lifecycle must live in its own focused hook module',
);
const cloudSource = fs.readFileSync(cloudHookPath, 'utf8');

assert.match(source, /useCloudScreenShareFallback/, 'screen-share hook must compose the Cloud fallback hook');
assert.match(source, /setCloudEnabled/, 'screen-share result must expose manual Cloud switching');
assert.match(source, /cloudPhase/, 'screen-share result must expose Cloud connection phase');
assert.match(source, /transport/, 'screen-share result must expose active media transport');
assert.equal(
  (source.match(/getDisplayMedia\(/g) ?? []).length,
  1,
  'transport switching must never request screen capture a second time',
);

assert.match(cloudSource, /createCloudflarePublisher/, 'Cloud hook must create a Cloud publisher');
assert.match(cloudSource, /createCloudflareSubscriber/, 'Cloud hook must create a Cloud subscriber');
assert.match(cloudSource, /screenShareCloudTrackName/, 'Cloud route must use the deterministic protocol helper');
assert.match(cloudSource, /cloud-track/, 'Cloud track announcements must be signaled');
assert.match(cloudSource, /cloud-disable/, 'manual return to P2P must be signaled');
assert.match(cloudSource, /cloud-viewer-ready/, 'viewer readiness must be signaled for diagnostics');
assert.match(cloudSource, /transport:\s*'p2p'/, 'Cloud fallback starts in P2P mode');
assert.match(cloudSource, /cloudPhase:\s*'off'/, 'Cloud fallback starts off');
assert.match(cloudSource, /publisher\.sender/, 'adaptive profile must be applied to the Cloud publisher sender');
assert.match(cloudSource, /signal\.sessionId !== sessionId/, 'stale Cloud signals must be ignored');
assert.match(cloudSource, /clearCloudPublisher/, 'host teardown must clean Cloud publisher resources');
assert.match(cloudSource, /clearCloudSubscriber/, 'viewer teardown must clean Cloud subscriber resources');
assert.doesNotMatch(
  cloudSource,
  /closePeer\(.*p2p|hostPeersRef|viewerPeerRef/,
  'Cloud v1 must leave the existing P2P path warm instead of destroying it',
);

console.log('Cloud screen-share lifecycle source tests passed');
