function containsPdf(object) {
  return object.mediaKind === 'pdf' || (object.getObjects?.() ?? []).some(containsPdf);
}

// Scene-space bounding rectangles already include each object's rotation/group.
export function lockLabelAnchor(objects) {
  const bounds = objects.map(object => object.getBoundingRect());
  const left = Math.min(...bounds.map(rect => rect.left));
  const top = Math.min(...bounds.map(rect => rect.top));
  const right = Math.max(...bounds.map(rect => rect.left + rect.width));
  const bottom = Math.max(...bounds.map(rect => rect.top + rect.height));
  return { x: (left + right) / 2, y: objects.some(containsPdf) ? top : (top + bottom) / 2 };
}
