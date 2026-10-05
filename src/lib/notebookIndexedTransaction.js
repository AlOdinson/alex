import { indexedBoardModelFor } from './indexedBoardModel.js';
import { evaluateAuthorityAction } from './authorityOperationEvaluator.js';
import { prepareAuthoritativeHistory } from './historyOperations.js';
import { applyAuthorityOpsInPlace } from './authoritySnapshot.js';
import { notebookChildKey } from './notebookOperations.js';

// Narrow, checked fast path: child edits do not change top-level order. Retiring
// an unpublished stroke also does not remove a canonical top-level record. A
// published source, frame edit, insertion/reorder, or unsafe old layout MUST use
// the structural reducer. Do not simulate absolute layer indices in a small list.
function scopeFor(snapshot, operations) {
  const model = indexedBoardModelFor(snapshot);
  if (!model?.supportsStableOrder || !Array.isArray(operations)) return null;
  const ids = new Set();
  for (const operation of operations) {
    if (operation?.type === 'notebook') ids.add(String(operation.id));
    else if (operation?.type !== 'delete' || !operation.id || model.read(operation.id)) return null;
  }
  return { model, snapshot: model.scope(ids) };
}
function selectedTombstones(source, keys) {
  const selected = Object.create(null);
  for (const key of keys) if (Object.hasOwn(source ?? {}, key)) selected[key] = source[key];
  return selected;
}

export function prepareIndexedNotebookAction(input, { history = false } = {}) {
  const scope = scopeFor(input.snapshot, input.ops);
  if (!scope) return null;
  const parentKeys = [], childKeys = [];
  for (const op of input.ops) {
    if (op.type === 'delete') parentKeys.push(String(op.id));
    if (op.type === 'notebook') for (const change of op.changes ?? []) {
      childKeys.push(notebookChildKey(op.id, op.pageNumber, change.object?.boardObjectId ?? change.id));
    }
  }
  const evaluation = evaluateAuthorityAction({ ...input, snapshot: scope.snapshot,
    tombstones: selectedTombstones(input.tombstones, parentKeys),
    notebookTombstones: selectedTombstones(input.notebookTombstones, childKeys),
  });
  return { evaluation, history: history
    ? prepareAuthoritativeHistory(scope.snapshot, evaluation.appliedOps, evaluation.appliedBackground, input) : null };
}

export function applyIndexedNotebookOps(snapshot, operations, background = null) {
  const scope = scopeFor(snapshot, operations);
  if (!scope) return null;
  // Run the same canonical child reducer, including timestamps and validation.
  // It receives only addressed frames. Source tombstones are handled separately
  // by the existing state/persistence owner, not silently discarded here.
  applyAuthorityOpsInPlace(scope.snapshot, operations, background);
  return scope.model.replace(scope.snapshot.canvas.objects, scope.snapshot).snapshot;
}
