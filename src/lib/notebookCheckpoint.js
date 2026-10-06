import { createNotebookWorkSlice, notebookWorkCancelled } from './notebookWorkScheduler.js';
import { createBoardTombstoneIndex, createBoardTombstoneIndexSteps } from './boardTombstoneIndex.js';
import { createIndexedBoardModel, createIndexedBoardModelSteps } from './indexedBoardModel.js';
import { freezeNotebookRecord, freezeNotebookRecordSteps, freezeSnapshotNotebookPages } from './notebookRecords.js';

// Only this module can certify a fully prepared checkpoint. A caller's shallow
// freeze, serialized flag, or cloned token must not bypass isolation/validation.
const prepared = new WeakMap();
const safeRevision = value => Number.isSafeInteger(value) && value >= 0;
function validate(value) {
  if (!safeRevision(value?.revision) || !Array.isArray(value?.snapshot?.canvas?.objects)) {
    throw new TypeError('Notebook session requires a snapshot and non-negative integer revision');
  }
}
function seal(snapshot) {
  snapshot.canvas.objects.forEach(Object.freeze);
  Object.freeze(snapshot.canvas.objects); Object.freeze(snapshot.canvas); return Object.freeze(snapshot);
}

// Synchronous compatibility path for existing callers and live rebase. Native
// structuredClone remains the snapshot-at-call boundary for external mutable data.
export function notebookCheckpoint(value) {
  const trusted = prepared.get(value); if (trusted) return trusted;
  validate(value);
  const copy = structuredClone(value);
  freezeSnapshotNotebookPages(copy.snapshot);
  copy.snapshot.canvas.objects.filter(object => !Array.isArray(object.notebookPages)).forEach(object => freezeNotebookRecord(object));
  return { revision: copy.revision, snapshot: createIndexedBoardModel(seal(copy.snapshot)).snapshot,
    tombstones: createBoardTombstoneIndex(copy.tombstones ?? {}), notebookTombstones: copy.notebookTombstones ?? {} };
}

function* prepareSteps(copy) {
  // Children of hidden pages stay serialized. Freezing/indexing creates no Fabric
  // objects and never enumerates a lazy page during the ordinary edit path.
  yield* freezeNotebookRecordSteps(copy.snapshot.canvas.objects);
  const model = yield* createIndexedBoardModelSteps(copy.snapshot);
  const deleted = copy.tombstones ?? {};
  yield* freezeNotebookRecordSteps(deleted);
  const tombstones = yield* createBoardTombstoneIndexSteps(deleted);
  const notebookTombstones = copy.notebookTombstones ?? {};
  yield* freezeNotebookRecordSteps(notebookTombstones);
  yield* freezeNotebookRecordSteps(copy.acknowledgedActionIds);
  const state = Object.freeze({ revision: copy.revision, snapshot: model.snapshot, tombstones, notebookTombstones });
  const token = Object.freeze({ ...copy, snapshot: model.snapshot });
  prepared.set(token, state);
  return token;
}

/** Freeze and index between bounded chunks of graph/tree steps. One property
 * access, native clone, Object.freeze or AVL insertion is still indivisible.
 * By default capture the external value NOW, not partly before/after a yield.
 * takeOwnership is reserved for a freshly isolated runtime checkpoint returned
 * exclusively to the cold Board loader; it avoids a second complete clone.
 */
export async function prepareNotebookCheckpoint(value, { signal, isCurrent = () => true, takeOwnership = false } = {}) {
  const check = () => {
    if (signal?.aborted) throw signal.reason ?? new DOMException('Checkpoint preparation aborted', 'AbortError');
    if (!isCurrent()) throw notebookWorkCancelled();
  };
  check();
  if (prepared.has(value)) return value;
  validate(value);
  const copy = takeOwnership ? value : structuredClone(value);
  const steps = prepareSteps(copy), slice = createNotebookWorkSlice();
  try {
    for (;;) {
      const pause = slice.beforeWork(); if (pause) await pause;
      check();
      for (let i = 0; i < 128; i++) {
        const step = steps.next();
        if (step.done) { check(); return step.value; }
      }
    }
  } finally { slice.reset(); steps.return(); }
}

/** Cold acquisition only. Runtime getters return fresh detached snapshots. If
 * revision changes during preparation, discard the draft. Bounded retries avoid
 * starvation under continuous traffic; the last read uses the old synchronous
 * session boundary instead. Board MUST recheck revision immediately after await
 * and before construction, closing the final microtask handoff window.
 */
export async function readStableNotebookCheckpoint({ readCheckpoint, readRevision, isCurrent = () => true, signal } = {}) {
  if (typeof readCheckpoint !== 'function') throw new TypeError('Checkpoint reader is required');
  for (let attempt = 0; attempt < 3; attempt++) {
    if (!isCurrent()) throw notebookWorkCancelled();
    const source = readCheckpoint();
    if (!source) throw new Error('Подтверждённое состояние блокнота ещё не загружено');
    const token = await prepareNotebookCheckpoint(source, { takeOwnership: true, isCurrent, signal });
    if (!isCurrent()) throw notebookWorkCancelled();
    const revision = readRevision?.();
    if (!safeRevision(revision) || revision === token.revision) return token;
  }
  if (!isCurrent()) throw notebookWorkCancelled();
  if (signal?.aborted) throw signal.reason ?? new DOMException('Checkpoint preparation aborted', 'AbortError');
  const latest = readCheckpoint(); validate(latest); return latest;
}
