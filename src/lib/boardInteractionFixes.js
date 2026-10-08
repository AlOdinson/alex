// UI-only gesture guards. Never change object data or emit a durable update here.
// The normal Fabric transforms, leases and history remain the source of truth.
export const VIEW_POSITION_EPSILON = 0.0005;
export const VIEW_ZOOM_EPSILON = 0.00005;

export function hasTeacherCameraMoved(previous, next) {
  const values = [next?.centerX, next?.centerY, next?.zoom].map(Number);
  if (!values.every(Number.isFinite) || values[2] <= 0) return false;
  if (!previous) return true;
  const earlier = [previous.centerX, previous.centerY, previous.zoom].map(Number);
  if (!earlier.every(Number.isFinite) || earlier[2] <= 0) return true;
  return Math.abs(values[0] - earlier[0]) >= VIEW_POSITION_EPSILON
    || Math.abs(values[1] - earlier[1]) >= VIEW_POSITION_EPSILON
    || Math.abs(values[2] - earlier[2]) >= VIEW_ZOOM_EPSILON;
}

// Fabric's rotation action respects snapAngle/snapThreshold from the target.
// Disable inherited/legacy snaps for the active rotation gesture, without
// changing the geometry, corner scaling, history or realtime event pipeline.
export function enableContinuousRotation(transform) {
  const target = transform?.target;
  if (!target || (transform.action !== 'rotate' && transform.corner !== 'mtr')) return false;
  if (target.lockRotation) return false;
  target.snapAngle = 0;
  target.snapThreshold = 0;
  return true;
}

export function clearSelectionsForNewStroke(canvas, nativeSelection) {
  let clearedNative = false;
  let clearedObject = false;
  if (nativeSelection?.rangeCount > 0) {
    nativeSelection.removeAllRanges();
    clearedNative = true;
  }
  if (canvas?.getActiveObject?.()) {
    canvas.discardActiveObject();
    clearedObject = true;
  }
  return { clearedNative, clearedObject };
}
