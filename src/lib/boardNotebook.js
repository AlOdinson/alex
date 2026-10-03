import { memoizeImmutableNotebookImage } from './notebookAssets.js';
import { navigateNotebookPage, retireNotebookPageWork } from './notebookPageRuntime.js';
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

  getPageObjects() { return this.getObjects(); }

  addPageObject(object) {
    memoizeImmutableNotebookImage(object);
    if (!object.boardObjectId) object.boardObjectId = randomToken(14);
    // Group.add accepts world coordinates; preserve the prepared local placement.
    const matrix = object.calcOwnMatrix();
    this.add(inert(object));
    util.applyTransformToObject(object, matrix);
    object.setCoords();
    this.syncPage({ invalidate: false });
    this.dirty = true;
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

  applyPreparedPageDelta(records, prepared, pages) {
    const previous = this.getPageObjects();
    const byId = new Map(previous.map(object => [String(object.boardObjectId), object]));
    const fresh = new Map(prepared.map(object => [String(object.boardObjectId), object]));
    const desired = records.map(record => fresh.get(String(record.boardObjectId)) ?? byId.get(String(record.boardObjectId)));
    if (desired.some(object => !object) || new Set(desired).size !== desired.length) {
      throw new Error('Notebook visible page differs from the delta baseline');
    }
    const retained = new Set(desired), removed = previous.filter(object => !retained.has(object));
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
    this.notebookPages = pages; this._pageContentInvalid = false; this.dirty = true;
  }

  invalidatePageContent(child) {
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

  releasePageCache() {
    this._pageRenderCache?.release(this);
    this._pageRenderCache = null;
    releaseSurface(this);
    releaseSurface(this.clipPath);
  }

  renderCache(options) {
    const cache = notebookRenderCacheFor(this.canvas);
    if (this._pageRenderCache !== cache) this.releasePageCache();
    this._pageRenderCache = cache;
    const wasDirty = this.dirty || !this._cacheCanvas;
    const previousZoomX = this.zoomX, previousZoomY = this.zoomY;
    super.renderCache(options);
    // Child masks were baked into the page. Keeping those bitmaps duplicates
    // page pixels and makes image-heavy pages grow without bound.
    if (wasDirty || previousZoomX !== this.zoomX || previousZoomY !== this.zoomY) this.getPageObjects().forEach(releaseChildSurfaces);
    cache?.acquire(this, { surfaces: [this._cacheCanvas, this.clipPath?._cacheCanvas].filter(Boolean),
      onEvict: () => {releaseSurface(this);releaseSurface(this.clipPath);this.dirty = true;} });
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
    if (shadow) notebook.shadow = (await util.enlivenObjectEnlivables({ shadow }, options)).shadow;
    const objects = await util.enlivenObjects(notebook.notebookPages[notebook.notebookPageNumber - 1] || [], options);
    notebook.replacePageObjects(objects, notebook.notebookPages[notebook.notebookPageNumber - 1]);
    notebook.setCoords();
    return notebook;
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

const containsCutMask = object => Boolean(object.clipPath || object.getObjects?.().some(containsCutMask));

/** Prepare physically independent fragments before changing source/history. */
export async function captureNotebookObject(notebook, object) {
  if (!isBoardNotebook(notebook) || !object || object.visible === false || object.opacity <= 0
    || isBoardNotebook(object) || ['gif', 'pdf'].includes(object.mediaKind)) return null;
  const { intersects, contained } = notebookObjectIntersection(notebook, object);
  if (!intersects) return null;
  const sourceMatrix = object.calcTransformMatrix().slice();
  const prepared = await object.clone(childFields);
  util.applyTransformToObject(prepared, sourceMatrix);
  let inside = prepared, outside = null;
  const materializeMasks = containsCutMask(prepared);
  try {
    if (!contained || materializeMasks) {
      // Keep the clipping engine out of empty notebooks and ordinary whole-object captures.
      const { splitNotebookFragments } = await import('./notebookSplitFragments.js');
      const fragments = await splitNotebookFragments(notebook, prepared);
      if (!fragments.inside) { prepared.dispose(); return null; }
      outside = fragments.outside;
      if (!outside && !materializeMasks) {
        // No visible paint was removed: text remains editable, not an image of whitespace.
        fragments.inside.dispose();
      } else { inside = fragments.inside; prepared.dispose(); }
    }
    inside.boardObjectId = randomToken(14);
    util.applyTransformToObject(inside, util.multiplyTransformMatrices(util.invertTransform(notebook.calcTransformMatrix()), inside.calcTransformMatrix()));
    inert(inside); inside.setCoords(); outside?.setCoords();
    return { inside, outside, split: Boolean(outside) };
  } catch (error) { inside?.dispose(); outside?.dispose(); if(inside!==prepared) prepared.dispose(); throw error; }
}
