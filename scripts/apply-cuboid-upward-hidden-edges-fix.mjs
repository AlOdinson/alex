import fs from 'node:fs';

const path = new URL('../src/lib/shapes.js', import.meta.url);
let source = fs.readFileSync(path, 'utf8');

source = source.replace(
  "  'wire-cube': {\n    down: [9, 10, 11],\n    up: [9, 10, 11],\n  },",
  "  'wire-cube': {\n    down: [9, 10, 11],\n    up: [5, 7, 8],\n  },",
);

const oldApply = `function applyDirectionalHiddenEdges(object, shapeId, flippedUp) {
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

const newApply = `function applyDirectionalHiddenEdges(object, shapeId, flippedUp, directionalChildren = null) {
  const edgeIndexes = DIRECTIONAL_HIDDEN_CHILD_INDEXES[shapeId];
  if (!edgeIndexes || typeof object?.getObjects !== 'function') return;

  const children = directionalChildren ?? object.getObjects();
  const hiddenIndexes = new Set(flippedUp ? edgeIndexes.up : edgeIndexes.down);
  for (const [index, child] of children.entries()) {
    const shouldBeHidden = hiddenIndexes.has(index);
    const isHidden = Array.isArray(child?.strokeDashArray) && child.strokeDashArray.length > 0;
    if (shouldBeHidden !== isHidden) {
      child.set({ strokeDashArray: shouldBeHidden ? [...HIDDEN_EDGE_DASH] : null });
    }
  }

  if (STACKED_REAR_SOLID_IDS.has(shapeId)) {
    for (const child of object.getObjects()) {
      if (child?.globalCompositeOperation === 'destination-over') {
        child.set({ globalCompositeOperation: 'source-over' });
      }
    }
    stackCurrentHiddenEdgesBehind(object);
  }

  object.dirty = true;
}
`;

if (!source.includes(oldApply)) throw new Error('Missing applyDirectionalHiddenEdges block.');
source = source.replace(oldApply, newApply);

const oldEnable = `  const originalSet = object.set;
  let creationAnchorLeft = null;
`;
const newEnable = `  const originalSet = object.set;
  const directionalChildren = DIRECTIONAL_HIDDEN_CHILD_INDEXES[shapeId]
    && typeof object.getObjects === 'function'
    ? [...object.getObjects()]
    : null;
  let creationAnchorLeft = null;
`;
if (!source.includes(oldEnable)) throw new Error('Missing enableDirectionalDragMirror anchor.');
source = source.replace(oldEnable, newEnable);

const oldCall = `          applyDirectionalHiddenEdges(this, shapeId, nextFlipY);`;
const newCall = `          applyDirectionalHiddenEdges(this, shapeId, nextFlipY, directionalChildren);`;
if (!source.includes(oldCall)) throw new Error('Missing directional hidden-edge call.');
source = source.replace(oldCall, newCall);

fs.writeFileSync(path, source);
