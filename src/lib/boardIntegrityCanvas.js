import { validIntegrityIds } from './boardIntegrityData.js';

const durable = (object) => Boolean(object?.boardObjectId)
  && !object.transientPreview && !object.transientTransformFallback
  && !object.transientSelectionProxy && !object.transientScreenShare;

// Deliberately reads visible Fabric objects, not the serialization cache. Reading
// the cache would miss exactly the stale/missing Canvas state this check repairs.
export function createCanvasIntegrityAdapter({
  getCanvas, getRevision, isReady = () => true, isBusy = () => false,
  isProtected = () => false, isDurableObject = durable,
  projectObject = (object) => object, getBackground,
  applyRecord, applyBackground, subscribeWake = () => () => {},
} = {}) {
  const validCanvas = (canvas) => canvas && canvas === getCanvas() && isReady() && !isBusy();
  return {
    isReady, isBusy, getBackground, subscribeWake,
    size() { return getCanvas()?.size?.() ?? 0; },
    idAt(index) {
      const object = getCanvas()?.item?.(index);
      return isDurableObject(object) ? String(object.boardObjectId) : '';
    },
    async capture(ids, budget) {
      if (!validIntegrityIds(ids)) throw new Error('Invalid Canvas integrity batch');
      const canvas = getCanvas();
      const selected = new Map(ids.map((id) => [id, { id, count: 0, object: null, zIndex: -1, protected: Boolean(isProtected(id)) }]));
      let index = 0;
      await budget.run((function* () {
        for (let i = 0; i < (canvas?.size?.() ?? 0); i++) {
          const object = canvas.item(i);
          if (isDurableObject(object)) {
            const record = selected.get(String(object.boardObjectId));
            if (record) { record.count++; record.object = object; record.zIndex = index; }
            index++;
          }
          yield null;
        }
      })());
      for (const record of selected.values()) {
        if (record.object) record.object = await projectObject(record.object, budget);
        record.protected ||= Boolean(isProtected(record.id));
        budget.assertCurrent();
      }
      return [...selected.values()];
    },
    async repair(records, background, { revision, isCurrent, budget }) {
      const canvas = getCanvas();
      const guard = (id = null) => isCurrent() && getRevision() === revision
        && validCanvas(canvas) && (!id || !isProtected(id));
      if (!guard()) return false;
      // Deletions first, then absolute target layer order. This is repair only;
      // it must not create/merge/reorder the user's undo command history.
      const ordered = [...records].sort((a, b) => a.zIndex - b.zIndex);
      for (const record of ordered) {
        budget.assertCurrent();
        if (!guard(record.id)) return false;
        if (record.count !== 0 && record.count !== 1) throw new Error('Authority has duplicate object IDs');
        const applied = await applyRecord(record, () => guard(record.id));
        if (!applied || !guard(record.id)) return false;
        // Yield between actual repairs too. Loading/raster work is browser-owned,
        // so the 4ms traversal budget is not a hard maximum for rendering itself.
        await budget.run((function* () { for (let i = 0; i < 32; i++) yield null; })());
      }
      if (background != null) {
        if (!guard()) return false;
        await applyBackground(background, guard);
      }
      return guard();
    },
  };
}

const TEXT_STYLE_KEYS = ['fill', 'stroke', 'strokeWidth', 'fontSize', 'fontFamily',
  'fontWeight', 'fontStyle', 'textDecorationThickness', 'textDecorationColor',
  'textBackgroundColor', 'deltaY', 'overline', 'underline', 'linethrough'];

// Fabric stores character styles by line/character but serializes them as ranges.
// Normalize using its already-calculated grapheme lines, without re-splitting or
// cloning the text/path. This also works for Textbox's soft-wrapped lines.
async function textStyleRanges(object, budget) {
  const lines = object._unwrappedTextLines;
  if (!Array.isArray(lines)) return object.styles;
  const ranges = []; let index = -1; let previous = {};
  await budget.run((function* () {
    for (let line = 0; line < lines.length; line++) {
      const styles = object.styles?.[line];
      if (!styles) { index += lines[line].length; previous = {}; yield null; continue; }
      for (let char = 0; char < lines[line].length; char++) {
        index++;
        const style = styles[char];
        if (style && Object.keys(style).length) {
          if (!ranges.length || TEXT_STYLE_KEYS.some((key) => previous[key] !== style[key])) {
            ranges.push({ start: index, end: index + 1, style });
          } else ranges.at(-1).end++;
        }
        previous = style || {};
        yield null;
      }
    }
  })());
  return ranges;
}

export async function projectFabricIntegrityObject(object, budget, captureTransform = () => ({}), depth = 0) {
  if (!object || depth > 128) return object;
  const view = Object.create(object.pendingImageSerialized ?? object);
  Object.assign(view, captureTransform(object));
  if (typeof object.getSrc === 'function') {
    view.src = object.getSrc();
    view.crossOrigin = object.getCrossOrigin?.() ?? null;
  }
  if (object.styles && Array.isArray(object._unwrappedTextLines)) view.styles = await textStyleRanges(object, budget);
  if (typeof object.getObjects === 'function') {
    const children = [];
    for (let i = 0; i < object.size(); i++) {
      children.push(await projectFabricIntegrityObject(object.item(i), budget, captureTransform, depth + 1));
      await budget.run((function* () { yield null; })());
    }
    view.getObjects = () => children;
  }
  return view;
}
