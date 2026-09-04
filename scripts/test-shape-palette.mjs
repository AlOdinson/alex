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

const expectedCategories = [
  {
    id: '2d',
    label: '2D фигуры',
    shapeIds: [
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
    ],
  },
  {
    id: 'solids',
    label: '3D тела',
    shapeIds: [
      'wire-cube',
      'cylinder',
      'pyramid',
      'cone',
      'sphere',
      'tetrahedron',
      'octahedron',
    ],
  },
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

const actualCategories = SHAPE_CATEGORIES.map((category) => ({
  id: category.id,
  label: category.label,
  shapeIds: category.shapes.map(([id]) => id),
}));

assert(
  JSON.stringify(actualCategories) === JSON.stringify(expectedCategories),
  `Shape categories mismatch.\nExpected: ${JSON.stringify(expectedCategories)}\nActual: ${JSON.stringify(actualCategories)}`,
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
