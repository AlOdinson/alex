const { createShape } = await import('../src/lib/shapes.js');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function isDashed(child) {
  return Array.isArray(child?.strokeDashArray) && child.strokeDashArray.length > 0;
}

function originalHiddenIndexes(object, originalChildren) {
  const hidden = new Set(object.getObjects().filter(isDashed));
  return originalChildren.flatMap((child, index) => hidden.has(child) ? [index] : []);
}

function assertOriginalHiddenEdges(object, originalChildren, expectedOriginalIndexes, shapeId, phase) {
  const actualOriginalIndexes = originalHiddenIndexes(object, originalChildren);
  assert(
    JSON.stringify(actualOriginalIndexes) === JSON.stringify(expectedOriginalIndexes),
    `${shapeId} ${phase}: expected original hidden edges ${expectedOriginalIndexes.join(', ')}, got ${actualOriginalIndexes.join(', ')}.`,
  );
}

function assertHiddenStackedBehind(object, shapeId, phase) {
  const children = object.getObjects();
  const hiddenPositions = children.flatMap((child, index) => isDashed(child) ? [index] : []);
  const visibleStrokePositions = children.flatMap((child, index) => (
    !isDashed(child) && child?.stroke ? [index] : []
  ));

  assert(hiddenPositions.length > 0, `${shapeId} ${phase}: expected hidden edges.`);
  assert(visibleStrokePositions.length > 0, `${shapeId} ${phase}: expected visible edges.`);

  for (const child of children) {
    assert(
      child?.globalCompositeOperation !== 'destination-over',
      `${shapeId} ${phase}: destination-over must not be used because hidden edges disappear after finalization.`,
    );
  }

  assert(
    Math.max(...hiddenPositions) < Math.min(...visibleStrokePositions),
    `${shapeId} ${phase}: hidden edges must be earlier in the Group stack than every visible edge. Hidden positions ${hiddenPositions.join(', ')}, visible positions ${visibleStrokePositions.join(', ')}.`,
  );
}

function createDirectionalShape(shapeId, left, top) {
  const object = createShape(shapeId, { stroke: '#111827', strokeWidth: 3 });
  const originalChildren = [...object.getObjects()];
  object.set({ left: 100, top: 100, scaleX: 0.01, scaleY: 0.01, selectable: false });
  object.set({ left, top, scaleX: 0.5, scaleY: 0.5 });
  return { object, originalChildren };
}

function patternSignature(object, originalChildren) {
  return JSON.stringify({
    flipX: Boolean(object.flipX),
    flipY: Boolean(object.flipY),
    hidden: originalHiddenIndexes(object, originalChildren),
  });
}

const cuboidDirections = [
  { name: 'down-left', left: 80, top: 120, flipX: false, flipY: false, hidden: [9, 10, 11] },
  { name: 'down-right', left: 120, top: 120, flipX: true, flipY: false, hidden: [9, 10, 11] },
  // The two lower cuboids are the source of truth. Up-left must literally repeat
  // down-right, while up-right must literally repeat down-left.
  { name: 'up-left', left: 80, top: 80, flipX: true, flipY: false, hidden: [9, 10, 11] },
  { name: 'up-right', left: 120, top: 80, flipX: false, flipY: false, hidden: [9, 10, 11] },
];

const cuboidPatterns = new Map();
for (const direction of cuboidDirections) {
  const { object, originalChildren } = createDirectionalShape('wire-cube', direction.left, direction.top);
  assert(
    object.flipX === direction.flipX && object.flipY === direction.flipY,
    `wire-cube ${direction.name}: wrong drag orientation; expected flipX=${direction.flipX}, flipY=${direction.flipY}, got flipX=${object.flipX}, flipY=${object.flipY}.`,
  );
  assertOriginalHiddenEdges(object, originalChildren, direction.hidden, 'wire-cube', `${direction.name} preview`);
  assertHiddenStackedBehind(object, 'wire-cube', `${direction.name} preview`);
  cuboidPatterns.set(direction.name, patternSignature(object, originalChildren));

  object.set({ selectable: true });
  assertOriginalHiddenEdges(object, originalChildren, direction.hidden, 'wire-cube', `${direction.name} finalized`);
  assertHiddenStackedBehind(object, 'wire-cube', `${direction.name} finalized`);
  assert(
    patternSignature(object, originalChildren) === cuboidPatterns.get(direction.name),
    `wire-cube ${direction.name}: finalization must preserve the preview pattern.`,
  );
}

assert(
  cuboidPatterns.get('up-left') === cuboidPatterns.get('down-right'),
  'wire-cube up-left must be one-for-one identical to the down-right pattern.',
);
assert(
  cuboidPatterns.get('up-right') === cuboidPatterns.get('down-left'),
  'wire-cube up-right must be one-for-one identical to the down-left pattern.',
);

// Pyramid behavior is intentionally outside this cuboid-only correction.
for (const direction of [
  { name: 'up-left', left: 80, top: 80 },
  { name: 'up-right', left: 120, top: 80 },
]) {
  const { object, originalChildren } = createDirectionalShape('pyramid', direction.left, direction.top);
  assert(object.flipY === true, `pyramid ${direction.name}: test setup must create the shape upward.`);
  assertOriginalHiddenEdges(object, originalChildren, [3, 4, 8], 'pyramid', `${direction.name} preview`);
  assertHiddenStackedBehind(object, 'pyramid', `${direction.name} preview`);
  object.set({ selectable: true });
  assertOriginalHiddenEdges(object, originalChildren, [3, 4, 8], 'pyramid', `${direction.name} finalized`);
  assertHiddenStackedBehind(object, 'pyramid', `${direction.name} finalized`);
}

console.log('Directional hidden-edge stack regression passed.');
