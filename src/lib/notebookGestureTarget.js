const gesturePages = new WeakMap();
const canvasFrames = new WeakMap();
const isNotebook = object => String(object?.type).toLowerCase() === 'boardnotebook';
function notebookFrames(canvas) {
  if (!canvas) return [];
  // Test/read-only adapters without collection events cannot maintain a registry.
  if (typeof canvas.on !== 'function') return (canvas.getObjects?.() ?? []).filter(isNotebook);
  let frames = canvasFrames.get(canvas);
  if (!frames) {
    frames = new Set((canvas.getObjects?.() ?? []).filter(isNotebook));
    canvas.on('object:added', ({ target }) => { if (isNotebook(target)) frames.add(target); });
    canvas.on('object:removed', ({ target }) => { frames.delete(target); });
    canvasFrames.set(canvas, frames);
  }
  return frames;
}
const frame = notebook => ({ notebook, pageNumber: notebook.notebookPageNumber,
  width: notebook.width, height: notebook.height, matrix: notebook.calcTransformMatrix().slice() });

/** Capture only visible notebook frame addresses at contact start. No child
 * serialization, decoding or hidden-page traversal occurs here. Weak, consumed
 * bindings never become part of a serialized stroke or retain deleted pages.
 */
export function snapshotNotebookGesturePages(canvas) {
  return new Map([...notebookFrames(canvas)]
    .map(notebook => [String(notebook.boardObjectId), frame(notebook)]));
}
export function bindNotebookGestureTarget(object, pages) {
  if (object && pages) gesturePages.set(object, pages);
  return object;
}
export function consumeNotebookGesturePage(object, notebook) {
  const pages = gesturePages.get(object);
  gesturePages.delete(object);
  if (!notebook) return null;
  if (!pages) return notebook.notebookPageNumber; // Paste/programmatic insertion.
  const start = pages.get(String(notebook.boardObjectId));
  const matrix = notebook.calcTransformMatrix();
  if (!start || start.notebook !== notebook || start.pageNumber !== notebook.notebookPageNumber
    || start.width !== notebook.width || start.height !== notebook.height
    || start.matrix.some((value, index) => Math.abs(value - matrix[index]) > 1e-7)) {
    throw new Error('Страница или рамка блокнота изменилась во время штриха — повторите действие');
  }
  return start.pageNumber;
}
