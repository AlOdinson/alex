import fs from 'node:fs';

const shapes = fs.readFileSync(new URL('../src/lib/shapes.js', import.meta.url), 'utf8');
const icons = fs.readFileSync(new URL('../src/components/ShapeIcon.jsx', import.meta.url), 'utf8');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function section(source, start, end) {
  const from = source.indexOf(start);
  assert(from >= 0, `Missing section start: ${start}`);
  const to = source.indexOf(end, from + start.length);
  assert(to >= 0, `Missing section end after ${start}: ${end}`);
  return source.slice(from, to);
}

const cube = section(shapes, 'function cubeChildren', '\n}\n\nexport function createShape');
assert(cube.includes('const frontTopLeft ='), 'Wireframe cube must define shared front/back vertices.');
assert(cube.includes('const backBottomLeft ='), 'Wireframe cube must define all 8 shared vertices.');
assert(!cube.includes('new Rect('), 'Wireframe cube edges must be lines between shared vertices, not a stroked Rect plus separate lines.');

const wireCubeIcon = section(icons, "case 'wire-cube':", "case 'cylinder':");
assert(wireCubeIcon.includes('M10 16L43 16L43 42L10 42Z'), 'Wireframe cube icon must use exact shared front-face corners.');
assert(wireCubeIcon.includes('M10 42L20 32M20 32L20 6M20 32L53 32'), 'Wireframe cube icon hidden edges must meet the same corners exactly.');

const sphere = section(shapes, "case 'sphere':", "case 'tetrahedron':");
assert(sphere.includes('centerDot'), 'Sphere must include a permanent center point.');
assert(sphere.includes('fill: options.stroke'), 'Sphere center point must use the current stroke color.');

const octahedron = section(shapes, "case 'octahedron':", "case 'pyramid-frustum':");
for (const vertex of ['top', 'bottom', 'left', 'right', 'front', 'back']) {
  assert(octahedron.includes(`const ${vertex} =`), `Octahedron must define the ${vertex} vertex.`);
}
assert(octahedron.includes('hidden'), 'Octahedron must include hidden/dashed rear edges for 3D depth.');
assert((octahedron.match(/lineBetween\(/g) ?? []).length >= 12, 'Octahedron must render the 12 edges of a full octahedron.');

const pyramidIcon = section(icons, "case 'pyramid':", "case 'cone':");
assert(pyramidIcon.includes('M10 35L28 43L54 35L36 27Z'), 'Pyramid icon must show a projected square base.');
assert(pyramidIcon.includes('M32 4L10 35M32 4L28 43M32 4L54 35'), 'Pyramid icon must connect the apex to three visible square-base corners.');
assert(pyramidIcon.includes('strokeDasharray'), 'Pyramid icon must show the rear apex edge as hidden.');

const sphereIcon = section(icons, "case 'sphere':", "case 'tetrahedron':");
assert(sphereIcon.includes('fill="currentColor"'), 'Sphere icon must include a filled center point.');
assert(sphereIcon.includes('cx="32" cy="24"'), 'Sphere icon center point must be at the geometric center.');

const octahedronIcon = section(icons, "case 'octahedron':", "case 'pyramid-frustum':");
assert(octahedronIcon.includes('M32 3L8 24M32 3L32 32M32 3L56 24'), 'Octahedron icon must show the upper square pyramid.');
assert(octahedronIcon.includes('M32 45L8 24M32 45L32 32M32 45L56 24'), 'Octahedron icon must show the lower square pyramid.');
assert(octahedronIcon.includes('M8 24L32 32L56 24'), 'Octahedron icon must show the visible half of the equator square.');
assert(octahedronIcon.includes('M8 24L32 16L56 24M32 3L32 16M32 45L32 16'), 'Octahedron icon must show rear equator/apex edges as hidden.');
assert(octahedronIcon.includes('strokeDasharray'), 'Octahedron icon must include hidden rear edges.');

console.log('Solid shape geometry regression passed.');
