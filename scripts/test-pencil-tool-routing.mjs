import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Canvas } from 'fabric/node';

const boardSource = await readFile(new URL('../src/components/Board.jsx', import.meta.url), 'utf8');

assert.match(boardSource, /const fabricInputModeSwitchRef = useRef\(null\);/);
assert.match(
  boardSource,
  /fabricInputModeSwitchRef\.current\?\.\(activeToolRef\.current === 'select'\);/,
  'Only the select/transform tool should request Fabric PointerEvents',
);

const switchStart = boardSource.indexOf('const switchFabricInputMode =');
const switchEnd = boardSource.indexOf('fabricInputModeSwitchRef.current = switchFabricInputMode', switchStart);
assert.ok(switchStart >= 0 && switchEnd > switchStart);
const switchSource = boardSource.slice(switchStart, switchEnd);
assert.match(switchSource, /canvas\._isCurrentlyDrawing \|\| canvas\._currentTransform/);
assert.match(switchSource, /canvas\.removeListeners\(\);/);
assert.match(switchSource, /canvas\.enablePointerEvents = nextPointerMode;/);
assert.match(switchSource, /canvas\.mainTouchId = undefined;/);
assert.match(switchSource, /canvas\.addOrRemove\(addFabricDomListener\);/);
assert.ok(
  switchSource.indexOf('canvas.removeListeners();')
    < switchSource.indexOf('canvas.enablePointerEvents = nextPointerMode;'),
  'Old Fabric listeners must be removed using their original event prefix',
);

// Exercise Fabric 7.4's actual listener lifecycle. This is the same operation performed
// on tool changes: drawing starts in TouchEvent mode, selection uses PointerEvents, and
// returning to the pencil restores TouchEvents without recreating the canvas or objects.
const canvas = new Canvas(null, { width: 20, height: 20 });
const addListener = (element, type, listener, options) => {
  element.addEventListener(type, listener, options);
};
const switchMode = (pointerMode) => {
  canvas.removeListeners();
  canvas.enablePointerEvents = pointerMode;
  canvas.mainTouchId = undefined;
  canvas.addOrRemove(addListener);
};

assert.equal(Boolean(canvas.enablePointerEvents), false);
const marker = { boardObjectId: 'kept-across-input-switch' };
canvas.__routingMarker = marker;
switchMode(true);
assert.equal(canvas.enablePointerEvents, true);
assert.equal(canvas.__routingMarker, marker);
switchMode(false);
assert.equal(canvas.enablePointerEvents, false);
assert.equal(canvas.__routingMarker, marker);
await canvas.dispose();

console.log('Independent Pencil drawing and transform input routing passed.');
