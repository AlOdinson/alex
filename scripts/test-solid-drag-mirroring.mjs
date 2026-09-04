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
  solidDragScaleX,
} = shapesModule;

assert(typeof solidDragScaleX === 'function', 'shapes.js must export solidDragScaleX().');
assert(HORIZONTALLY_MIRRORED_SOLID_IDS instanceof Set, 'shapes.js must export HORIZONTALLY_MIRRORED_SOLID_IDS.');

const solids = SHAPE_CATEGORIES.find((category) => category.id === 'solids')?.shapes?.map(([id]) => id) ?? [];
const excluded = new Set(['cylinder', 'cone', 'sphere']);
const expectedMirrored = solids.filter((id) => !excluded.has(id));

assert(
  JSON.stringify([...HORIZONTALLY_MIRRORED_SOLID_IDS].sort()) === JSON.stringify([...expectedMirrored].sort()),
  `Every current solid except cylinder/cone/sphere must mirror horizontally during creation. Expected ${expectedMirrored.join(', ')}`,
);

for (const shapeId of expectedMirrored) {
  assert(solidDragScaleX(shapeId, 0.75, 40) === 0.75, `${shapeId} must face right for a rightward drag.`);
  assert(solidDragScaleX(shapeId, 0.75, -40) === -0.75, `${shapeId} must face left for a leftward drag.`);
  assert(solidDragScaleX(shapeId, -0.75, 40) === 0.75, `${shapeId} must normalize a rightward drag to positive scaleX.`);

  const object = createShape(shapeId, { stroke: '#111827', strokeWidth: 3 });
  object.set({ left: 100, top: 100, scaleX: 0.01, scaleY: 0.01, selectable: false });
  object.set({ left: 80, top: 110, scaleX: 0.5, scaleY: 0.5 });
  assert(object.scaleX < 0, `${shapeId} live preview must mirror when the pointer crosses left of the creation point.`);
  object.set({ left: 120, top: 110, scaleX: 0.5, scaleY: 0.5 });
  assert(object.scaleX > 0, `${shapeId} live preview must face right again when the pointer crosses right of the creation point.`);
  object.set({ selectable: true });
  object.set({ left: 80, scaleX: 0.5 });
  assert(object.scaleX > 0, `${shapeId} must stop auto-mirroring after creation is finalized.`);
}

for (const shapeId of excluded) {
  assert(solidDragScaleX(shapeId, 0.75, -40) === 0.75, `${shapeId} must not mirror for a leftward drag.`);
  assert(solidDragScaleX(shapeId, -0.75, -40) === 0.75, `${shapeId} must remain unmirrored even if a negative scale is supplied.`);

  const object = createShape(shapeId, { stroke: '#111827', strokeWidth: 3 });
  object.set({ left: 100, top: 100, scaleX: 0.01, scaleY: 0.01, selectable: false });
  object.set({ left: 80, top: 110, scaleX: 0.5, scaleY: 0.5 });
  assert(object.scaleX > 0, `${shapeId} live preview must stay unmirrored for leftward drag.`);
}

assert(
  shapesSource.includes('enableHorizontalDragMirror(object, shapeId)'),
  'createShape() must attach the drag-direction mirror behavior to eligible solids.',
);
assert(
  shapesSource.includes('return enableHorizontalDragMirror(object, shapeId);'),
  'createShape() must return the drag-aware object so the preview receives the mirrored scaleX.',
);

console.log('Solid drag mirroring regression passed.');
