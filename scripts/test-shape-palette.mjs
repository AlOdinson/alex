import fs from 'node:fs';
import { SHAPE_CATEGORIES } from '../src/lib/shapes.js';

const visibleShapeIds = SHAPE_CATEGORIES.flatMap((category) => category.shapes.map(([id]) => id));

const expectedVisibleShapeIds = [
  'square',
  'triangle',
  'right-triangle',
  'parallelogram',
  'diamond',
  'pentagon',
  'hexagon',
  'octagon',
  'star',
  'circle',
  'semicircle',
  'wire-cube',
  'cylinder',
  'pyramid',
  'cone',
  'sphere',
  'tetrahedron',
  'octahedron',
];

const removedShapeIds = [
  'trapezoid',
  'isosceles-trapezoid',
  'rounded-rect',
  'quarter-circle',
  'cube',
  'parallelepiped',
  'triangular-prism',
  'pyramid-frustum',
  'cone-frustum',
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(
  JSON.stringify(visibleShapeIds) === JSON.stringify(expectedVisibleShapeIds),
  `Visible shape palette mismatch.\nExpected: ${expectedVisibleShapeIds.join(', ')}\nActual: ${visibleShapeIds.join(', ')}`,
);

const shapesSource = fs.readFileSync(new URL('../src/lib/shapes.js', import.meta.url), 'utf8');
for (const shapeId of removedShapeIds) {
  assert(!visibleShapeIds.includes(shapeId), `${shapeId} must not be visible in the shape palette`);
  assert(
    shapesSource.includes(`case '${shapeId}':`),
    `${shapeId} rendering support must remain for backward compatibility with existing boards`,
  );
}

console.log('Shape palette regression passed.');
