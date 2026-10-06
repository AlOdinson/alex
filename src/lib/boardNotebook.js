import { notebookViewportCacheFor } from './notebookViewportCache.js';
import { createNotebookSplitScope, checkNotebookSplit } from './notebookSplitCancellation.js';
import { enlivenNotebookObjects } from './notebookObjectPreparation.js';
import { beginNotebookDamage, finishNotebookDamage } from './notebookDamageRenderer.js';
import { currentNotebookChildIndex, rebuildNotebookChildIndex, forgetNotebookChildIndex } from './notebookChildIndex.js';
import { notebookPageState, notebookPageChanges } from './notebookPageModel.js';
import { notebookPageAppend } from './notebookPageDelta.js';
import { beginNotebookCacheAppend, finishNotebookCacheAppend, rememberNotebookAppendCache, forgetNotebookAppendCache } from './notebookAppendCache.js';
import { memoizeImmutableNotebookImage } from './notebookAssets.js';
import { navigateNotebookPage, retireNotebookPageWork, notebookPageSplitSignal } from './notebookPageRuntime.js';
export { applyPageDeltaToFabric } from './notebookPageRuntime.js';
import { freezeNotebookRecord as freezeRecord } from './notebookRecords.js';
import { randomToken } from './ids.js';
import { notebookRenderCacheFor } from './notebookRenderCache.js';
import { Group, Rect, FabricObject, LayoutManager, FixedLayout, Point, classRegistry, controlsUtils, util } from 'fabric';

export const NOTEBOOK_FIELDS = ['notebookPages', 'notebookPageNumber'];
export const isBoardNotebook = (object) => String(object?.type).toLowerCase() === 'boardnotebook';
const childFields = ['id', 'shapeType', 'boardObjectId', 'objectKind', 'storagePath', 'isEraserPath', 'updatedAt', 'updatedBy'];
const inert = (object) => object.set({ selectable: false, evented: false });
// Serialized page data is copy-on-write. Callers retaining a before-record never
// share mutable Fabric properties with a subsequent edit.

function releaseSurface(object) {
  if (object?._cacheCanvas) object._cacheCanvas.width = object._cacheCanvas.height = 0;
  object?._removeCacheCanvas?.();
}
function releaseChildSurfaces(object) {
  releaseSurface(object);
  if (object.clipPath) releaseChildSurfaces(object.clipPath);
  object.getObjects?.().forEach(releaseChildSurfaces);
}

/** Only the visible page is enlivened; all other pages remain durable JSON. */
export class BoardNotebook extends Group {
  static type = 'BoardNotebook';

  constructor(options = {}) {
    const { notebookPages = [[]], notebookPageNumber = 1, objects: ignoredObjects, layoutManager: ignoredLayout, type: ignoredType, ...frame } = options;
    super([], { width: 520, height: 480, originX: 'left', originY: 'top', backgroundColor: '#ffffff', strokeWidth: 0, ...frame,
      layoutManager: new LayoutManager(new FixedLayout()), subTargetCheck: false,
      lockScalingFlip: true, lockRotation: true });
    this.notebookPages = freezeRecord(structuredClone(notebookPages.length ? notebookPages : [[]]));
    this._pageRecords = new WeakMap();
    this._pageContentInvalid = false;
    this.objectCaching = true;
    this.noScaleCache = false;
    this.on('removed', () => { this.releasePageCache(); retireNotebookPageWork(this); });
    this.notebookPageNumber = Math.max(1, notebookPageNumber);
    this.clipPath = new Rect({ width: this.width, height: this.height, originX: 'center', originY: 'center', strokeWidth: 0 });
    this.setControlsVisibility({ mt: false, mb: false, ml: false, mr: false, mtr: false });
    for (const corner of ['tl', 'tr', 'bl', 'br']) {
      const control = this.controls[corner];
      this.controls[corner] = Object.assign(Object.create(Object.getPrototypeOf(control)), control, {
        actionHandler(event, transform, x, y) {
          const canvas = transform.target.canvas;
          const oldUniform = canvas?.uniformScaling;
          if (canvas) canvas.uniformScaling = true;
          try { return controlsUtils.scalingEqually({ ...event, [canvas?.uniScaleKey || 'shiftKey']: false }, transform, x, y); }
          finally { if (canvas) canvas.uniformScaling = oldUniform; }
        },
      });
    }
  }

  // A clipped notebook must remain an isolated cached object, including when a
  // child casts a shadow. Fabric Group's shadow heuristic otherwise disables the
  // very cache its clip requires and reaches an invalid uncached clip context.
  shouldCache() {
    if (this.clipPath) { this.ownCaching = true; return true; }
    return super.shouldCache();
  }

  getPageObjects() { return this.getObjects(); }

  addPageObject(object, preparedRecord = null) {
    const append = preparedRecord ? beginNotebookCacheAppend(this, object) : null;
    memoizeImmutableNotebookImage(object);
    if (!object.boardObjectId) object.boardObjectId = randomToken(14);
    // Group.add accepts world coordinates; preserve the prepared local placement.
    const matrix = object.calcOwnMatrix();
    this.add(inert(object));
    util.applyTransformToObject(object, matrix);
    object.setCoords();
    if (preparedRecord?.boardObjectId === object.boardObjectId) {
      // Prepared data belongs to this new child, not to a mutable live Path.
      this._pageRecords.set(object, freezeRecord(structuredClone(preparedRecord)));
    }
    this.syncPage({ invalidate: false });
    if (!finishNotebookCacheAppend(this, object, append)) this.dirty = true;
    return object;
  }

  replacePageObjects(objects, records = null) {
    const previous = this.getPageObjects();
    this.remove(...previous);
    const matrices = objects.map(object => object.calcOwnMatrix());
    objects.forEach(object => {
      if (!object.boardObjectId) object.boardObjectId = randomToken(14);
      inert(object);
    });
    if (objects.length) this.add(...objects);
    objects.forEach((object, index) => {
      util.applyTransformToObject(object, matrices[index]);
      object.setCoords();
    });
    this._pageRecords = new WeakMap();
    if (records) objects.forEach((object, index) => {
      if (records[index]?.boardObjectId === object.boardObjectId) this._pageRecords.set(object, records[index]);
    });
    this.syncPage({ invalidate: false });
    this.dirty = true;
    previous.forEach(object => object.dispose());
  }

  // An addressed append shares every earlier record with the installed page.
  // No old-child scan, reorder, or serialization is needed at this boundary.
  appendPreparedPageObject(object, pages) {
    const before = notebookPageState(this.notebookPages, this.notebookPageNumber - 1);
    const after = notebookPageState(pages, this.notebookPageNumber - 1);
    const delta = !this._pageContentInvalid && notebookPageAppend(before, after);
    if (!delta || this._objects.length !== delta.index
      || String(object?.boardObjectId) !== String(delta.record.boardObjectId)) return false;
    const append = beginNotebookCacheAppend(this, object), matrix = object.calcOwnMatrix();
    memoizeImmutableNotebookImage(object);
    this.add(inert(object)); util.applyTransformToObject(object, matrix); object.setCoords();
    this._pageRecords.set(object, delta.record);
    if (delta.record.updatedAt != null) object.updatedAt = delta.record.updatedAt;
    if (delta.record.updatedBy != null) object.updatedBy = delta.record.updatedBy;
    this.notebookPages = pages; this._pageContentInvalid = false;
    if (!finishNotebookCacheAppend(this, object, append)) this.dirty = true;
    return true;
  }

  // The diff comes from related immutable page indexes, not untrusted wire hints.
  // Validate every addressed slot before altering any group membership.
  applyAddressedPageChanges(changes, prepared, pages) {
    const before = notebookPageState(this.notebookPages, this.notebookPageNumber - 1);
    const after = notebookPageState(pages, this.notebookPageNumber - 1);
    const proven = notebookPageChanges(before, after);
    if (this._pageContentInvalid || before.length !== this._objects.length || !proven
      || proven.length !== changes.length || proven.some((entry, i) => {
        const claim = changes[i];
        return !claim || entry.before !== claim.before || entry.after !== claim.after
          || entry.beforeIndex !== claim.beforeIndex || entry.index !== claim.index;
      })) return false;
    const fresh = new Map(prepared.map(object => [String(object.boardObjectId), object]));
    if (fresh.size !== prepared.length) return false;
    const edits = [];
    for (const change of changes) {
      const old = change.before ? this._objects[change.beforeIndex] : null;
      if (change.before && (!old || String(old.boardObjectId) !== String(change.before.boardObjectId)
        || this._pageRecords.get(old) !== change.before)) return false;
      const object = change.after ? fresh.get(String(change.after.boardObjectId)) ?? old : null;
      if (change.after && (!object || String(object.boardObjectId) !== String(change.after.boardObjectId)
        || object !== old && object.group)) return false;
      edits.push({ ...change, old, object, matrix: object?.calcOwnMatrix() });
    }
    const index = currentNotebookChildIndex(this);
    const damage = beginNotebookDamage(this, changes, prepared);
    const removed = [];
    // Dense Fabric slots still shift on structural insertion/removal. Addressed
    // access avoids an ID scan, full page copies and re-preparing retained children.
    for (const edit of [...edits].sort((a,b) => b.beforeIndex-a.beforeIndex)) if (edit.old) {
      this._objects.splice(edit.beforeIndex, 1);
      this._onObjectRemoved(edit.old); removed.push(edit.old);
      index?.delete(edit.old.boardObjectId);
    }
    if (removed.length) this._onAfterObjectsChange('removed', removed);
    const added = [];
    for (const edit of [...edits].sort((a,b) => a.index-b.index)) if (edit.object) {
      const object = inert(edit.object);
      this._objects.splice(edit.index, 0, object); this._onObjectAdded(object);
      util.applyTransformToObject(object, edit.matrix); object.setCoords();
      this._pageRecords.set(object, edit.after);
      if (edit.after.updatedAt != null) object.updatedAt = edit.after.updatedAt;
      if (edit.after.updatedBy != null) object.updatedBy = edit.after.updatedBy;
      index?.put(object); added.push(object);
    }
    if (added.length) this._onAfterObjectsChange('added', added);
    for (const edit of edits) if (edit.old && edit.old !== edit.object) {
      this._pageRecords.delete(edit.old); edit.old.dispose();
    }
    this.notebookPages = pages; this._pageContentInvalid = false;
    if (!finishNotebookDamage(this, damage, after, releaseChildSurfaces)) this.dirty = true;
    return true;
  }

  applyPreparedPageDelta(records, prepared, pages) {
    if (prepared.length === 1 && pages?.[this.notebookPageNumber - 1] === records
      && this.appendPreparedPageObject(prepared[0], pages)) return;
    const previous = this.getPageObjects();
    const byId = new Map(previous.map(object => [String(object.boardObjectId), object]));
    const fresh = new Map(prepared.map(object => [String(object.boardObjectId), object]));
    const desired = records.map(record => fresh.get(String(record.boardObjectId)) ?? byId.get(String(record.boardObjectId)));
    if (desired.some(object => !object) || new Set(desired).size !== desired.length) {
      throw new Error('Notebook visible page differs from the delta baseline');
    }
    const retained = new Set(desired), removed = previous.filter(object => !retained.has(object));
    const append = removed.length === 0 && prepared.length === 1 && desired.at(-1) === prepared[0]
      && desired.length === previous.length + 1 && previous.every((object, index) => desired[index] === object)
      ? beginNotebookCacheAppend(this, prepared[0]) : null;
    const matrices = prepared.map(object => object.calcOwnMatrix());
    if (removed.length) this.remove(...removed);
    if (prepared.length) this.add(...prepared.map(inert));
    prepared.forEach((object, index) => {
      util.applyTransformToObject(object, matrices[index]); object.setCoords();
    });
    // Only new/replaced children move. Existing siblings keep their Fabric object,
    // masks, and immutable serialization; normal one-stroke work stays bounded.
    desired.forEach((object, index) => {
      if (fresh.has(String(object.boardObjectId))) this.moveObjectTo(object, index);
      this._pageRecords.set(object, records[index]);
    });
    removed.forEach(object => { this._pageRecords.delete(object); object.dispose(); });
    this.notebookPages = pages; this._pageContentInvalid = false;
    if (!finishNotebookCacheAppend(this, prepared[0], append)) this.dirty = true;
  }

  invalidatePageContent(child) {
    forgetNotebookChildIndex(this);
    if (child) this._pageRecords.delete(child);
    else this._pageRecords = new WeakMap();
    this._pageContentInvalid = true;
    this.dirty = true;
  }

  syncPage({ invalidate = true } = {}) {
    if (invalidate) this.invalidatePageContent();
    const objects = this.getPageObjects();
    if (objects.length || this.notebookPageNumber <= this.notebookPages.length) {
      const page = objects.map(object => {
        if (!this._pageRecords.has(object)) this._pageRecords.set(object,
          freezeRecord(structuredClone(object.toObject(childFields))));
        return this._pageRecords.get(object);
      });
      const previous = this.notebookPages[this.notebookPageNumber - 1];
      if (previous?.length === page.length && page.every((record, index) => previous[index] === record)) {
        this._pageContentInvalid = false;
        return this.notebookPages;
      }
      const pages = this.notebookPages.slice();
      while (pages.length < this.notebookPageNumber) pages.push(Object.freeze([]));
      pages[this.notebookPageNumber - 1] = freezeRecord(page);
      this.notebookPages = Object.freeze(pages);
    }
    this._pageContentInvalid = false;
    return this.notebookPages;
  }

  toObject(propertiesToInclude = []) {
    if (this._pageContentInvalid) this.syncPage({ invalidate: false });
    // FabricObject serialization avoids a second copy under Group.objects.
    const result = FabricObject.prototype.toObject.call(this, propertiesToInclude.filter((key) => !NOTEBOOK_FIELDS.includes(key)));
    delete result.clipPath;
    return { ...result, notebookPages: this.notebookPages, notebookPageNumber: this.notebookPageNumber };
  }

  serializeNotebookForSnapshot(propertiesToInclude = []) {
    return structuredClone(this.toObject(propertiesToInclude));
  }

  render(ctx) {
    const previous = this._notebookRenderContext;
    this._notebookRenderContext = ctx;
    this._notebookRenderDepth = (this._notebookRenderDepth || 0) + 1;
    try { return super.render(ctx); }
    finally {
      this._notebookRenderContext = previous;
      if (!--this._notebookRenderDepth && this._releaseCacheAfterDraw) {
        this._releaseCacheAfterDraw = false; this._evictPageCache();
      }
    }
  }

  _evictPageCache() {
    this._notebookViewportCache?.forget(this);
    forgetNotebookAppendCache(this);
    releaseSurface(this); releaseSurface(this.clipPath); this.dirty = true;
  }

  releasePageCache() {
    this._notebookViewportCache?.forget(this);
    forgetNotebookChildIndex(this);
    forgetNotebookAppendCache(this);
    this._pageRenderCache?.release(this);
    this._pageRenderCache = null;
    releaseSurface(this);
    releaseSurface(this.clipPath);
  }

  renderCache(options) {
    const cache = notebookRenderCacheFor(this.canvas);
    if (this._pageRenderCache !== cache) this.releasePageCache();
    this._pageRenderCache = cache;
    const normal = this._notebookRenderContext && this._notebookRenderContext === this.canvas?.getContext();
    const viewport = this._notebookViewportCache = notebookViewportCacheFor(this.canvas);
    if (normal && !options?.forClipping && viewport?.reuse(this)) {
      // Do not enable append/damage at an interpolated viewport density. A real
      // content change still uses the canonical renderer immediately.
      forgetNotebookAppendCache(this); cache?.acquire(this); return;
    }
    const wasDirty = this.dirty || !this._cacheCanvas;
    const previousZoomX = this.zoomX, previousZoomY = this.zoomY;
    super.renderCache(options);
    if (wasDirty || previousZoomX !== this.zoomX || previousZoomY !== this.zoomY) {
      this.getPageObjects().forEach(releaseChildSurfaces);
    }
    // Bounds are page-local. Viewport density alone does not change the index.
    if (wasDirty || !currentNotebookChildIndex(this)) rebuildNotebookChildIndex(this);
    // The page already contains the rectangular clip. Fabric creates a fresh
    // clip layer on the next canonical render, so retaining this doubles memory.
    releaseSurface(this.clipPath);
    cache?.acquire(this, { surfaces: [this._cacheCanvas].filter(Boolean),
      isVisible: () => this.canvas && !this.isNotVisible() && (!this.canvas.skipOffscreen || this.isOnScreen()),
      onEvict: () => {
        // Fabric consumes the cache immediately after renderCache returns.
        // A refused admission must not erase it before drawCacheOnCanvas.
        if (this._notebookRenderDepth) this._releaseCacheAfterDraw = true;
        else this._evictPageCache();
      } });
    if (this._releaseCacheAfterDraw) { viewport?.forget(this); forgetNotebookAppendCache(this); }
    else {
      rememberNotebookAppendCache(this, options?.forClipping);
      if (normal && !options?.forClipping) viewport?.remember(this);
      else viewport?.forget(this); // export and compositor always stay exact
    }
  }

  isNotebookCompositingIsolated() { return Boolean(this.ownCaching && this._cacheCanvas); }

  dispose() {
    retireNotebookPageWork(this, true);
    this.releasePageCache();
    return super.dispose();
  }

  static async fromObject(serialized, options = {}) {
    const { clipPath, shadow, ...frame } = serialized;
    const notebook = new BoardNotebook(frame);
    try {
      if (shadow) notebook.shadow = (await util.enlivenObjectEnlivables({ shadow }, options)).shadow;
      const records = notebook.notebookPages[notebook.notebookPageNumber - 1] || [];
      const objects = await enlivenNotebookObjects(records, options);
      try { notebook.replacePageObjects(objects, records); }
      catch (error) { objects.filter(object => object.group !== notebook).forEach(object => object.dispose()); throw error; }
      notebook.setCoords();
      return notebook;
    } catch (error) { notebook.dispose(); throw error; }
  }
}
classRegistry.setClass(BoardNotebook);

export const createBoardNotebook = (options = {}) => new BoardNotebook(options);

export function setNotebookPage(notebook, page, options = {}) {
  return navigateNotebookPage(notebook, page, options);
}

// Separating-axis polygon test also handles rotated notebooks and thin paths.
function polygonsOverlap(a, b) {
  for (const polygon of [a, b]) for (let index = 0; index < polygon.length; index++) {
    const p = polygon[index], q = polygon[(index + 1) % polygon.length];
    const axis = { x: -(q.y - p.y), y: q.x - p.x };
    if (Math.abs(axis.x) + Math.abs(axis.y) < 1e-12) continue;
    const projection = (points) => points.map((point) => point.x * axis.x + point.y * axis.y);
    const aa = projection(a), bb = projection(b);
    if (Math.max(...aa) <= Math.min(...bb) || Math.max(...bb) <= Math.min(...aa)) return false;
  }
  return true;
}

export function notebookObjectIntersection(notebook, object) {
  const inverse = util.invertTransform(notebook.calcTransformMatrix());
  const points = object.getCoords().map((point) => point.transform(inverse));
  const w = notebook.width / 2, h = notebook.height / 2;
  const corners = [new Point(-w, -h), new Point(w, -h), new Point(w, h), new Point(-w, h)];
  return { intersects: polygonsOverlap(points, corners), contained: points.every((p) => p.x >= -w && p.x <= w && p.y >= -h && p.y <= h) };
}

const containedPlacementKeys = ['left', 'top', 'originX', 'originY', 'angle', 'scaleX', 'scaleY', 'skewX', 'skewY', 'flipX', 'flipY'];

/** Prepare a fresh whole stroke without cloning/reviving its geometry. The live
 * source is only borrowed here: caller must enqueue before changing its identity
 * or group. Every clipped/published/effect-bearing object keeps the general path.
 */
export function prepareContainedNotebookStroke(notebook, object, {
  published = false, pageNumber = notebook?.notebookPageNumber,
} = {}) {
  if (!isBoardNotebook(notebook) || published || pageNumber !== notebook.notebookPageNumber
    || String(object?.type).toLowerCase() !== 'path' || object.group || object.clipPath || object.shadow
    || object.visible === false || !(object.opacity > 0) || object.isEraserPath || object.pendingImage
    || object.globalCompositeOperation && object.globalCompositeOperation !== 'source-over'
    || object.fill && typeof object.fill !== 'string' || object.stroke && typeof object.stroke !== 'string') return null;
  const world = object.calcTransformMatrix(), parent = notebook.calcTransformMatrix();
  if (!world.every(Number.isFinite) || !parent.every(Number.isFinite)
    || Math.abs(parent[0] * parent[3] - parent[1] * parent[2]) < 1e-12
    || !notebookObjectIntersection(notebook, object).contained) return null;
  const local = util.multiplyTransformMatrices(util.invertTransform(parent), world);
  const placementObject = new FabricObject({ originX: 'center', originY: 'center' });
  try {
    util.applyTransformToObject(placementObject, local);
    const placement = Object.fromEntries(containedPlacementKeys.map(key => [key, placementObject[key]]));
    const rounded = placementObject.toObject();
    const record = { ...object.toObject(childFields),
      ...Object.fromEntries(containedPlacementKeys.map(key => [key, rounded[key]])), boardObjectId: randomToken(14) };
    return { inside: object, outside: null, split: false, reusesSource: true, placement, record };
  } finally { placementObject.dispose(); }
}

const containsCutMask = object => Boolean(object.clipPath || object.getObjects?.().some(containsCutMask));

/** Prepare physically independent fragments before changing source/history. */
export async function captureNotebookObject(notebook, object, options = {}) {
  if (!isBoardNotebook(notebook) || !object || object.visible === false || object.opacity <= 0
    || isBoardNotebook(object) || ['gif', 'pdf'].includes(object.mediaKind)) return null;
  const { intersects, contained } = notebookObjectIntersection(notebook, object);
  if (!intersects) return null;
  const scope=createNotebookSplitScope([options.signal,notebookPageSplitSignal(notebook)],options.isCurrent);
  let prepared=null, inside=null, outside=null;
  try {
    checkNotebookSplit(scope);
    const sourceMatrix=object.calcTransformMatrix().slice();
    prepared=await object.clone(childFields); inside=prepared;
    checkNotebookSplit(scope);
    util.applyTransformToObject(prepared,sourceMatrix);
    const materializeMasks=containsCutMask(prepared);
    if (!contained || materializeMasks) {
      const { splitNotebookFragments } = await import('./notebookSplitFragments.js');
      checkNotebookSplit(scope);
      const fragments=await splitNotebookFragments(notebook,prepared,scope);
      if (!fragments.inside) { prepared.dispose(); prepared=inside=null; return null; }
      outside=fragments.outside;
      if (!outside && !materializeMasks) fragments.inside.dispose();
      else {inside=fragments.inside;prepared.dispose();prepared=null;}
    }
    checkNotebookSplit(scope);
    inside.boardObjectId=randomToken(14);
    util.applyTransformToObject(inside,util.multiplyTransformMatrices(util.invertTransform(notebook.calcTransformMatrix()),inside.calcTransformMatrix()));
    inert(inside);inside.setCoords();outside?.setCoords();
    return {inside,outside,split:Boolean(outside)};
  } catch(error) {
    inside?.dispose();outside?.dispose();if(prepared && prepared!==inside)prepared.dispose();throw error;
  } finally {scope.dispose();}
}
