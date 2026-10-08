// Keep the editing badge *above* the selection rectangle for every object
// type: ink, shape, image, PDF, notebooks and multi-selections. AABB already
// accounts for rotation/scale and group transforms.
export function lockLabelAnchor(objects) {
  if (!objects?.length) return null;
  const bounds = objects.map(object => object.getBoundingRect());
  const left = Math.min(...bounds.map(rect => rect.left));
  const top = Math.min(...bounds.map(rect => rect.top));
  const right = Math.max(...bounds.map(rect => rect.left + rect.width));
  return { x: (left + right) / 2, y: top };
}
