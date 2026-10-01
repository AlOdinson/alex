import { randomToken } from './ids.js';
import { Group, Rect, FabricImage, FabricObject, LayoutManager, FixedLayout, Point, classRegistry, controlsUtils, util } from 'fabric';

export const NOTEBOOK_FIELDS = ['notebookPages', 'notebookPageNumber'];
export const isBoardNotebook = (object) => String(object?.type).toLowerCase() === 'boardnotebook';
const childFields = ['id', 'shapeType', 'boardObjectId', 'objectKind', 'storagePath', 'isEraserPath', 'updatedAt', 'updatedBy'];
const inert = (object) => object.set({ selectable: false, evented: false });

/** Only the visible page is enlivened; all other pages remain durable JSON. */
export class BoardNotebook extends Group {
  static type = 'BoardNotebook';

  constructor(options = {}) {
    const { notebookPages = [[]], notebookPageNumber = 1, objects: ignoredObjects, layoutManager: ignoredLayout, type: ignoredType, ...frame } = options;
    super([], { width: 520, height: 480, originX: 'left', originY: 'top', backgroundColor: '#ffffff', strokeWidth: 0, ...frame,
      layoutManager: new LayoutManager(new FixedLayout()), subTargetCheck: false,
      lockScalingFlip: true, lockRotation: true });
    this.notebookPages = notebookPages.length ? notebookPages : [[]];
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
    if (!object.boardObjectId) object.boardObjectId = randomToken(14);
    // Group.add accepts world coordinates; preserve the prepared local placement.
    const matrix = object.calcOwnMatrix();
    this.add(inert(object));
    util.applyTransformToObject(object, matrix);
    object.setCoords();
    this.syncPage();
    this.dirty = true;
    return object;
  }

  syncPage() {
    const objects = this.getPageObjects();
    if (objects.length || this.notebookPageNumber <= this.notebookPages.length) {
      while (this.notebookPages.length < this.notebookPageNumber) this.notebookPages.push([]);
      this.notebookPages[this.notebookPageNumber - 1] = objects.map((object) => object.toObject(childFields));
    }
    this.dirty = true;
    return this.notebookPages;
  }

  toObject(propertiesToInclude = []) {
    this.syncPage();
    // FabricObject serialization avoids a second copy under Group.objects.
    const result = FabricObject.prototype.toObject.call(this, propertiesToInclude.filter((key) => !NOTEBOOK_FIELDS.includes(key)));
    delete result.clipPath;
    return { ...result, notebookPages: this.notebookPages.map((page) => page.map((object) => structuredClone(object))), notebookPageNumber: this.notebookPageNumber };
  }

  static async fromObject(serialized, options = {}) {
    const { clipPath, shadow, ...frame } = serialized;
    const notebook = new BoardNotebook(frame);
    if (shadow) notebook.shadow = (await util.enlivenObjectEnlivables({ shadow }, options)).shadow;
    const objects = await util.enlivenObjects(notebook.notebookPages[notebook.notebookPageNumber - 1] || [], options);
    for (const object of objects) notebook.addPageObject(object);
    notebook.setCoords();
    return notebook;
  }
}
classRegistry.setClass(BoardNotebook);

export const createBoardNotebook = (options = {}) => new BoardNotebook(options);

export async function setNotebookPage(notebook, page) {
  if (!isBoardNotebook(notebook) || !Number.isInteger(page) || page < 1 || page > Math.max(notebook.notebookPageNumber, notebook.notebookPages.length) + 1) return false;
  if (page === notebook.notebookPageNumber) return true;
  notebook.syncPage();
  const objects = await util.enlivenObjects(notebook.notebookPages[page - 1] || []);
  notebook.remove(...notebook.getPageObjects());
  notebook.notebookPageNumber = page;
  for (const object of objects) notebook.addPageObject(object);
  notebook.dirty = true;
  notebook.canvas?.requestRenderAll();
  return true;
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

function addBoundaryClip(object, notebook, worldMatrix, inverted) {
  const clip = new Rect({ width: notebook.width, height: notebook.height, originX: 'center', originY: 'center', strokeWidth: 0, inverted });
  util.applyTransformToObject(clip, util.multiplyTransformMatrices(util.invertTransform(worldMatrix), notebook.calcTransformMatrix()));
  if (object.clipPath?.absolutePositioned) {
    util.applyTransformToObject(object.clipPath, util.multiplyTransformMatrices(util.invertTransform(worldMatrix), object.clipPath.calcOwnMatrix()));
    object.clipPath.absolutePositioned = false;
  }
  object.clipPath = object.clipPath ? util.mergeClipPaths(object.clipPath, clip) : clip;
}

/** Prepare both fragments before the caller changes the board/history. */
export async function captureNotebookObject(notebook, object) {
  if (!isBoardNotebook(notebook) || !object || isBoardNotebook(object) || ['gif', 'pdf'].includes(object.mediaKind)) return null;
  const { intersects, contained } = notebookObjectIntersection(notebook, object);
  if (!intersects) return null;
  let prepared = await object.clone(childFields);
  util.applyTransformToObject(prepared, object.calcTransformMatrix());
  const split = !contained;
  if (split && ['text', 'i-text', 'textbox'].includes(String(object.type).toLowerCase())) {
    const center = prepared.getCenterPoint();
    const bitmap = prepared.toCanvasElement({ enableRetinaScaling: false });
    prepared = new FabricImage(bitmap, { left: center.x, top: center.y, originX: 'center', originY: 'center' });
  }
  const worldMatrix = prepared.calcTransformMatrix();
  const inside = prepared;
  inside.boardObjectId = randomToken(14);
  const outside = split ? await prepared.clone(childFields) : null;
  if (outside) util.applyTransformToObject(outside, worldMatrix);
  if (split) {
    addBoundaryClip(inside, notebook, worldMatrix, false);
    addBoundaryClip(outside, notebook, worldMatrix, true);
  }
  util.applyTransformToObject(inside, util.multiplyTransformMatrices(util.invertTransform(notebook.calcTransformMatrix()), worldMatrix));
  inert(inside);
  inside.setCoords();
  outside?.setCoords();
  return { inside, outside, split };
}
