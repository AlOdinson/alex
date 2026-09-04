import fs from 'node:fs';

const shapesModule = await import('../src/lib/shapes.js');
const shapesSource = fs.readFileSync(new URL('../src/lib/shapes.js', import.meta.url), 'utf8');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const {
  createShape,
  HORIZONTALLY_MIRRORED_SOLID_IDS,
  SHAPE_CATEGORIES,
  solidDragFlipX,
} = shapesModule;

assert(typeof solidDragFlipX === 'function', 'shapes.js must export solidDragFlipX().');
assert(HORIZONTALLY_MIRRORED_SOLID_IDS instanceof Set, 'shapes.js must export HORIZONTALLY_MIRRORED_SOLID_IDS.');

const solids = SHAPE_CATEGORIES.find((category) => category.id === 'solids')?.shapes?.map(([id]) => id) ?? [];
const excluded = new Set(['cylinder', 'cone', 'sphere']);
const expectedMirrored = solids.filter((id) => !excluded.has(id));
const rightwardFlipSolids = new Set(['wire-cube', 'pyramid']);

assert(
  JSON.stringify([...HORIZONTALLY_MIRRORED_SOLID_IDS].sort()) === JSON.stringify([...expectedMirrored].sort()),
  `Every current solid except cylinder/cone/sphere must mirror horizontally during creation. Expected ${expectedMirrored.join(', ')}`,
);

for (const shapeId of expectedMirrored) {
  const rightFlip = rightwardFlipSolids.has(shapeId);
  const leftFlip = !rightFlip;

  assert(solidDragFlipX(shapeId, 40) === rightFlip, `${shapeId} has the wrong orientation for a rightward drag.`);
  assert(solidDragFlipX(shapeId, -40) === leftFlip, `${shapeId} has the wrong orientation for a leftward drag.`);

  const crossingObject = createShape(shapeId, { stroke: '#111827', strokeWidth: 3 });
  crossingObject.set({ left: 100, top: 100, scaleX: 0.01, scaleY: 0.01, selectable: false });
  crossingObject.set({ left: 80, top: 110, scaleX: 0.5, scaleY: 0.5 });
  assert(
    crossingObject.scaleX > 0 && crossingObject.flipX === leftFlip,
    `${shapeId} live preview has the wrong orientation for a leftward drag.`,
  );
  crossingObject.set({ left: 120, top: 110, scaleX: 0.5, scaleY: 0.5 });
  assert(
    crossingObject.scaleX > 0 && crossingObject.flipX === rightFlip,
    `${shapeId} live preview has the wrong orientation after crossing to the right of the creation point.`,
  );

  const finalizedLeftObject = createShape(shapeId, { stroke: '#111827', strokeWidth: 3 });
  finalizedLeftObject.set({ left: 100, top: 100, scaleX: 0.01, scaleY: 0.01, selectable: false });
  finalizedLeftObject.set({ left: 80, top: 110, scaleX: 0.5, scaleY: 0.5 });
  finalizedLeftObject.set({ selectable: true });
  assert(
    finalizedLeftObject.flipX === leftFlip,
    `${shapeId} must preserve its drag-selected orientation when creation is finalized.`,
  );
  finalizedLeftObject.set({ left: 120, scaleX: 0.5 });
  assert(
    finalizedLeftObject.flipX === leftFlip,
    `${shapeId} must stop auto-mirroring after creation is finalized.`,
  );
}

for (const shapeId of excluded) {
  assert(solidDragFlipX(shapeId, -40) === false, `${shapeId} must not mirror for a leftward drag.`);

  const object = createShape(shapeId, { stroke: '#111827', strokeWidth: 3 });
  object.set({ left: 100, top: 100, scaleX: 0.01, scaleY: 0.01, selectable: false });
  object.set({ left: 80, top: 110, scaleX: 0.5, scaleY: 0.5 });
  assert(object.scaleX > 0 && object.flipX === false, `${shapeId} live preview must stay unmirrored for leftward drag.`);
}

assert(
  shapesSource.includes('enableHorizontalDragMirror(object, shapeId)'),
  'createShape() must attach the drag-direction mirror behavior to eligible solids.',
);
assert(
  shapesSource.includes('return enableHorizontalDragMirror(object, shapeId);'),
  'createShape() must return the drag-aware object so the preview receives the mirrored orientation.',
);

console.log('Solid drag mirroring regression passed.');
