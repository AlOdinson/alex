import { isNotebookPageIndex, knownNotebookPageIndex } from './notebookPageModel.js';
import { isImmutableNotebookRecord } from './notebookRecords.js';

// A proof produced only by the canonical page reducer. Both keys are weak:
// retaining the newest page must NOT retain all earlier copied page arrays.
// Unrelated checkpoints and multi-step/rebased pages fall back to full diff.
const appends = new WeakMap();
const key = value => knownNotebookPageIndex(value) ?? value;
const immutable = value => isNotebookPageIndex(value) || isImmutableNotebookRecord(value);
export function rememberNotebookPageAppend(before, after) {
  before = key(before); after = key(after);
  if (!immutable(before) || !immutable(after)
    || after.length !== before.length + 1) return;
  let next = appends.get(before);
  if (!next) { next = new WeakMap(); appends.set(before, next); }
  next.set(after, Object.freeze({ record: isNotebookPageIndex(after) ? after.at(before.length) : after[before.length], index: before.length }));
}
export function notebookPageAppend(before, after) {
  return before && after ? appends.get(key(before))?.get(key(after)) ?? null : null;
}
