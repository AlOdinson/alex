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

const cases = {
  'wire-cube': [9, 10, 11],
  pyramid: [3, 4, 8],
};

for (const [shapeId, expectedHiddenOriginalIndexes] of Object.entries(cases)) {
  const object = createShape(shapeId, { stroke: '#111827', strokeWidth: 3 });
  const originalChildren = [...object.getObjects()];

  object.set({ left: 100, top: 100, scaleX: 0.01, scaleY: 0.01, selectable: false });
  object.set({ left: 120, top: 80, scaleX: 0.5, scaleY: 0.5 });

  assert(object.flipY === true, `${shapeId}: test setup must create the shape upward.`);
  assertOriginalHiddenEdges(object, originalChildren, expectedHiddenOriginalIndexes, shapeId, 'upward preview');
  assertHiddenStackedBehind(object, shapeId, 'upward preview');

  object.set({ selectable: true });

  assertOriginalHiddenEdges(object, originalChildren, expectedHiddenOriginalIndexes, shapeId, 'finalized upward shape');
  assertHiddenStackedBehind(object, shapeId, 'finalized upward shape');
}

console.log('Upward hidden-edge stack regression passed.');
