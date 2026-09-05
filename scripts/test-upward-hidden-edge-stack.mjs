const { createShape } = await import('../src/lib/shapes.js');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function isDashed(child) {
  return Array.isArray(child?.strokeDashArray) && child.strokeDashArray.length > 0;
}

function assertOriginalHiddenEdges(object, originalChildren, expectedOriginalIndexes, shapeId, phase) {
  const hidden = new Set(object.getObjects().filter(isDashed));
  const actualOriginalIndexes = originalChildren.flatMap((child, index) => hidden.has(child) ? [index] : []);
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

const cuboidDirections = [
  { name: 'down-left', left: 80, top: 120, flipX: false, flipY: false, hidden: [9, 10, 11] },
  { name: 'down-right', left: 120, top: 120, flipX: true, flipY: false, hidden: [9, 10, 11] },
  // User-required pairing: upper-left must use the hidden-edge pattern seen in lower-right,
  // and upper-right must use the hidden-edge pattern seen in lower-left.
  // With vertical mirroring this is the opposite source rear vertex: backTopRight => edges 5,7,8.
  { name: 'up-left', left: 80, top: 80, flipX: false, flipY: true, hidden: [5, 7, 8] },
  { name: 'up-right', left: 120, top: 80, flipX: true, flipY: true, hidden: [5, 7, 8] },
];

for (const direction of cuboidDirections) {
  const { object, originalChildren } = createDirectionalShape('wire-cube', direction.left, direction.top);
  assert(
    object.flipX === direction.flipX && object.flipY === direction.flipY,
    `wire-cube ${direction.name}: wrong drag orientation.`,
  );
  assertOriginalHiddenEdges(object, originalChildren, direction.hidden, 'wire-cube', `${direction.name} preview`);
  assertHiddenStackedBehind(object, 'wire-cube', `${direction.name} preview`);

  object.set({ selectable: true });
  assertOriginalHiddenEdges(object, originalChildren, direction.hidden, 'wire-cube', `${direction.name} finalized`);
  assertHiddenStackedBehind(object, 'wire-cube', `${direction.name} finalized`);
}

// Keep the existing pyramid regression unchanged in this cuboid-only fix.
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
