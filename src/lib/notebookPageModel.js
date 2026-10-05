import { freezeNotebookRecord, isImmutableNotebookRecord, createLazyNotebookPages } from './notebookRecords.js';

// Two persistent AVL trees: layer key -> immutable child and identity -> layer
// key. Edits copy O(log N) paths; no version retains a chain of old page arrays.
// Ordinary arrays remain the import/export contract, materialized on demand.
const models = new WeakSet(), arrays = new WeakMap(), readers = new WeakMap(), trees = new WeakMap();
const EMPTY = freezeNotebookRecord([]);
const height = n => n?.height ?? 0, size = n => n?.size ?? 0;
const node = (key, value, left = null, right = null) => Object.freeze({ key, value, left, right,
  height: 1 + Math.max(height(left), height(right)), size: 1 + size(left) + size(right) });
function rotateLeft(root) {
  const r = root.right;
  return node(r.key, r.value, node(root.key, root.value, root.left, r.left), r.right);
}
function rotateRight(root) {
  const l = root.left;
  return node(l.key, l.value, l.left, node(root.key, root.value, l.right, root.right));
}
function balance(root) {
  const delta = height(root.left) - height(root.right);
  if (delta > 1) {
    if (height(root.left.left) < height(root.left.right)) root = node(root.key, root.value, rotateLeft(root.left), root.right);
    return rotateRight(root);
  }
  if (delta < -1) {
    if (height(root.right.right) < height(root.right.left)) root = node(root.key, root.value, root.left, rotateRight(root.right));
    return rotateLeft(root);
  }
  return root;
}
function put(root, key, value) {
  if (!root) return node(key, value);
  if (key === root.key) return root.value === value ? root : node(key, value, root.left, root.right);
  return balance(key < root.key ? node(root.key, root.value, put(root.left, key, value), root.right)
    : node(root.key, root.value, root.left, put(root.right, key, value)));
}
function remove(root, key) {
  if (!root) return root;
  if (key === root.key) {
    if (!root.left) return root.right;
    if (!root.right) return root.left;
    let successor = root.right; while (successor.left) successor = successor.left;
    return balance(node(successor.key, successor.value, root.left, remove(root.right, successor.key)));
  }
  const left = key < root.key ? remove(root.left, key) : root.left;
  const right = key > root.key ? remove(root.right, key) : root.right;
  return left === root.left && right === root.right ? root : balance(node(root.key, root.value, left, right));
}
function find(root, key) {
  while (root) { if (key === root.key) return root; root = key < root.key ? root.left : root.right; }
  return null;
}
function at(root, index) {
  if (!Number.isSafeInteger(index) || index < 0 || index >= size(root)) return null;
  while (root) {
    const left = size(root.left);
    if (index === left) return root;
    if (index < left) root = root.left;
    else { index -= left + 1; root = root.right; }
  }
  return null;
}
function rank(root, key) {
  let offset = 0;
  while (root) {
    if (key === root.key) return offset + size(root.left);
    if (key < root.key) root = root.left;
    else { offset += size(root.left) + 1; root = root.right; }
  }
  return -1;
}
function flatten(root, output) {
  if (!root) return;
  flatten(root.left, output); output.push(root.value); flatten(root.right, output);
}
function build(entries, start = 0, end = entries.length) {
  if (start >= end) return null;
  const mid = start + Math.floor((end - start) / 2), [key, value] = entries[mid];
  return node(key, value, build(entries, start, mid), build(entries, mid + 1, end));
}
function roots(records) {
  const order = [], ids = [], seen = new Set();
  for (let i = 0; i < records.length; i++) {
    const child = records[i], id = child?.boardObjectId;
    // Preserve the canonical legacy semantics for malformed/duplicate layouts.
    if (typeof id !== 'string' || !id || seen.has(id)) return null;
    seen.add(id); order.push([i, child]); ids.push([id, i]);
  }
  ids.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  return { order: build(order), ids: build(ids) };
}
function version(order, ids, materialized = null, family = {}) {
  const api = Object.freeze({ length: size(order),
    read(id) { const entry = find(ids, String(id)); return entry ? find(order, entry.value)?.value : undefined; },
    rankOf(id) { const entry = find(ids, String(id)); return entry ? rank(order, entry.value) : -1; },
    readRecord(id) { const index = this.rankOf(id); return index < 0 ? undefined : { child: this.at(index), index }; },
    at(index) { return at(order, index)?.value; },
    insert(record, index = size(order)) {
      if (!isImmutableNotebookRecord(record)) throw new TypeError('Indexed child must be owned and deeply immutable');
      const id = record.boardObjectId;
      if (typeof id !== 'string' || !id) throw new TypeError('Indexed child identity required');
      if (find(ids, id)) return this;
      index = Math.min(size(order), Math.max(0, index));
      if (!Number.isSafeInteger(index)) throw new TypeError('Integer child position required');
      const before = at(order, index - 1)?.key, after = at(order, index)?.key;
      const key = before == null ? (after == null ? 0 : after - 1) : after == null ? before + 1 : before / 2 + after / 2;
      if (!Number.isFinite(key) || before != null && key <= before || after != null && key >= after) {
        // Explicit rare structural fallback, only when repeated middle inserts
        // exhaust floating-point spacing. No ever-growing rational key strings.
        const records = []; flatten(order, records); records.splice(index, 0, record);
        const rebuilt = roots(records); return version(rebuilt.order, rebuilt.ids);
      }
      return version(put(order, key, record), put(ids, id, key), null, family);
    },
    patch(record) {
      if (!isImmutableNotebookRecord(record)) throw new TypeError('Indexed child must be owned and deeply immutable');
      const entry = find(ids, String(record.boardObjectId));
      if (!entry) return this;
      const next = put(order, entry.value, record);
      return next === order ? this : version(next, ids, null, family);
    },
    delete(id) {
      const entry = find(ids, String(id));
      return entry ? version(remove(order, entry.value), remove(ids, String(id)), null, family) : this;
    },
    materialize() {
      if (!materialized) {
        const records = []; flatten(order, records); materialized = freezeNotebookRecord(records);
        arrays.set(materialized, api);
      }
      return materialized;
    },
  });
  models.add(api); trees.set(api, { order, family }); if (materialized) arrays.set(materialized, api);
  return api;
}
export const isNotebookPageIndex = value => Boolean(value && models.has(value));
export const knownNotebookPageIndex = value => value && arrays.get(value) || null;
export function notebookPageState(pages, index) {
  const descriptor = Object.getOwnPropertyDescriptor(pages ?? [], String(index));
  if (descriptor?.get && readers.has(descriptor.get)) return readers.get(descriptor.get);
  const source = pages?.[index] ?? EMPTY;
  if (!Array.isArray(source) || !isImmutableNotebookRecord(source)) return source;
  if (arrays.has(source)) return arrays.get(source) || source;
  const tree = roots(source), model = tree ? version(tree.order, tree.ids, source) : null;
  arrays.set(source, model); return model ?? source;
}
export const notebookPageRecords = state => isNotebookPageIndex(state) ? state.materialize() : state;
export function installNotebookPageIndex(pages, index, model) {
  if (!isNotebookPageIndex(model)) throw new TypeError('Owned page index required');
  const read = () => model.materialize();
  const next = createLazyNotebookPages(pages, index, read);
  if (next) { readers.set(Object.getOwnPropertyDescriptor(next, String(index)).get, model); return next; }
  // Caller-owned/legacy siblings must not acquire an immutability certificate.
  const plain = pages.slice(); plain[index] = model.materialize(); return Object.freeze(plain);
}

// Confirmed and optimistic versions may be sibling forks with different stamps
// but shared old branches. Return only changed records when layer layouts match.
// Unknown imports, rotations with structural changes and relabels fall back; no
// probabilistic hash or unchecked assumption may suppress a visual edit.
export function notebookPageSameLayoutChanges(before, after) {
  const a = trees.get(before), b = trees.get(after);
  if (!a || !b || a.family !== b.family || before.length !== after.length) return null;
  const changes = [];
  function visit(left, right) {
    if (left === right) return true;
    if (!left || !right || left.key !== right.key) return false;
    if (left.value !== right.value) changes.push({ before: left.value, after: right.value, index: rank(b.order, right.key) });
    return visit(left.left, right.left) && visit(left.right, right.right);
  }
  return visit(a.order, b.order) ? changes : null;
}
