import fs from 'node:fs';

const shapesModule = await import('../src/lib/shapes.js');
const shapesSource = fs.readFileSync(new URL('../src/lib/shapes.js', import.meta.url), 'utf8');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function dashedChildIndexes(object) {
  const children = typeof object?.getObjects === 'function' ? object.getObjects() : [];
  return children.flatMap((child, index) => (
    Array.isArray(child?.strokeDashArray) && child.strokeDashArray.length ? [index] : []
  ));
}

function assertDashedEdges(object, expectedIndexes, message) {
  const actualIndexes = dashedChildIndexes(object);
  assert(
    JSON.stringify(actualIndexes) === JSON.stringify(expectedIndexes),
    `${message} Expected dashed child indexes ${expectedIndexes.join(', ')}, got ${actualIndexes.join(', ')}.`,
  );
}

const {
  createShape,
  HORIZONTALLY_MIRRORED_SOLID_IDS,
  VERTICALLY_MIRRORED_SOLID_IDS,
  SHAPE_CATEGORIES,
  solidDragFlipX,
  solidDragFlipY,
} = shapesModule;

assert(typeof solidDragFlipX === 'function', 'shapes.js must export solidDragFlipX().');
assert(typeof solidDragFlipY === 'function', 'shapes.js must export solidDragFlipY().');
assert(HORIZONTALLY_MIRRORED_SOLID_IDS instanceof Set, 'shapes.js must export HORIZONTALLY_MIRRORED_SOLID_IDS.');
assert(VERTICALLY_MIRRORED_SOLID_IDS instanceof Set, 'shapes.js must export VERTICALLY_MIRRORED_SOLID_IDS.');

const solidsCategory = SHAPE_CATEGORIES.find((category) => category.id === 'solids');
const solids = solidsCategory?.shapes?.map(([id]) => id) ?? [];
const wireCubeLabel = solidsCategory?.shapes?.find(([id]) => id === 'wire-cube')?.[1];
assert(wireCubeLabel === 'Кубоид', 'wire-cube must be displayed as «Кубоид».');

const excluded = new Set(['cylinder', 'cone', 'sphere']);
const expectedMirrored = solids.filter((id) => !excluded.has(id));
const rightwardFlipSolids = new Set(['wire-cube', 'pyramid']);
const directionalDashExpectations = {
  'wire-cube': {
    down: [0, 1, 2],
    up: [0, 1, 2],
  },
  pyramid: {
    down: [1, 2, 3],
    up: [1, 2, 3],
  },
  tetrahedron: {
    down: [1, 2, 3],
    up: [1, 2, 3],
  },
  octahedron: {
    down: [8, 9, 10, 11],
    up: [1, 4, 6, 7],
  },
};

assert(
  JSON.stringify([...HORIZONTALLY_MIRRORED_SOLID_IDS].sort()) === JSON.stringify([...expectedMirrored].sort()),
  `Every current solid except cylinder/cone/sphere must mirror horizontally during creation. Expected ${expectedMirrored.join(', ')}`,
);
assert(
  JSON.stringify([...VERTICALLY_MIRRORED_SOLID_IDS].sort()) === JSON.stringify([...expectedMirrored].sort()),
  `Every directional solid must mirror vertically during creation. Expected ${expectedMirrored.join(', ')}`,
);

for (const shapeId of expectedMirrored) {
  const rightFlip = rightwardFlipSolids.has(shapeId);
  const leftFlip = !rightFlip;
  const dashExpectation = directionalDashExpectations[shapeId];
  assert(dashExpectation, `${shapeId} must define directional hidden-edge expectations.`);

  assert(solidDragFlipX(shapeId, 40) === rightFlip, `${shapeId} has the wrong orientation for a rightward drag.`);
  assert(solidDragFlipX(shapeId, -40) === leftFlip, `${shapeId} has the wrong orientation for a leftward drag.`);
  assert(solidDragFlipY(shapeId, 40) === false, `${shapeId} must keep its current Y orientation for a downward drag.`);
  assert(solidDragFlipY(shapeId, -40) === true, `${shapeId} must mirror on Y for an upward drag.`);

  const crossingObject = createShape(shapeId, { stroke: '#111827', strokeWidth: 3 });
  crossingObject.set({ left: 100, top: 100, scaleX: 0.01, scaleY: 0.01, selectable: false });

  crossingObject.set({ left: 80, top: 120, scaleX: 0.5, scaleY: 0.5 });
  assert(
    crossingObject.scaleX > 0 && crossingObject.scaleY > 0
      && crossingObject.flipX === leftFlip && crossingObject.flipY === false,
    `${shapeId} live preview has the wrong down-left orientation.`,
  );
  assertDashedEdges(
    crossingObject,
    dashExpectation.down,
    `${shapeId} downward preview must keep the intended rear/internal edges hidden.`,
  );

  crossingObject.set({ left: 120, top: 120, scaleX: 0.5, scaleY: 0.5 });
  assert(
    crossingObject.scaleX > 0 && crossingObject.scaleY > 0
      && crossingObject.flipX === rightFlip && crossingObject.flipY === false,
    `${shapeId} live preview has the wrong down-right orientation.`,
  );
  assertDashedEdges(
    crossingObject,
    dashExpectation.down,
    `${shapeId} downward preview must keep the same rear/internal edges after crossing horizontally.`,
  );

  crossingObject.set({ left: 80, top: 80, scaleX: 0.5, scaleY: 0.5 });
  assert(
    crossingObject.scaleX > 0 && crossingObject.scaleY > 0
      && crossingObject.flipX === leftFlip && crossingObject.flipY === true,
    `${shapeId} live preview has the wrong up-left orientation.`,
  );
  assertDashedEdges(
    crossingObject,
    dashExpectation.up,
    `${shapeId} upward preview must keep only the intended rear/internal edges dashed.`,
  );

  crossingObject.set({ left: 120, top: 80, scaleX: 0.5, scaleY: 0.5 });
  assert(
    crossingObject.scaleX > 0 && crossingObject.scaleY > 0
      && crossingObject.flipX === rightFlip && crossingObject.flipY === true,
    `${shapeId} live preview has the wrong up-right orientation.`,
  );
  assertDashedEdges(
    crossingObject,
    dashExpectation.up,
    `${shapeId} upward preview must keep the intended rear/internal edges after crossing horizontally.`,
  );

  const finalizedUpRightObject = createShape(shapeId, { stroke: '#111827', strokeWidth: 3 });
  finalizedUpRightObject.set({ left: 100, top: 100, scaleX: 0.01, scaleY: 0.01, selectable: false });
  finalizedUpRightObject.set({ left: 120, top: 80, scaleX: 0.5, scaleY: 0.5 });
  finalizedUpRightObject.set({ selectable: true });
  assert(
    finalizedUpRightObject.flipX === rightFlip && finalizedUpRightObject.flipY === true,
    `${shapeId} must preserve its drag-selected quadrant when creation is finalized.`,
  );
  assertDashedEdges(
    finalizedUpRightObject,
    dashExpectation.up,
    `${shapeId} must preserve the upward hidden-edge set when creation is finalized.`,
  );
  finalizedUpRightObject.set({ left: 80, top: 120, scaleX: 0.5, scaleY: 0.5 });
  assert(
    finalizedUpRightObject.flipX === rightFlip && finalizedUpRightObject.flipY === true,
    `${shapeId} must stop auto-mirroring after creation is finalized.`,
  );
  assertDashedEdges(
    finalizedUpRightObject,
    dashExpectation.up,
    `${shapeId} must stop changing hidden edges after creation is finalized.`,
  );
}

for (const shapeId of excluded) {
  assert(solidDragFlipX(shapeId, -40) === false, `${shapeId} must not mirror for a leftward drag.`);
  assert(solidDragFlipY(shapeId, -40) === false, `${shapeId} must not mirror for an upward drag.`);

  const object = createShape(shapeId, { stroke: '#111827', strokeWidth: 3 });
  object.set({ left: 100, top: 100, scaleX: 0.01, scaleY: 0.01, selectable: false });
  object.set({ left: 80, top: 80, scaleX: 0.5, scaleY: 0.5 });
  assert(
    object.scaleX > 0 && object.scaleY > 0 && object.flipX === false && object.flipY === false,
    `${shapeId} live preview must stay unmirrored for an up-left drag.`,
  );
}

assert(
  shapesSource.includes('enableDirectionalDragMirror(object, shapeId)'),
  'createShape() must attach the drag-direction mirror behavior to eligible solids.',
);
assert(
  shapesSource.includes('return enableDirectionalDragMirror(object, shapeId);'),
  'createShape() must return the drag-aware object so the preview receives both mirrored orientations.',
);

console.log('Solid four-direction mirroring regression passed.');