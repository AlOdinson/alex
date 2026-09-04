import fs from 'node:fs';

const source = fs.readFileSync(new URL('../src/lib/shapes.js', import.meta.url), 'utf8');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const start = source.indexOf("case 'sphere':");
const end = source.indexOf("case 'tetrahedron':", start);
assert(start >= 0 && end > start, 'Sphere shape section must exist.');
const sphere = source.slice(start, end);

assert(
  sphere.includes('const centerDotRadius = Number(options.strokeWidth) / 2;'),
  'Sphere center dot diameter must equal the sphere stroke width.',
);
assert(
  sphere.includes('radius: centerDotRadius,'),
  'Sphere center dot must use the stroke-width-derived radius.',
);
assert(
  !sphere.includes('radius: 3.5'),
  'Sphere center dot must not keep a fixed radius.',
);

console.log('Sphere center dot stroke-width regression passed.');
