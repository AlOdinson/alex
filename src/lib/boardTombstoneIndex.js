import { freezeNotebookRecord } from './notebookRecords.js';

// Persistent AVL map: adding one deletion copies a logarithmic tree path, not
// all prior deletions. No growing prototype/overlay chain; old previews remain
// immutable. Only explicit load/export boundaries enumerate the complete table.
const indexes = new WeakSet();
const height = node => node?.height ?? 0;
const size = node => node?.size ?? 0;
const node = (key, value, left = null, right = null) => Object.freeze({ key, value, left, right,
  height: 1 + Math.max(height(left), height(right)), size: 1 + size(left) + size(right) });
function rotateLeft(root) {
  const next = root.right;
  return node(next.key, next.value, node(root.key, root.value, root.left, next.left), next.right);
}
function rotateRight(root) {
  const next = root.left;
  return node(next.key, next.value, next.left, node(root.key, root.value, next.right, root.right));
}
function balanced(root) {
  const difference = height(root.left) - height(root.right);
  if (difference > 1) {
    if (height(root.left.left) < height(root.left.right)) root = node(root.key, root.value, rotateLeft(root.left), root.right);
    return rotateRight(root);
  }
  if (difference < -1) {
    if (height(root.right.right) < height(root.right.left)) root = node(root.key, root.value, root.left, rotateRight(root.right));
    return rotateLeft(root);
  }
  return root;
}
function put(root, key, value) {
  if (!root) return node(key, value);
  if (key === root.key) return Object.is(value, root.value) ? root : node(key, value, root.left, root.right);
  return balanced(key < root.key ? node(root.key, root.value, put(root.left, key, value), root.right)
    : node(root.key, root.value, root.left, put(root.right, key, value)));
}
function remove(root, key) {
  if (!root) return root;
  if (key === root.key) {
    if (!root.left) return root.right;
    if (!root.right) return root.left;
    let next = root.right; while (next.left) next = next.left;
    return balanced(node(next.key, next.value, root.left, remove(root.right, next.key)));
  }
  const left = key < root.key ? remove(root.left, key) : root.left;
  const right = key > root.key ? remove(root.right, key) : root.right;
  return left === root.left && right === root.right ? root : balanced(node(root.key, root.value, left, right));
}
function* entries(root) {
  if (!root) return;
  yield* entries(root.left); yield [root.key, root.value]; yield* entries(root.right);
}
function fromSorted(values, start, end) {
  if (start >= end) return null;
  const middle = start + Math.floor((end - start) / 2), [key, value] = values[middle];
  return node(key, freezeNotebookRecord(structuredClone(value)), fromSorted(values, start, middle), fromSorted(values, middle + 1, end));
}
function version(root) {
  const api = Object.freeze({ size: size(root),
    get(input) { const key = String(input); let current = root;
      while (current) { if (key === current.key) return current.value; current = key < current.key ? current.left : current.right; }
      return undefined;
    },
    fork() { return this; },
    applyDelta(delta) {
      if (!Array.isArray(delta)) throw new TypeError('Tombstone delta must be an array');
      let next = root;
      for (const change of delta) {
        if (!change || typeof change.id !== 'string' || !change.id) throw new TypeError('Tombstone identity is required');
        if (change.type === 'delete') next = remove(next, change.id);
        else if (change.type === 'set') next = put(next, change.id, freezeNotebookRecord(structuredClone(change.value)));
        else throw new TypeError('Unknown tombstone delta');
      }
      return next === root ? this : version(next);
    },
    serialize() { return structuredClone(Object.fromEntries(entries(root))); },
  });
  indexes.add(api); return api;
}
export function createBoardTombstoneIndex(records = {}) {
  if (indexes.has(records)) return records;
  if (!records || typeof records !== 'object' || Array.isArray(records)) throw new TypeError('Tombstone records must be an object');
  const ordered = Object.entries(records).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  return version(fromSorted(ordered, 0, ordered.length));
}
export function readBoardTombstone(source, id) {
  return indexes.has(source) ? source.get(id) : Object.hasOwn(source ?? {}, String(id)) ? source[String(id)] : undefined;
}
export function boardTombstoneDelta(operations, context = {}) {
  const delta = [];
  for (const operation of Array.isArray(operations) ? operations : []) {
    if (operation?.type === 'delete' && operation.id) delta.push({type:'set', id:String(operation.id), value:{
      clientId: String(context.clientId ?? ''), actionId: String(context.actionId ?? ''),
      mutationId: String(operation.mutationId ?? context.actionId ?? ''), revision: Number(context.revision ?? 0),
    }});
    else if (operation?.type === 'upsert' && operation.object?.boardObjectId) delta.push({type:'delete', id:String(operation.object.boardObjectId)});
  }
  return delta;
}
export function applyBoardTombstoneOperations(source, operations, context) {
  return createBoardTombstoneIndex(source).applyDelta(boardTombstoneDelta(operations, context));
}
