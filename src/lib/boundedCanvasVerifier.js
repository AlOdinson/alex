import { isVerificationKey } from './boundedVerificationDigest.js';
import { validVerificationRecords } from './boundedVerificationState.js';

const PLACEMENT = new Set(['left', 'top', 'originX', 'originY', 'angle', 'scaleX', 'scaleY', 'skewX', 'skewY', 'flipX', 'flipY']);
export const isVerificationCanvasObject = (object) => Boolean(object?.boardObjectId)
  && !object.transientPreview && !object.transientTransformFallback
  && !object.transientSelectionProxy && !object.transientScreenShare;
const normalizedType = (value) => String(value?.type ?? value?.constructor?.type ?? '').toLowerCase();

// Compare the rendered objects themselves, not a serialization cache. Path arrays
// stay by reference and long text/paths yield; toObject() on a full path/group would
// defeat the CPU limit. Null means an opaque/loading representation is inconclusive.
async function contentMatches(actual, expected, budget, options, depth = 0) {
  await budget.checkpoint();
  if (depth > 128) return null;
  if (typeof expected === 'number') {
    return Number.isFinite(actual) && Number.isFinite(expected) && Math.abs(actual - expected) <= 0.002;
  }
  if (typeof expected === 'string') {
    if (typeof actual !== 'string' || actual.length !== expected.length) return false;
    for (let i = 0; i < expected.length; i += 1024) {
      if (actual.slice(i, i + 1024) !== expected.slice(i, i + 1024)) return false;
      await budget.checkpoint();
    }
    return true;
  }
  if (expected == null || typeof expected !== 'object') return actual === expected;
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) return false;
    for (let i = 0; i < expected.length; i++) {
      const match = await contentMatches(actual[i], expected[i], budget, options, depth + 1);
      if (match !== true) return match;
    }
    return true;
  }
  if (!actual || typeof actual !== 'object') return false;
  for (const key of Object.keys(expected)) {
    if (!isVerificationKey(key) || key === 'version' || (depth === 0 && PLACEMENT.has(key))) continue;
    // Image bytes are identified by the persisted asset path. Blob URLs differ
    // legitimately between devices, and a loading placeholder is checked separately.
    if (key === 'src' && expected.storagePath && actual.storagePath === expected.storagePath) continue;
    let value = actual[key];
    if (key === 'type') {
      if (normalizedType(actual) !== String(expected.type).toLowerCase()) return false;
      continue;
    }
    if (key === 'objects' && Array.isArray(actual._objects)) value = actual._objects;
    if (key === 'src' && typeof actual.getSrc === 'function') value = actual.getSrc();
    if (key === 'crossOrigin' && typeof actual.getCrossOrigin === 'function') value = actual.getCrossOrigin();
    if (['x1', 'x2', 'y1', 'y2'].includes(key) && normalizedType(actual) === 'line'
      && typeof actual.calcLinePoints === 'function') value = actual.calcLinePoints()[key];
    if (key === 'layoutManager' && typeof value?.toObject === 'function') value = value.toObject();
    if (key === 'styles' && Array.isArray(expected.styles) && !Array.isArray(value)) {
      if (!Object.keys(value ?? {}).length) value = [];
      else if (typeof options.stylesToArray === 'function') value = options.stylesToArray(value, actual.text ?? '');
      else return null;
    }
    // Never treat an opaque canvas/pattern source as a proven mismatch. Normal
    // serialized fields still compare recursively without traversing DOM objects.
    if (value && typeof value === 'object' && typeof value.nodeType === 'number') return null;
    const match = await contentMatches(value, expected[key], budget, options, depth + 1);
    if (match !== true) return match;
  }
  return true;
}

export function createBoundedCanvasVerifier({
  getCanvas, getRegistry, getRevision, getBackground,
  canCheck = () => true,
  placementMatches,
  apply,
  stylesToArray = null,
} = {}) {
  if (![getCanvas, getRegistry, getRevision, getBackground, placementMatches, apply].every((f) => typeof f === 'function')) {
    throw new TypeError('Canvas verification adapters are required');
  }
  let iterator = null;
  let iteratorRegistry = null;
  let remaining = 0;
  return {
    readIds(limit, { fullSweep = false, reset = false } = {}) {
      const registry = getRegistry();
      if (!registry) return { ids: [], done: true };
      if (reset || registry !== iteratorRegistry || !iterator || (!fullSweep && remaining <= 0)) {
        iteratorRegistry = registry; iterator = registry.keys(); remaining = registry.size;
      }
      const maximum = Math.max(0, Math.min(100, Number(limit) || 0));
      const ids = [];
      while (ids.length < maximum && remaining > 0) {
        const next = iterator.next();
        if (next.done) { remaining = 0; break; }
        remaining--;
        if (typeof next.value === 'string' && next.value) ids.push(next.value);
      }
      return { ids, done: remaining <= 0 };
    },
    async check(records, context) {
      try {
      if (!validVerificationRecords(records)) return false;
      const canvas = getCanvas();
      const current = () => Boolean(canvas && canvas === getCanvas()
        && context.isCurrent() && !context.signal?.aborted
        && Number(getRevision()) === context.revision && canCheck());
      if (!current()) return false;
      const registry = getRegistry();
      const repairs = [];
      let structuralRepair = false;
      const singles = new Map();
      for (const record of records) {
        let first = null; let count = 0;
        for (const object of registry?.get(record.id) ?? []) {
          if (!isVerificationCanvasObject(object)) continue;
          first ??= object;
          if (++count >= 2) break;
        }
        if (record.object === null) { if (count) { repairs.push(record); structuralRepair = true; } continue; }
        if (count !== 1) { repairs.push(record); structuralRepair = true; continue; }
        // Hydration is owned by the existing image loader. Do not recreate the same
        // placeholder repeatedly or pretend a placeholder proves pixels are present.
        if (first.pendingImage) return false;
        singles.set(first, record);
      }
      const ranks = new Map();
      let rank = 0;
      // Read existing backing references, never canvas.getObjects() which clones.
      for (const object of canvas._objects ?? []) {
        if (isVerificationCanvasObject(object)) {
          if (singles.has(object)) ranks.set(object, rank);
          rank++;
        }
        await context.budget.checkpoint();
        if (!current()) return false;
      }
      for (const [actual, record] of singles) {
        if (!current()) return false;
        if (ranks.get(actual) !== record.zIndex || !placementMatches(actual, record.object)) {
          repairs.push(record);
          if (ranks.get(actual) !== record.zIndex) structuralRepair = true;
          continue;
        }
        const matched = await contentMatches(actual, record.object, context.budget, { stylesToArray });
        if (matched === null) return false;
        if (!matched) repairs.push(record);
      }
      if (!current()) return false;
      const backgroundChanged = ['grid', 'dots', 'blank'].includes(context.background)
        && getBackground() !== context.background;
      if (!repairs.length && !backgroundChanged) return true;
      // apply must check this fence again AFTER asynchronous revival and immediately
      // before touching the Canvas; it must not enter the user history queue.
      const applied = await apply(repairs, { ...context, isCurrent: current }) !== false;
      if (applied && structuralRepair) context.onStructuralRepair?.();
      return applied;
      } catch (error) {
        if (error?.name === 'AbortError') return false;
        throw error;
      }
    },
  };
}
