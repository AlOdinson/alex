// Cooperative boundaries, NOT preemption of a single Fabric call. A one-shot
// task marker forgets the current burst when control returns to the event loop,
// so waiting for an image/lease is not charged as consecutive preparation work.
const SLICE_MS = 4;
const MAX_UNITS = 32;
export function createNotebookWorkSlice() {
  let started = null, units = 0, marker = null;
  const reset = () => {
    if (marker !== null) clearTimeout(marker);
    marker = null; started = null; units = 0;
  };
  const begin = () => {
    started = performance.now(); units = 0;
    marker = setTimeout(() => { marker = null; started = null; units = 0; }, 0);
  };
  return {
    beforeWork() {
      if (started !== null && (units >= MAX_UNITS || performance.now() - started >= SLICE_MS)) {
        reset();
        return new Promise(resolve => setTimeout(() => { begin(); units++; resolve(); }, 0));
      }
      if (started === null) begin();
      units++;
      return null; // the first short job does not wait for another browser task
    },
    reset,
  };
}

const tails = new WeakMap();
export const notebookWorkCancelled = () => Object.assign(
  new Error('Доска или страница закрыта; подготовка отменена'), { code: 'notebook_work_cancelled' },
);
export const isNotebookWorkCancelled = error => error?.code === 'notebook_work_cancelled';

/** Keep the existing Promise-tail barrier: never drop or reorder user intents.
 * Budgets are shared only by one tail family; independent notebooks do not wait
 * for each other's asynchronous jobs. Callers recheck their lifetime after yield.
 */
export function queueNotebookWork(previous, work, isCurrent = () => true) {
  let state = tails.get(previous);
  if (!state) state = { slice: createNotebookWorkSlice(), pending: 0 };
  state.pending++;
  const task = previous.catch(() => undefined).then(async () => {
    if (!isCurrent()) throw notebookWorkCancelled();
    const pause = state.slice.beforeWork();
    if (pause) await pause;
    if (!isCurrent()) throw notebookWorkCancelled();
    return work();
  }).finally(() => { if (--state.pending === 0) state.slice.reset(); });
  tails.set(task, state);
  return task;
}
