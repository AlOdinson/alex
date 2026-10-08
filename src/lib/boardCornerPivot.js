// A dragged corner and its diagonally opposite pivot form a similarity transform:
// pointer position determines BOTH the diagonal length and its free angle.
// No center rotation, snapping, accumulating transforms or object scans.
export const PIVOT_CORNERS = Object.freeze({
  tl: { dragX: 'left', dragY: 'top', pivotX: 'right', pivotY: 'bottom' },
  tr: { dragX: 'right', dragY: 'top', pivotX: 'left', pivotY: 'bottom' },
  br: { dragX: 'right', dragY: 'bottom', pivotX: 'left', pivotY: 'top' },
  bl: { dragX: 'left', dragY: 'bottom', pivotX: 'right', pivotY: 'top' },
});

const MIN_CORNER_SCALE_FACTOR = 0.005;
const MAX_CORNER_SCALE_FACTOR = 100;

function finitePoint(point) {
  return point && Number.isFinite(Number(point.x)) && Number.isFinite(Number(point.y));
}

export function isCornerPivotTransform(transform) {
  return Boolean(transform?.target && PIVOT_CORNERS[transform.corner]);
}

export function captureCornerPivotGesture(transform, firstPointer = null) {
  if (!isCornerPivotTransform(transform)) return null;
  const target = transform.target;
  if (typeof target.getPositionByOrigin !== 'function') return null;
  const origins = PIVOT_CORNERS[transform.corner];
  const pivot = target.getPositionByOrigin(origins.pivotX, origins.pivotY);
  const dragged = target.getPositionByOrigin(origins.dragX, origins.dragY);
  if (!finitePoint(pivot) || !finitePoint(dragged)) return null;
  const dx = dragged.x - pivot.x;
  const dy = dragged.y - pivot.y;
  const diagonalLength = Math.hypot(dx, dy);
  if (!Number.isFinite(diagonalLength) || diagonalLength < 0.00001) return null;

  const scaleX = Number(target.scaleX ?? 1);
  const scaleY = Number(target.scaleY ?? 1);
  const angle = Number(target.angle ?? 0);
  if (![scaleX, scaleY, angle].every(Number.isFinite)) return null;

  // Fabric keeps the original pointer in transform.ex/ey (scene coordinates).
  // Keep the small grip offset so grabbing the edge of a handle never jumps.
  const startX = Number.isFinite(Number(transform.ex)) ? Number(transform.ex) : Number(firstPointer?.x);
  const startY = Number.isFinite(Number(transform.ey)) ? Number(transform.ey) : Number(firstPointer?.y);

  return {
    target,
    corner: transform.corner,
    origins,
    pivot,
    initialAngle: angle,
    initialScaleX: scaleX,
    initialScaleY: scaleY,
    initialDirection: Math.atan2(dy, dx),
    diagonalLength,
    offsetX: Number.isFinite(startX) ? dragged.x - startX : 0,
    offsetY: Number.isFinite(startY) ? dragged.y - startY : 0,
  };
}

export function cornerPivotAt(gesture, pointerX, pointerY) {
  if (!gesture || !Number.isFinite(pointerX) || !Number.isFinite(pointerY)) return null;
  const dx = pointerX + gesture.offsetX - gesture.pivot.x;
  const dy = pointerY + gesture.offsetY - gesture.pivot.y;
  const distance = Math.hypot(dx, dy);
  // Keep matrices invertible and avoid a singular jump exactly on the pivot.
  const factor = Math.max(MIN_CORNER_SCALE_FACTOR,
    Math.min(MAX_CORNER_SCALE_FACTOR, distance / gesture.diagonalLength));
  const direction = distance < gesture.diagonalLength * MIN_CORNER_SCALE_FACTOR
    ? gesture.initialDirection : Math.atan2(dy, dx);
  return {
    angle: gesture.initialAngle + (direction - gesture.initialDirection) * 180 / Math.PI,
    scaleX: gesture.initialScaleX * factor,
    scaleY: gesture.initialScaleY * factor,
    factor,
  };
}

export function dragCornerAroundOpposite(eventData, transform, x, y) {
  const target = transform?.target;
  if (!target || !isCornerPivotTransform(transform) || target.lockRotation
    || target.lockScalingX || target.lockScalingY) return false;
  const gesture = transform.__alexCornerPivotGesture
    ?? captureCornerPivotGesture(transform, { x, y });
  if (!gesture) return false;
  transform.__alexCornerPivotGesture = gesture;
  if (gesture.target !== target || gesture.corner !== transform.corner) return false;
  const next = cornerPivotAt(gesture, Number(x), Number(y));
  if (!next) return false;
  if (Math.abs(target.angle - next.angle) < 1e-7
    && Math.abs(target.scaleX - next.scaleX) < 1e-7
    && Math.abs(target.scaleY - next.scaleY) < 1e-7) return false;

  target.set({ scaleX: next.scaleX, scaleY: next.scaleY, angle: next.angle });
  // Reposition to the ORIGINAL pivot. This keeps the diagonally opposite corner
  // in exactly the same canvas location throughout the gesture.
  target.setPositionByOrigin(gesture.pivot, gesture.origins.pivotX, gesture.origins.pivotY);
  target.dirty = true;
  target.setCoords?.();
  return true;
}
