import { classRegistry } from 'fabric';
import { enlivenNotebookObjects } from './notebookObjectPreparation.js';
import { createNotebookWorkSlice, notebookWorkCancelled } from './notebookWorkScheduler.js';

const loads = new WeakMap();
const release = value => { try { value?.dispose?.(); } catch { /* release detached preparation best-effort */ } };

/** Cancel only unfinished hydration, never erase the currently displayed lesson. */
export function cancelBoardCanvasLoad(canvas) {
  loads.get(canvas)?.abort(notebookWorkCancelled());
}

/** The same serialized scene contract as Fabric.loadFromJSON, with bounded eager
 * object construction. Ordinary images keep the existing lazy placeholders.
 * Nothing clears/changes the live scene before ALL detached content is ready.
 * One constructor, a nested group and the final synchronous installation are
 * indivisible; this is cooperative preparation, not an all-frame-time guarantee.
 */
export async function loadBoardCanvasJson(canvas, canvasJson, {
  imagePayload = () => null, createPlaceholder, signal, isCurrent = () => true,
} = {}) {
  cancelBoardCanvasLoad(canvas);
  const controller = new AbortController(); loads.set(canvas, controller);
  const abort = () => controller.abort(signal.reason);
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
  const owned = new Set(), slice = createNotebookWorkSlice();
  let installed = false;
  const check = () => {
    if (controller.signal.aborted) throw controller.signal.reason;
    if (loads.get(canvas) !== controller || canvas.disposed || canvas.destroyed || !isCurrent()) throw notebookWorkCancelled();
  };
  const current = () => !controller.signal.aborted && loads.get(canvas) === controller
    && !canvas.disposed && !canvas.destroyed && isCurrent();
  async function prepare(records) {
    const objects = await enlivenNotebookObjects(records, { signal: controller.signal }, current);
    if (!current()) { objects.forEach(release); check(); }
    objects.forEach(object => owned.add(object));
    return objects;
  }
  try {
    check();
    const source = canvasJson && typeof canvasJson === 'object' ? canvasJson : { objects: [] };
    const { objects: sourceObjects, ...serialized } = source;
    const records = Array.isArray(sourceObjects) ? sourceObjects : [];
    const output = new Array(records.length), immediate = [], positions = [];
    let pendingImages = 0;
    for (let index = 0; index < records.length; index++) {
      const pause = slice.beforeWork(); if (pause) await pause; check();
      const image = imagePayload(records[index]);
      if (image) {
        if (typeof createPlaceholder !== 'function') throw new TypeError('Image placeholder factory is required');
        const placeholder = createPlaceholder(image);
        if (!placeholder) throw new TypeError('Image placeholder factory returned no object');
        owned.add(placeholder); output[index] = placeholder; pendingImages++;
      } else { positions.push(index); immediate.push(records[index]); }
    }
    // Preserve Fabric's background/overlay/clip revival and custom scene fields.
    // Use the strict shared constructor boundary: a failed resource cannot be
    // silently omitted and then replace the old scene with incomplete content.
    const properties = { backgroundImage: serialized.backgroundImage, backgroundColor: serialized.background,
      overlayImage: serialized.overlayImage, overlayColor: serialized.overlay, clipPath: serialized.clipPath };
    const keys = Object.keys(properties).filter(key => properties[key]?.type && classRegistry.has(properties[key].type));
    const [objects, resources] = await Promise.all([prepare(immediate), prepare(keys.map(key => properties[key]))]);
    check();
    objects.forEach((object, index) => { output[positions[index]] = object; });
    resources.forEach((object, index) => { properties[keys[index]] = object; });
    const previousRenderOnAddRemove = canvas.renderOnAddRemove;
    canvas.renderOnAddRemove = false;
    try {
      canvas.clear();
      // Avoid the argument-count limit for a large scene, without yielding
      // halfway through installation or allowing a frame with partial content.
      for (let index = 0; index < output.length; index += 256) canvas.add(...output.slice(index, index + 256));
      canvas.set(serialized); canvas.set(properties);
      installed = true; owned.clear();
    } finally { canvas.renderOnAddRemove = previousRenderOnAddRemove; }
    return pendingImages;
  } catch (error) {
    controller.abort(error);
    if (!installed) owned.forEach(object => {
      // An exception from a consumer's synchronous canvas event is outside the
      // detached preparation contract. Do not dispose objects it already owns.
      if (object?.canvas !== canvas) release(object);
    });
    throw error;
  } finally {
    slice.reset(); signal?.removeEventListener('abort', abort);
    if (loads.get(canvas) === controller) loads.delete(canvas);
  }
}
