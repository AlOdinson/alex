export const DEFAULT_ERASER_SCOPE = 'drawing';
export const ERASER_SCOPES = Object.freeze(['drawing', 'media', 'all']);

/** Scope is checked before hit-testing, not after choosing the topmost object. */
export function eraserAllows(object, scope = DEFAULT_ERASER_SCOPE) {
  if (!object || object.pendingUpload || object.isEraserPath || object.transientPreview || object.transientSelectionProxy) return false;
  if (!ERASER_SCOPES.includes(scope)) scope = DEFAULT_ERASER_SCOPE;
  if (scope === 'all') return true;
  const type = String(object.type ?? '').toLowerCase();
  // A notebook is a container. Its children are filtered again by the caller.
  if (type === 'boardnotebook') return true;
  const media = object.transientScreenShare || object.objectKind === 'screen-share'
    || object.mediaKind === 'pdf' || object.mediaKind === 'gif'
    || type === 'image' || object.objectKind === 'image' || object.pendingImage;
  if (media) return scope === 'media';
  const children = typeof object.getObjects === 'function' ? object.getObjects() : object.objects;
  // Never erase an entire mixed group in a category-specific mode.
  if (Array.isArray(children) && children.length) return children.every(child => eraserAllows(child, scope));
  return scope === 'drawing';
}
