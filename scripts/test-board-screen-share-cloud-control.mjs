import assert from 'node:assert/strict';
import fs from 'node:fs';

const mediaSource = fs.readFileSync(new URL('../src/lib/boardScreenShare.js', import.meta.url), 'utf8');
const cloudHookSource = fs.readFileSync(new URL('../src/components/useCloudScreenShareFallback.js', import.meta.url), 'utf8');

assert.match(mediaSource, /alex-screen-share-cloud-state/, 'board media must listen for host-only Cloud state');
assert.match(mediaSource, /alex-screen-share-cloud-state-request/, 'board media must request the current Cloud state when attached');
assert.match(mediaSource, /alex-screen-share-cloud-toggle/, 'board media must dispatch the manual Cloud toggle');
assert.match(mediaSource, /createElement\(['"]button['"]\)/, 'Cloud switch must be a real accessible DOM button');
assert.match(mediaSource, /Cloud ☐/, 'off state must be visible as Cloud unchecked');
assert.match(mediaSource, /Cloud ☑/, 'on state must be visible as Cloud checked');
assert.match(mediaSource, /Cloud …/, 'connecting state must be visibly distinct');
assert.match(mediaSource, /Cloud ⚠/, 'error state must be visibly distinct');
assert.match(mediaSource, /after:render/, 'Cloud button must follow Fabric transforms and viewport changes');
assert.match(mediaSource, /getBoundingClientRect/, 'Cloud button must anchor in canvas screen coordinates');
assert.match(mediaSource, /screenShareSessionId/, 'Cloud button must stay scoped to the current screen-share session');
assert.match(mediaSource, /CustomEvent\([^)]*CLOUD_SCREEN_SHARE_TOGGLE_EVENT/, 'button click must emit the Cloud toggle event');
assert.match(mediaSource, /removeEventListener\([^)]*CLOUD_SCREEN_SHARE_STATE_EVENT/, 'controller disposal must remove the Cloud state listener');
assert.match(mediaSource, /cloudButton\?\.remove\(\)/, 'controller disposal must remove the DOM button');

assert.match(cloudHookSource, /CLOUD_SCREEN_SHARE_STATE_REQUEST_EVENT/, 'Cloud hook must answer state replay requests');
assert.match(cloudHookSource, /publishCloudState/, 'Cloud hook must have one state publication path for updates and replay');
assert.match(cloudHookSource, /addEventListener\([^)]*CLOUD_SCREEN_SHARE_STATE_REQUEST_EVENT/, 'Cloud hook must listen for state replay requests');

console.log('board screen-share Cloud control regression passed');
