import { isImmutableNotebookRecord } from './notebookRecords.js';

// A proof produced only by the canonical page reducer. Both keys are weak:
// retaining the newest page must NOT retain all earlier copied page arrays.
// Unrelated checkpoints and multi-step/rebased pages fall back to full diff.
const appends = new WeakMap();
export function rememberNotebookPageAppend(before, after) {
  if (!isImmutableNotebookRecord(before) || !isImmutableNotebookRecord(after)
    || after.length !== before.length + 1) return;
  let next = appends.get(before);
  if (!next) { next = new WeakMap(); appends.set(before, next); }
  next.set(after, Object.freeze({ record: after[before.length], index: before.length }));
}
export function notebookPageAppend(before, after) {
  return before && after ? appends.get(before)?.get(after) ?? null : null;
}
