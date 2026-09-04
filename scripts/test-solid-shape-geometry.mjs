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

function pointFrom(sectionSource, name) {
  const match = sectionSource.match(new RegExp(`const ${name} = \\[(-?\\d+(?:\\.\\d+)?),\\s*(-?\\d+(?:\\.\\d+)?)\\];`));
  assert(match, `Missing ${name} point coordinates.`);
  return [Number(match[1]), Number(match[2])];
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
assert(sphere.includes('const solid = lineStyle(options);'), 'Sphere center point must inherit the current stroke color, width, and uniform-stroke behavior.');
assert(sphere.includes("const centerDot = new Path('M -0.000001 0 L 0.000001 0', solid);"), 'Sphere center point must use the shared solid stroke style.');

const octahedron = section(shapes, "case 'octahedron':", "case 'pyramid-frustum':");
for (const vertex of ['top', 'bottom', 'left', 'right', 'front', 'back']) {
  assert(octahedron.includes(`const ${vertex} =`), `Octahedron must define the ${vertex} vertex.`);
}
assert(octahedron.includes('hidden'), 'Octahedron must include hidden/dashed rear edges for 3D depth.');
assert((octahedron.match(/lineBetween\(/g) ?? []).length >= 12, 'Octahedron must render the 12 edges of a full octahedron.');
const [frontX, frontY] = pointFrom(octahedron, 'front');
const [backX, backY] = pointFrom(octahedron, 'back');
assert(frontX !== 0 && backX !== 0, 'Octahedron front/back vertices must be horizontally offset from the center axis.');
assert(Math.sign(frontX) === -Math.sign(backX), 'Octahedron front/back vertices must sit on opposite sides of the center axis.');
assert(frontX !== backX && frontY !== backY, 'Octahedron front/back projections must not overlap.');

const pyramidIcon = section(icons, "case 'pyramid':", "case 'cone':");
assert(pyramidIcon.includes('M10 35L28 43L54 35L36 27Z'), 'Pyramid icon must show a projected square base.');
assert(pyramidIcon.includes('M32 4L10 35M32 4L28 43M32 4L54 35'), 'Pyramid icon must connect the apex to three visible square-base corners.');
assert(pyramidIcon.includes('strokeDasharray'), 'Pyramid icon must show the rear apex edge as hidden.');

const sphereIcon = section(icons, "case 'sphere':", "case 'tetrahedron':");
assert(sphereIcon.includes('fill="currentColor"'), 'Sphere icon must include a filled center point.');
assert(sphereIcon.includes('cx="32" cy="24"'), 'Sphere icon center point must be at the geometric center.');

const octahedronIcon = section(icons, "case 'octahedron':", "case 'pyramid-frustum':");
assert(!octahedronIcon.includes('M32 3L8 24M32 3L32 32M32 3L56 24'), 'Octahedron icon must not keep the old center-aligned front projection.');
assert(!octahedronIcon.includes('M8 24L32 16L56 24M32 3L32 16M32 45L32 16'), 'Octahedron icon must not keep the old center-aligned rear projection.');
assert(octahedronIcon.includes('strokeDasharray'), 'Octahedron icon must include hidden rear edges.');

console.log('Solid shape geometry regression passed.');
