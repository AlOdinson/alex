import { isBoardNotebook, setNotebookPage } from './boardNotebook.js';
import { isBoardMedia } from './boardMediaRuntime.js';
import { pdfPageGeometry } from './pdfPageGeometry.js';

const readingLocks = new WeakMap();
const lockKeys = ['lockMovementX', 'lockMovementY', 'lockScalingX', 'lockScalingY',
  'lockSkewingX', 'lockSkewingY', 'lockRotation'];
export const isStudentReadingDocument = object => Boolean(object?.boardObjectId
  && !object.transientPreview && !object.pendingImage && !object.isEraserPath
  && (isBoardNotebook(object) || isBoardMedia(object) && object.mediaKind === 'pdf'));

// A selection is a reading focus, not permission to transform the document.
// Preserve permanent locks (notably notebook rotation) across reconnects.
export function applyStudentReadingInteractivity(object, enabled) {
  if (!object) return false;
  if (enabled && isStudentReadingDocument(object)) {
    if (!readingLocks.has(object)) readingLocks.set(object, Object.fromEntries(lockKeys.map(key => [key, object[key]])));
    for (const key of lockKeys) object[key] = true;
    object.selectable = object.evented = object.hasBorders = true;
    object.hasControls = false; object.hoverCursor = 'grab';
    return true;
  }
  const previous = readingLocks.get(object);
  if (previous) { Object.assign(object, previous); readingLocks.delete(object); }
  return false;
}

/** Canvas-only page projection. No authority, lease, history, or storage API is
 * accepted here. The shared replica and saved lesson remain unchanged. */
export function createStudentDocumentReader({ canvas, canRead, getMediaRuntime,
  onChange = () => {}, onBusy = () => {}, onError = () => {} }) {
  const originals = new Map();
  let controller = new AbortController(), tail = Promise.resolve(), disposed = false;
  const present = object => !disposed && canvas.getObjects().includes(object);
  const capture = object => {
    if (!originals.has(object)) {
      originals.set(object, {
        page: isBoardNotebook(object) ? object.notebookPageNumber : object.pageNumber,
        pages: object.notebookPages, updatedAt: object.updatedAt, updatedBy: object.updatedBy,
        lastPage: isBoardNotebook(object) ? object.notebookPageNumber : object.pageNumber,
        geometry: { width: object.width, height: object.height, left: object.left, top: object.top },
      });
    }
    return originals.get(object);
  };
  const enqueue = (kind, work) => {
    const signal = controller.signal;
    const current = () => !disposed && !signal.aborted && canRead();
    const result = tail.then(async () => {
      if (!current()) return false;
      onBusy(kind, true);
      try { return await work(current, signal); }
      catch (error) { if (current()) onError(error); return false; }
      finally { if (!signal.aborted && !disposed) onBusy(kind, false); }
    });
    tail = result.catch(() => {});
    return result;
  };
  const invalidate = () => {
    controller.abort(); controller = new AbortController(); tail = Promise.resolve();
    onBusy('pdf', false); onBusy('notebook', false);
  };
  return {
    changePdfPage(object, page) {
      return enqueue('pdf', async current => {
        if (!present(object) || !isBoardMedia(object) || object.mediaKind !== 'pdf'
          || !Number.isInteger(page) || page < 1 || page > object.pageCount || page === object.pageNumber) return false;
        const original = capture(object), media = getMediaRuntime();
        const result = await media.preparePage(object, page);
        if (!current() || !present(object)) return false;
        const center = object.getCenterPoint();
        object.set({ pageNumber: page, ...pdfPageGeometry(object, result) });
        object.setPositionByOrigin(center, 'center', 'center');
        original.lastPage = page;
        media.showPreparedPage(object, result); onChange(); canvas.requestRenderAll();
        return true;
      });
    },
    changeNotebookPage(requested, id = null, relative = false) {
      return enqueue('notebook', async (current, signal) => {
        const object = id == null ? canvas.getActiveObject()
          : canvas.getObjects().find(item => String(item.boardObjectId) === String(id));
        if (!present(object) || !isBoardNotebook(object)) return false;
        const original = capture(object);
        const maximum = Math.max(1, original.page, object.notebookPages.length);
        const page = relative ? Math.max(1, object.notebookPageNumber + requested) : requested;
        if (!Number.isInteger(page) || page < 1 || page > maximum || page === object.notebookPageNumber) return false;
        if (!await setNotebookPage(object, page, { signal }) || !current() || !present(object)) return false;
        original.lastPage = page;
        onChange(); canvas.requestRenderAll(); return true;
      });
    },
    hasLocalPages: () => originals.size > 0,
    cancelPending() { invalidate(); },
    // A full authoritative Canvas replacement must win over in-flight reading.
    discard() { invalidate(); originals.clear(); },
    async restore() {
      invalidate();
      const signal = controller.signal;
      for (const [object, original] of originals) {
        if (signal.aborted || disposed) return;
        const notebook = isBoardNotebook(object);
        const current = () => !signal.aborted && present(object)
          && object.updatedAt === original.updatedAt && object.updatedBy === original.updatedBy
          && (notebook ? object.notebookPages === original.pages && object.notebookPageNumber === original.lastPage
            : object.pageNumber === original.lastPage);
        // A new remote object/page is never rolled back to an old local view.
        if (!current()) continue;
        if (notebook) {
          await setNotebookPage(object, original.page, { signal });
          if (!signal.aborted) original.lastPage = original.page;
        }
        else if (object.pageNumber !== original.page) {
          const media = getMediaRuntime(), result = await media.preparePage(object, original.page);
          if (!current()) continue;
          object.set({ pageNumber: original.page, ...original.geometry }); object.setCoords();
          media.showPreparedPage(object, result); original.lastPage = original.page;
        }
      }
      if (signal.aborted || disposed) return;
      originals.clear(); onChange(); canvas.requestRenderAll();
    },
    dispose() { disposed = true; controller.abort(); originals.clear(); },
  };
}
