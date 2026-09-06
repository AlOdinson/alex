import assert from 'node:assert/strict';
import fs from 'node:fs';

const screenSharePath = new URL('../src/components/ScreenShare.jsx', import.meta.url);
const source = fs.readFileSync(screenSharePath, 'utf8');

assert.match(source, /createCloudflarePublisher/, 'screen-share hook must create a Cloud publisher');
assert.match(source, /createCloudflareSubscriber/, 'screen-share hook must create a Cloud subscriber');
assert.match(source, /setCloudEnabled/, 'screen-share hook must expose manual Cloud switching');
assert.match(source, /cloudPhase/, 'screen-share view must expose Cloud connection phase');
assert.match(source, /transport:\s*'p2p'/, 'new shares must default to P2P');
assert.match(source, /cloudPhase:\s*'off'/, 'Cloud must default to off');
assert.match(source, /cloud-viewer-ready/, 'viewer Cloud readiness must be handled');
assert.match(source, /cloud-disable/, 'manual return to P2P must be handled');
assert.match(source, /screenShareCloudTrackName/, 'Cloud route must use the deterministic protocol helper');
assert.match(source, /cloudPublisherRef\.current\?\.sender/, 'adaptive sender profile must include Cloud publisher');
assert.equal(
  (source.match(/getDisplayMedia\(/g) ?? []).length,
  1,
  'transport switching must never request screen capture a second time',
);
assert.match(source, /clearCloudPublisher/, 'host teardown must clean Cloud publisher resources');
assert.match(source, /clearCloudSubscriber/, 'viewer teardown must clean Cloud subscriber resources');
assert.match(source, /signal\.sessionId !== activeSessionRef\.current\?\.sessionId/, 'stale Cloud signals must be ignored');

console.log('Cloud screen-share lifecycle source tests passed');
