import { freezeNotebookRecord, freezeNotebookRecordSteps } from './notebookRecords.js';

// Internal, immutable model. An ordinary notebook child edit changes a record,
// not the top-level layer order. Share that order's ID/rank map and copy only the
// O(log N) tree path to the changed record. Structural edits use the legacy
// reducer and construct a new layout explicitly; no unbounded overlay chains.
const models = new WeakMap();
const node = (left, right, record) => Object.freeze({ left, right, record });
function build(objects, start, end) {
  if (start === end) return null;
  if (end - start === 1) return node(null, null, freezeNotebookRecord(objects[start]));
  const middle = start + Math.floor((end - start) / 2);
  return node(build(objects, start, middle), build(objects, middle, end));
}
function at(root, rank, start, end) {
  if (!root || rank < start || rank >= end) return undefined;
  if (end - start === 1) return root.record;
  const middle = start + Math.floor((end - start) / 2);
  return rank < middle ? at(root.left, rank, start, middle) : at(root.right, rank, middle, end);
}
function replace(root, rank, value, start, end) {
  if (end - start === 1) return root.record === value ? root : node(null, null, freezeNotebookRecord(value));
  const middle = start + Math.floor((end - start) / 2);
  const left = rank < middle ? replace(root.left, rank, value, start, middle) : root.left;
  const right = rank < middle ? root.right : replace(root.right, rank, value, middle, end);
  return left === root.left && right === root.right ? root : node(left, right);
}
function flatten(root, output) {
  if (!root) return;
  if (!root.left && !root.right) { output.push(root.record); return; }
  flatten(root.left, output); flatten(root.right, output);
}
function changed(left, right, output) {
  if (left === right) return;
  if (!left.left && !left.right) { output.add(String(right.record?.boardObjectId)); return; }
  changed(left.left, right.left, output); changed(left.right, right.right, output);
}
function version(root, layout, metadata, canvasMetadata) {
  let materialized;
  const snapshot = Object.freeze({ ...metadata, canvas: Object.freeze({ ...canvasMetadata,
    // Legacy checkpoint/export boundary. Reading the model, its revision or an
    // addressed record never evaluates this getter. JSON/structuredClone still
    // produce the exact ordinary array-based wire format.
    get objects() {
      if (!materialized) { const output = []; flatten(root, output); materialized = Object.freeze(output); }
      return materialized;
    },
  }) });
  const model = Object.freeze({
    snapshot, size: layout.size, supportsStableOrder: layout.safe,
    read(id) { return this.at(this.rankOf(id)); },
    readRecord(id) { const zIndex = this.rankOf(id); return zIndex < 0 ? undefined : { object: this.at(zIndex), zIndex }; },
    rankOf(id) { return layout.ranks.get(String(id)) ?? -1; },
    at(rank) { return Number.isSafeInteger(rank) ? at(root, rank, 0, layout.size) : undefined; },
    keys() { return layout.ranks.keys(); },
    get keyCount() { return layout.ranks.size; },
    readPage(id, pageNumber) { return this.read(id)?.notebookPages?.[pageNumber - 1]; },
    fork() { return this; },
    scope(ids) {
      const objects = [];
      for (const id of new Set(ids)) { const object = this.read(id); if (object) objects.push(object); }
      return { ...metadata, canvas: { ...canvasMetadata, objects } };
    },
    replace(records, patch = {}) {
      let next = root;
      for (const record of records) {
        const rank = this.rankOf(record?.boardObjectId);
        if (rank < 0) throw new Error('A structural board edit requires the structural reducer');
        next = replace(next, rank, record, 0, layout.size);
      }
      // Do not copy a lazy canvas or expose a metadata field that can override it.
      const { canvas: ignoredCanvas, ...metadataPatch } = patch;
      const metadataChanged = Object.keys(metadataPatch).some(key => !Object.is(metadata[key], metadataPatch[key]));
      return next === root && !metadataChanged ? this : version(next, layout, { ...metadata, ...metadataPatch }, canvasMetadata);
    },
    serializeSnapshot() { return { ...metadata, canvas: { ...canvasMetadata, objects: snapshot.canvas.objects } }; },
  });
  models.set(snapshot, { model, root, layout });
  return model;
}

// Called at an owned load/recovery boundary. Callers clone external input first;
// this freezes internal records once, never trusts a caller's shallow freeze.
export function createIndexedBoardModel(snapshot) {
  const prior = models.get(snapshot); if (prior) return prior.model;
  if (!snapshot || !Array.isArray(snapshot.canvas?.objects)) throw new TypeError('Indexed board model requires a snapshot');
  const { canvas, ...metadata } = snapshot;
  const { objects, ...canvasMetadata } = canvas;
  const ranks = new Map(); let safe = true;
  for (let i = 0; i < objects.length; i++) {
    const id = objects[i]?.boardObjectId;
    if (String(objects[i]?.type).toLowerCase() === 'activeselection') safe = false;
    if (!id) continue;
    if (ranks.has(String(id))) safe = false;
    ranks.set(String(id), i);
  }
  return version(build(objects, 0, objects.length), { ranks, size: objects.length, safe }, metadata, canvasMetadata);
}
export const indexedBoardModelFor = snapshot => models.get(snapshot)?.model;

export function readSnapshotRecord(snapshot, id) {
  const model = indexedBoardModelFor(snapshot);
  if (model) return model.readRecord(id);
  // Compatibility for old adapters/tests and an explicitly loaded checkpoint.
  const objects = snapshot?.canvas?.objects ?? [];
  for (let zIndex = objects.length - 1; zIndex >= 0; zIndex--) {
    if (String(objects[zIndex]?.boardObjectId) === String(id)) return { object: objects[zIndex], zIndex };
  }
  return undefined;
}

// null means a structural/load boundary: caller must compare full layouts.
// Ordinary forks sharing a layout compare tree branches, never whole arrays.
export function changedSnapshotObjectIds(before, after) {
  if (before === after) return new Set();
  const a = models.get(before), b = models.get(after);
  if (!a || !b || a.layout !== b.layout || !a.layout.safe) return null;
  const ids = new Set();
  if (a.root !== b.root) changed(a.root, b.root, ids);
  return ids;
}

// Same balanced layout and read/replace implementation as the synchronous model;
// only initial construction is resumable. Callers own the detached input.
function* buildSteps(objects, start, end) {
  yield;
  if (start === end) return null;
  if (end - start === 1) return node(null, null, objects[start]);
  const middle = start + Math.floor((end - start) / 2);
  const left = yield* buildSteps(objects, start, middle);
  const right = yield* buildSteps(objects, middle, end);
  return node(left, right);
}
export function* createIndexedBoardModelSteps(snapshot) {
  const prior = models.get(snapshot); if (prior) return prior.model;
  if (!snapshot || !Array.isArray(snapshot.canvas?.objects)) throw new TypeError('Indexed board model requires a snapshot');
  const { canvas, ...metadata } = snapshot;
  const { objects, ...canvasMetadata } = canvas;
  yield* freezeNotebookRecordSteps(objects);
  const ranks = new Map(); let safe = true;
  for (let i = 0; i < objects.length; i++) {
    const id = objects[i]?.boardObjectId;
    if (String(objects[i]?.type).toLowerCase() === 'activeselection') safe = false;
    if (id) { if (ranks.has(String(id))) safe = false; ranks.set(String(id), i); }
    yield;
  }
  const root = yield* buildSteps(objects, 0, objects.length);
  return version(root, { ranks, size: objects.length, safe }, metadata, canvasMetadata);
}
