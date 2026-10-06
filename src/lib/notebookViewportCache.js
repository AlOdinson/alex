import { ordinaryPageClip } from './notebookAppendCache.js';

// Viewport quality is ephemeral. Only explicit Board viewport changes start a
// gesture; export/compositor contexts never borrow a lower-density page image.
const coordinators = new WeakMap();
const clock = () => globalThis.performance?.now?.() ?? Date.now();
const viewOf = canvas => [...canvas.viewportTransform.slice(0, 4), canvas.getRetinaScaling()];
const equal = (a, b) => a?.length === b?.length && a.every((value, i) => Object.is(value, b[i]));
function visible(book, canvas) {
  return book.canvas === canvas && !book.isNotVisible() && (!canvas.skipOffscreen || book.isOnScreen());
}
function stamp(book) {
  if (book.group || book.shadow || !ordinaryPageClip(book) || book.clipPath.shadow
    || book.clipPath.strokeWidth !== 0 || book._pageContentInvalid || book.dirty
    || !book._cacheCanvas?.width || !book._cacheCanvas?.height || !book._cacheContext) return null;
  return { surface: book._cacheCanvas, context: book._cacheContext, clip: book.clipPath,
    pages: book.notebookPages, page: book.notebookPageNumber, count: book._objects.length,
    values: [book.width, book.height, ...book.calcTransformMatrix(), book.zoomX, book.zoomY,
      book.cacheTranslationX, book.cacheTranslationY, book._cacheCanvas.width, book._cacheCanvas.height,
      book.canvas.getRetinaScaling(), book.backgroundColor, book.opacity] };
}
function matches(a, b) {
  return a && b && a.surface === b.surface && a.context === b.context && a.clip === b.clip
    && a.pages === b.pages && a.page === b.page && a.count === b.count && equal(a.values, b.values);
}

export function createNotebookViewportCache(canvas, { quietMs = 120, densityRatio = 1.2,
  now = clock, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  if (!(quietMs >= 0) || !Number.isFinite(quietMs) || !(densityRatio > 1) || !Number.isFinite(densityRatio)) {
    throw new TypeError('Invalid notebook viewport quality limits');
  }
  const stamps = new WeakMap(), pending = new Set();
  let lastView = viewOf(canvas), lastChange = -Infinity, timer = null, due = null, grant = null, disposed = false;
  const stopTimer = () => { if (timer != null) clearTimer(timer); timer = due = null; };
  function scheduleAt(time) {
    if (disposed || !pending.size || canvas.disposed || canvas.destroyed) { stopTimer(); return; }
    if (timer != null && due === time) return;
    stopTimer(); due = time;
    timer = setTimer(() => { timer = due = null; refine(); }, Math.max(0, time - now()));
    timer?.unref?.();
  }
  function refine() {
    if (disposed || canvas.disposed || canvas.destroyed) { pending.clear(); return; }
    if (now() < lastChange + quietMs) { scheduleAt(lastChange + quietMs); return; }
    // One notebook receives canonical refinement per normal canvas frame. A
    // single large Fabric render is not preempted by this scheduling policy.
    for (const book of pending) {
      if (!visible(book, canvas)) { pending.delete(book); stamps.delete(book); continue; }
      grant = book; canvas.requestRenderAll(); return;
    }
    grant = null;
  }
  function changed() {
    if (disposed) return;
    const next = viewOf(canvas);
    if (equal(next, lastView)) return; // translation-only pan is not a new zoom
    lastView = next; lastChange = now(); grant = null;
    if (pending.size) scheduleAt(lastChange + quietMs);
  }
  function afterRender({ ctx }) {
    if (ctx !== canvas.getContext() || disposed) return;
    if (grant) { // selected owner may have left the viewport before this frame
      stamps.delete(grant); pending.delete(grant); grant = null;
    }
    if (pending.size) scheduleAt(Math.max(now(), lastChange + quietMs));
    else stopTimer();
  }
  const offChanged = canvas.on('notebook:viewport-changed', changed);
  const offRendered = canvas.on('after:render', afterRender);
  const api = {
    reuse(book) {
      if (disposed || canvas.disposed || canvas.destroyed || book === grant
        || now() >= lastChange + quietMs && !pending.has(book)) return false;
      const current = stamp(book);
      if (!matches(stamps.get(book), current)) return false;
      const dims = book._limitCacheSize(book._getCacheCanvasDimensions());
      const ratios = [dims.zoomX / book.zoomX, book.zoomX / dims.zoomX, dims.zoomY / book.zoomY, book.zoomY / dims.zoomY];
      if (!ratios.every(value => Number.isFinite(value) && value > 0 && value <= densityRatio)) return false;
      if (dims.zoomX === book.zoomX && dims.zoomY === book.zoomY
        && dims.width === book._cacheCanvas.width && dims.height === book._cacheCanvas.height) return false;
      pending.add(book);
      if (!grant) scheduleAt(Math.max(now(), lastChange + quietMs));
      return true;
    },
    remember(book) {
      const value = stamp(book);
      if (value) stamps.set(book, value); else stamps.delete(book);
      pending.delete(book); if (grant === book) grant = null;
      if (!pending.size) stopTimer();
    },
    forget(book) {
      stamps.delete(book); pending.delete(book);
      if (grant === book) { grant = null; if (pending.size) scheduleAt(Math.max(now(), lastChange + quietMs)); }
      if (!pending.size) stopTimer();
    },
    dispose() { disposed = true; stopTimer(); pending.clear(); grant = null; offChanged(); offRendered(); },
  };
  return api;
}
export function notebookViewportCacheFor(canvas) {
  if (!canvas) return null;
  let value = coordinators.get(canvas);
  if (!value) { value = createNotebookViewportCache(canvas); coordinators.set(canvas, value); }
  return value;
}
