// Reuse Fabric's existing clipped page surface, never allocate another renderer.
// Only a synchronously installed interior whole Path may append. Every unknown
// mutation, density change, edge effect, missing cache or page turn falls back.
import { util } from 'fabric';
const ready = new WeakMap();
const solid = object => String(object?.type).toLowerCase() === 'path'
  && !object.clipPath && !object.shadow && !object.isEraserPath
  && (!object.globalCompositeOperation || object.globalCompositeOperation === 'source-over')
  && (!object.fill || typeof object.fill === 'string') && (!object.stroke || typeof object.stroke === 'string');
function ordinaryPageClip(book) {
  const clip = book.clipPath;
  return String(clip?.type).toLowerCase() === 'rect' && !clip.clipPath && !clip.inverted && !clip.absolutePositioned
    && clip.width === book.width && clip.height === book.height
    && clip.originX === 'center' && clip.originY === 'center'
    && clip.left === 0 && clip.top === 0 && clip.scaleX === 1 && clip.scaleY === 1
    && !clip.angle && !clip.skewX && !clip.skewY && !clip.flipX && !clip.flipY
    && !clip.rx && !clip.ry && clip.opacity === 1 && clip.visible !== false;
}
function state(book) {
  if (!book.canvas || book.group || !book.ownCaching || !book._cacheCanvas || !book._cacheContext
    || !ordinaryPageClip(book) || book.shadow) return null;
  const values = [book.width, book.height, ...book.calcTransformMatrix(), book.zoomX, book.zoomY,
    book.cacheTranslationX, book.cacheTranslationY, book._cacheCanvas.width, book._cacheCanvas.height,
    book.canvas.getZoom(), book.canvas.getRetinaScaling(), book.backgroundColor, book.opacity];
  if (!values.slice(0,16).every(Number.isFinite)) return null;
  return { values, canvas: book.canvas, surface: book._cacheCanvas, context: book._cacheContext,
    page: book.notebookPageNumber, count: book._objects.length };
}
function same(a, b) {
  return Boolean(a && b && a.canvas === b.canvas && a.surface === b.surface && a.context === b.context
    && a.page === b.page && a.values.every((value, index) => Object.is(value, b.values[index])));
}
export function forgetNotebookAppendCache(book) { ready.delete(book); }
export function rememberNotebookAppendCache(book, forClipping = false) {
  const next = !forClipping && !book.dirty ? state(book) : null;
  if (next) ready.set(book, next); else ready.delete(book);
}
export function beginNotebookCacheAppend(book, child) {
  const previous = ready.get(book), current = !book.dirty && solid(child) ? state(book) : null;
  return same(previous, current) && previous.count === current.count ? current : null;
}
export function finishNotebookCacheAppend(book, child, previous) {
  const current = previous && state(book);
  if (!same(previous, current) || current.count !== previous.count + 1
    || book._objects.at(-1) !== child || child.group !== book || !solid(child)) return false;
  // Pixels near the rectangle boundary need the full anti-aliased clip. A strict
  // two-cache-pixel margin lets interior ink append without multiplying the old
  // page mask again (which would darken/erode already-clipped edge pixels).
  const inverse = util.invertTransform(book.calcTransformMatrix());
  const corners = child.getCoords().map(point => point.transform(inverse));
  // Fabric object bounds do not include arbitrarily acute miter tips. Bound
  // the transformed stroke footprint too, including strokeUniform scaling.
  const matrix = child.calcOwnMatrix(), scale = child.strokeUniform ? child.getObjectScaling() : { x: 1, y: 1 };
  const strokeScale = Math.hypot(matrix[0] / scale.x, matrix[1] / scale.x, matrix[2] / scale.y, matrix[3] / scale.y);
  const join = Math.max(2, child.strokeLineJoin === 'miter' ? Number(child.strokeMiterLimit || 4) : 2);
  const strokeMargin = child.stroke ? Math.max(0, Number(child.strokeWidth) || 0) * strokeScale * join / 2 : 0;
  const marginX = 2 / book.zoomX + strokeMargin, marginY = 2 / book.zoomY + strokeMargin;
  if (!corners.every(p => Number.isFinite(p.x) && Number.isFinite(p.y)
    && p.x > -book.width / 2 + marginX && p.x < book.width / 2 - marginX
    && p.y > -book.height / 2 + marginY && p.y < book.height / 2 - marginY)) return false;
  const ctx = current.context, transformed = book._transformDone;
  ctx.save();
  try {
    ctx.setTransform(book.zoomX, 0, 0, book.zoomY, book.cacheTranslationX, book.cacheTranslationY);
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    book._transformDone = true;
    child.render(ctx);
    book.dirty = false;
    rememberNotebookAppendCache(book);
    return true;
  } catch {
    // A partially drawn cache is never trusted. The next canonical render will
    // rebuild it from the unchanged vector model before it is presented.
    book.dirty = true; ready.delete(book); return false;
  } finally { book._transformDone = transformed; ctx.restore(); }
}
