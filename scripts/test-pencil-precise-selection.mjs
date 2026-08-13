import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { ActiveSelection, Canvas, Line, Rect } from 'fabric/node';

function pointer(x, y, pointerId = 1) {
  return {
    type: 'pointerdown',
    clientX: x,
    clientY: y,
    button: 0,
    buttons: 1,
    isPrimary: true,
    pointerId,
    pointerType: 'pen',
    preventDefault() {},
    stopPropagation() {},
  };
}

function enableExactPencilProbe(canvas, objects) {
  canvas.perPixelTargetFind = true;
  canvas.setTargetFindTolerance(2);
  for (const object of objects) object.padding = 2;
}

const singleCanvas = new Canvas(null, {
  width: 500,
  height: 400,
  enablePointerEvents: true,
  enableRetinaScaling: false,
  preserveObjectStacking: true,
});
const diagonal = new Line([100, 100, 300, 300], {
  stroke: '#111827',
  strokeWidth: 3,
  fill: null,
  objectCaching: false,
});
singleCanvas.add(diagonal);
enableExactPencilProbe(singleCanvas, [diagonal]);
assert.equal(singleCanvas.findTarget(pointer(200, 200)).target, diagonal);
assert.equal(
  singleCanvas.findTarget(pointer(120, 280)).target,
  undefined,
  'Transparent space inside a diagonal line bounding box must not select it',
);
singleCanvas.perPixelTargetFind = false;
diagonal.padding = 9;
assert.equal(
  singleCanvas.findTarget(pointer(120, 280)).target,
  diagonal,
  'The former geometric Pencil mode must reproduce the bounding-box regression',
);
await singleCanvas.dispose();

const groupCanvas = new Canvas(null, {
  width: 500,
  height: 400,
  enablePointerEvents: true,
  enableRetinaScaling: false,
  preserveObjectStacking: true,
});
const firstLine = new Line([80, 80, 150, 80], {
  stroke: '#111827', strokeWidth: 3, fill: null, objectCaching: false,
});
const secondLine = new Line([220, 220, 290, 220], {
  stroke: '#111827', strokeWidth: 3, fill: null, objectCaching: false,
});
groupCanvas.add(firstLine, secondLine);
const activeSelection = new ActiveSelection([firstLine, secondLine], {
  canvas: groupCanvas,
  objectCaching: false,
});
groupCanvas.setActiveObject(activeSelection);
enableExactPencilProbe(groupCanvas, [activeSelection]);
assert.equal(groupCanvas.findTarget(pointer(115, 80)).target, activeSelection);
assert.equal(
  groupCanvas.findTarget(pointer(185, 150)).target,
  undefined,
  'Transparent space inside ActiveSelection bounds must not move the group',
);
await groupCanvas.dispose();

const denseCanvas = new Canvas(null, {
  width: 1400,
  height: 900,
  enablePointerEvents: true,
  enableRetinaScaling: false,
  preserveObjectStacking: true,
});
const denseTarget = new Line([40, 40, 180, 40], {
  stroke: '#2563eb', strokeWidth: 3, fill: null, objectCaching: false,
});
denseCanvas.add(denseTarget);
for (let index = 1; index < 3000; index += 1) {
  denseCanvas.add(new Rect({
    left: 500 + (index % 50) * 14,
    top: 20 + Math.floor(index / 50) * 14,
    width: 8,
    height: 8,
    fill: '#94a3b8',
    objectCaching: false,
  }));
}
enableExactPencilProbe(denseCanvas, [denseTarget]);
const startedAt = performance.now();
let exactHits = 0;
for (let contact = 0; contact < 30; contact += 1) {
  if (denseCanvas.findTarget(pointer(100, 40, contact + 1)).target === denseTarget) exactHits += 1;
}
const elapsedMs = performance.now() - startedAt;
assert.equal(exactHits, 30);
await denseCanvas.dispose();

console.log(JSON.stringify({
  precisePencilSelection: 'passed',
  objects: 3000,
  contacts: 30,
  elapsedMs: Number(elapsedMs.toFixed(1)),
  perContactMs: Number((elapsedMs / 30).toFixed(2)),
}));
