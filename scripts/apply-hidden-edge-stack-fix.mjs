import fs from 'node:fs';

const shapesPath = new URL('../src/lib/shapes.js', import.meta.url);
let shapes = fs.readFileSync(shapesPath, 'utf8');

const oldConstants = `const HIDDEN_EDGE_DASH = [5, 5];
const UPWARD_REAR_COMPOSITE_SOLID_IDS = new Set(['wire-cube', 'pyramid']);
`;
const newConstants = `const HIDDEN_EDGE_DASH = [5, 5];
const STACKED_REAR_SOLID_IDS = new Set(['wire-cube', 'pyramid']);
`;
if (!shapes.includes(oldConstants)) throw new Error('Missing hidden-edge constants anchor.');
shapes = shapes.replace(oldConstants, newConstants);

const oldApply = `function applyDirectionalHiddenEdges(object, shapeId, flippedUp) {
  const edgeIndexes = DIRECTIONAL_HIDDEN_CHILD_INDEXES[shapeId];
  if (!edgeIndexes || typeof object?.getObjects !== 'function') return;

  const hiddenIndexes = new Set(flippedUp ? edgeIndexes.up : edgeIndexes.down);
  const compositeRearBehind = flippedUp && UPWARD_REAR_COMPOSITE_SOLID_IDS.has(shapeId);
  for (const [index, child] of object.getObjects().entries()) {
    const shouldBeHidden = hiddenIndexes.has(index);
    const isHidden = Array.isArray(child?.strokeDashArray) && child.strokeDashArray.length > 0;
    const globalCompositeOperation = compositeRearBehind && shouldBeHidden ? 'destination-over' : 'source-over';
    const compositeChanged = child?.globalCompositeOperation !== globalCompositeOperation;
    if (shouldBeHidden === isHidden && !compositeChanged) continue;
    child.set({
      strokeDashArray: shouldBeHidden ? [...HIDDEN_EDGE_DASH] : null,
      globalCompositeOperation,
    });
  }
  object.dirty = true;
}
`;

const newApply = `function stackCurrentHiddenEdgesBehind(object) {
  const hiddenChildren = object.getObjects().filter((child) => (
    Array.isArray(child?.strokeDashArray) && child.strokeDashArray.length > 0
  ));
  for (const child of [...hiddenChildren].reverse()) {
    object.sendObjectToBack(child);
  }

  const fillOnlyChildren = object.getObjects().filter((child) => !child?.stroke && child?.fill);
  for (const child of [...fillOnlyChildren].reverse()) {
    object.sendObjectToBack(child);
  }
}

function applyDirectionalHiddenEdges(object, shapeId, flippedUp) {
  const edgeIndexes = DIRECTIONAL_HIDDEN_CHILD_INDEXES[shapeId];
  if (!edgeIndexes || typeof object?.getObjects !== 'function') return;

  if (STACKED_REAR_SOLID_IDS.has(shapeId)) {
    for (const child of object.getObjects()) {
      if (child?.globalCompositeOperation === 'destination-over') {
        child.set({ globalCompositeOperation: 'source-over' });
      }
    }
    stackCurrentHiddenEdgesBehind(object);
    object.dirty = true;
    return;
  }

  const hiddenIndexes = new Set(flippedUp ? edgeIndexes.up : edgeIndexes.down);
  for (const [index, child] of object.getObjects().entries()) {
    const shouldBeHidden = hiddenIndexes.has(index);
    const isHidden = Array.isArray(child?.strokeDashArray) && child.strokeDashArray.length > 0;
    if (shouldBeHidden === isHidden) continue;
    child.set({ strokeDashArray: shouldBeHidden ? [...HIDDEN_EDGE_DASH] : null });
  }
  object.dirty = true;
}
`;
if (!shapes.includes(oldApply)) throw new Error('Missing applyDirectionalHiddenEdges anchor.');
shapes = shapes.replace(oldApply, newApply);
fs.writeFileSync(shapesPath, shapes);

const testPath = new URL('./test-solid-drag-mirroring.mjs', import.meta.url);
let test = fs.readFileSync(testPath, 'utf8');

const oldHelper = `function assertUpwardHiddenEdgesCompositeBehind(object, shapeId) {
  const children = typeof object?.getObjects === 'function' ? object.getObjects() : [];
  const hiddenChildren = children.filter((child) => (
    Array.isArray(child?.strokeDashArray) && child.strokeDashArray.length
  ));
  assert(hiddenChildren.length > 0, \`${'${shapeId}'} must have hidden edges to composite behind.\`);
  for (const child of hiddenChildren) {
    assert(
      child.globalCompositeOperation === 'destination-over',
      \`${'${shapeId}'} upward hidden edges must render behind visible edges; got ${'${child.globalCompositeOperation}'}.\`,
    );
  }
}

`;
if (!test.includes(oldHelper)) throw new Error('Missing obsolete composite test helper.');
test = test.replace(oldHelper, '');
test = test.replace("const upwardRearCompositeSolids = new Set(['wire-cube', 'pyramid']);\n", '');
test = test.replace("    down: [9, 10, 11],\n    up: [9, 10, 11],", "    down: [0, 1, 2],\n    up: [0, 1, 2],");
test = test.replace("    down: [3, 4, 8],\n    up: [3, 4, 8],", "    down: [1, 2, 3],\n    up: [1, 2, 3],");
test = test.replace(/  if \(upwardRearCompositeSolids\.has\(shapeId\)\) \{\n    assertUpwardHiddenEdgesCompositeBehind\([^\n]+\);\n  \}\n/g, '');
fs.writeFileSync(testPath, test);
