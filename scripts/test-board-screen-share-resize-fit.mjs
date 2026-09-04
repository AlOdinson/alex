import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  applyScreenShareLayoutToFabricObject,
  screenShareLayoutFromFabricObject,
} from '../src/lib/boardScreenShare.js';

const mediaSource = fs.readFileSync(new URL('../src/lib/boardScreenShare.js', import.meta.url), 'utf8');
const boardSource = fs.readFileSync(new URL('../src/components/Board.jsx', import.meta.url), 'utf8');

function mockObject({ width = 1600, height = 1000, scaleX = 1, scaleY = 1 } = {}) {
  return {
    width,
    height,
    scaleX,
    scaleY,
    left: 0,
    top: 0,
    set(values) { Object.assign(this, values); },
    setCoords() {},
  };
}

// Incoming layout geometry may be stale 16:9. The live source is authoritative:
// the screen object must keep its real source aspect ratio and preserve the layout center.
{
  const object = mockObject({ width: 1600, height: 1000 });
  assert.equal(applyScreenShareLayoutToFabricObject(object, {
    left: 10,
    top: 20,
    width: 640,
    height: 360,
  }), true);
  assert.equal(object.scaleX, object.scaleY, 'ShareScreen scaling must always be uniform.');
  assert.equal(object.scaleX, 0.4, 'Requested width must determine one uniform scale.');
  assert.equal(object.left, 330, 'Changing aspect ratio must preserve the requested center X.');
  assert.equal(object.top, 200, 'Changing aspect ratio must preserve the requested center Y.');
  const layout = screenShareLayoutFromFabricObject(object);
  assert.equal(layout.width, 640);
  assert.equal(layout.height, 400, 'A 16:10 source must remain 16:10 instead of being squashed to 16:9.');
}

assert.match(
  mediaSource,
  /setControlsVisibility\?\.\(\{[\s\S]*?mt:\s*false[\s\S]*?mb:\s*false[\s\S]*?ml:\s*false[\s\S]*?mr:\s*false[\s\S]*?mtr:\s*false[\s\S]*?\}\)/,
  'ShareScreen must expose only four diagonal resize handles and no rotate handle.',
);
assert.match(
  mediaSource,
  /video\.videoWidth[\s\S]*?video\.videoHeight/,
  'ShareScreen must derive intrinsic geometry from the actual captured video dimensions.',
);
assert.match(
  mediaSource,
  /cropX:\s*0[\s\S]*?cropY:\s*0/,
  'ShareScreen must explicitly render from the full uncropped video frame.',
);
assert.match(
  mediaSource,
  /width:\s*sourceWidth[\s\S]*?height:\s*sourceHeight/,
  'Fabric image dimensions must track the entire video frame.',
);
assert.match(
  mediaSource,
  /scaleX:\s*uniformScale[\s\S]*?scaleY:\s*uniformScale/,
  'Live metadata and resize paths must keep a single uniform scale.',
);
assert.match(
  boardSource,
  /const acquireLocalSelectionLease = useCallback\([\s\S]*?isBoardScreenShareObject\(target\)[\s\S]*?Promise\.resolve\(true\)/,
  'Transient ShareScreen must bypass durable board-object leases so it can be dragged immediately.',
);

console.log('board ShareScreen move/aspect/full-frame regression passed');
