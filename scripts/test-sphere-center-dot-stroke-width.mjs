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
  sphere.includes("const centerDot = new Path('M -0.000001 0 L 0.000001 0', solid);"),
  'Sphere center point must be a stroke-uniform round mark, not scalable filled geometry.',
);
assert(
  !sphere.includes('centerDotRadius') && !sphere.includes('radius: 3.5'),
  'Sphere center point must not use a scalable Circle radius.',
);
assert(
  sphere.includes("new Path('M -58 0 A 58 20 0 0 0 58 0', solid)"),
  'Sphere front equator must touch the outer sphere at both horizontal diameter endpoints.',
);
assert(
  sphere.includes("new Path('M -58 0 A 58 20 0 0 1 58 0', hidden)"),
  'Sphere rear equator must share the same horizontal diameter endpoints.',
);
assert(
  !sphere.includes('M -56 5 A 56 20'),
  'Sphere equator must not keep the old inset geometry with a visible gap.',
);

console.log('Sphere center-dot and equator regression passed.');
