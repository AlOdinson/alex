import fs from 'node:fs';

const path = new URL('../src/lib/shapes.js', import.meta.url);
let source = fs.readFileSync(path, 'utf8');

const constantAnchor = 'const HIDDEN_EDGE_DASH = [5, 5];\n';
const constantReplacement = "const HIDDEN_EDGE_DASH = [5, 5];\nconst UPWARD_REAR_COMPOSITE_SOLID_IDS = new Set(['wire-cube', 'pyramid']);\n";
if (!source.includes(constantAnchor)) throw new Error('missing hidden-edge constant anchor');
source = source.replace(constantAnchor, constantReplacement);

const oldBlock = `  const hiddenIndexes = new Set(flippedUp ? edgeIndexes.up : edgeIndexes.down);
  for (const [index, child] of object.getObjects().entries()) {
    const shouldBeHidden = hiddenIndexes.has(index);
    const isHidden = Array.isArray(child?.strokeDashArray) && child.strokeDashArray.length > 0;
    if (shouldBeHidden === isHidden) continue;
    child.set({ strokeDashArray: shouldBeHidden ? [...HIDDEN_EDGE_DASH] : null });
  }
`;
const newBlock = `  const hiddenIndexes = new Set(flippedUp ? edgeIndexes.up : edgeIndexes.down);
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
`;
if (!source.includes(oldBlock)) throw new Error('missing applyDirectionalHiddenEdges anchor');
source = source.replace(oldBlock, newBlock);
fs.writeFileSync(path, source);
