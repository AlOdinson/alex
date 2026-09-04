import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  applyScreenShareLayoutToFabricObject,
  isBoardScreenShareObject,
  screenShareLayoutFromFabricObject,
} from '../src/lib/boardScreenShare.js';

const source = fs.readFileSync(new URL('../src/lib/boardScreenShare.js', import.meta.url), 'utf8');

const object = {
  width: 1280,
  height: 720,
  left: 0,
  top: 0,
  scaleX: 1,
  scaleY: 1,
  set(patch) { Object.assign(this, patch); },
  setCoords() { this.coordsUpdated = true; },
};

applyScreenShareLayoutToFabricObject(object, {
  left: 100,
  top: 200,
  width: 640,
  height: 360,
});
assert.equal(object.left, 420);
assert.equal(object.top, 380);
assert.equal(object.scaleX, 0.5);
assert.equal(object.scaleY, 0.5);
assert.equal(object.angle, 0, 'screen share object cannot retain rotation');
assert.equal(object.coordsUpdated, true);
assert.deepEqual(screenShareLayoutFromFabricObject(object), {
  left: 100,
  top: 200,
  width: 640,
  height: 360,
});

assert.equal(isBoardScreenShareObject({ transientScreenShare: true }), true);
assert.equal(isBoardScreenShareObject({ objectKind: 'image' }), false);

assert.match(source, /new FabricImage\(/, 'live screen must be represented by a FabricImage');
assert.match(source, /transientScreenShare:\s*true/, 'live screen must be explicitly marked transient');
assert.match(source, /excludeFromExport:\s*true/, 'live screen must never be serialized into board exports');
assert.match(source, /lockRotation:\s*true/, 'rotation must be locked');
assert.match(source, /lockSkewingX:\s*true/, 'horizontal skew must be locked');
assert.match(source, /lockSkewingY:\s*true/, 'vertical skew must be locked');
assert.match(source, /setControlsVisibility(?:\?\.)?\(\{[\s\S]*?mtr:\s*false/, 'rotation control must be hidden');
assert.match(source, /requestVideoFrameCallback|setInterval/, 'video frames must schedule Fabric rendering');
assert.match(source, /setStream/, 'media controller must be able to attach the WebRTC MediaStream');
assert.match(source, /dispose/, 'media controller must clean up video/frame resources');

console.log('board screen-share Fabric object regression passed');