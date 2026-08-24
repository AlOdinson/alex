import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  MAX_REMOTE_BROWSER_VIEWERS,
  normalizeRemoteBrowserState,
  normalizeScreenShareSignal,
  remoteBrowserPointerCoordinates,
  SCREEN_SHARE_PROTOCOL,
} from '../src/lib/screenShare.js';

assert.equal(MAX_REMOTE_BROWSER_VIEWERS, 4, 'the Mac agent must not count as a human participant');

const availability = normalizeScreenShareSignal({
  protocol: SCREEN_SHARE_PROTOCOL,
  type: 'remote-browser-available',
  clientId: 'mac-agent',
  sessionId: 'agent-session',
  permission: 'owner',
});
assert.equal(availability?.clientId, 'mac-agent');
assert.equal(availability?.type, 'remote-browser-available');

assert.deepEqual(normalizeRemoteBrowserState({
  url: 'https://example.com',
  width: 99999,
  height: -5,
  frameRate: 200,
  quality: 0,
}), {
  url: 'https://example.com',
  title: '',
  loading: false,
  canGoBack: false,
  canGoForward: false,
  controllerId: '',
  controllerName: '',
  width: 3840,
  height: 1,
  frameRate: 30,
  quality: 1,
});

const centre = remoteBrowserPointerCoordinates({
  clientX: 500,
  clientY: 300,
  rect: { left: 0, top: 0, width: 1000, height: 600 },
  viewportWidth: 1280,
  viewportHeight: 720,
});
assert.equal(centre.inside, true);
assert.ok(Math.abs(centre.x - 640) < 0.01);
assert.ok(Math.abs(centre.y - 360) < 0.01);

const [boardSource, hostSource] = await Promise.all([
  readFile(new URL('../src/components/Board.jsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/MacBrowserHost.jsx', import.meta.url), 'utf8'),
]);
assert.match(boardSource, /isMacBrowserHostMode\(\)/, 'the agent route must bypass the Fabric workspace');
assert.match(hostSource, /canvas\.captureStream\(0\)/, 'idle pages must emit zero scheduled canvas frames');
assert.match(hostSource, /track\?\.requestFrame\?\.\(\)/, 'each changed frame must be requested explicitly');
assert.doesNotMatch(hostSource, /saveBoardSnapshot|applyBoardAction|Fabric/, 'browser frames must not enter board persistence');

console.log('Mac remote browser protocol tests passed');
