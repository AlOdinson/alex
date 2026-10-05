import { classRegistry } from 'fabric';
import { createNotebookWorkSlice, notebookWorkCancelled } from './notebookWorkScheduler.js';

// Bound how much eager Fabric construction may start before a cooperative
// checkpoint. One complex child (including a nested group) is still indivisible.
const CONSTRUCTION_BATCH = 8;
const release = object => { try { object?.dispose?.(); } catch { /* best-effort cleanup of detached work */ } };
const abortReason = signal => signal.reason ?? new DOMException('Preparation aborted', 'AbortError');
function abortable(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) { promise.catch(() => {}); return Promise.reject(abortReason(signal)); }
  return new Promise((resolve, reject) => {
    const abort = () => reject(abortReason(signal));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** Prepare detached children in order, yielding BETWEEN bounded batches.
 * Never attach a partial page. All successful objects, including those resolving
 * after abort and those following a failed sibling, remain owned until delivery.
 * Independent calls have independent budgets and never await each other's I/O.
 */
export async function enlivenNotebookObjects(records, options = {}, isCurrent = () => true) {
  const slice = createNotebookWorkSlice(), owned = new Set(), output = [];
  const { signal, reviver } = options;
  let abandoned = false;
  const check = () => {
    if (signal?.aborted) throw abortReason(signal);
    if (!isCurrent()) throw notebookWorkCancelled();
  };
  try {
    check();
    for (let offset = 0; offset < records.length; offset += CONSTRUCTION_BATCH) {
      const pause = slice.beforeWork();
      if (pause) await pause;
      check();
      const batch = records.slice(offset, offset + CONSTRUCTION_BATCH);
      const constructions = batch.map(async record => {
        const object = await classRegistry.getClass(record.type).fromObject(record, { signal });
        if (abandoned) { release(object); return undefined; }
        owned.add(object);
        return object;
      });
      const results = await abortable(Promise.allSettled(constructions), signal);
      check();
      for (let index = 0; index < results.length; index++) {
        const result = results[index];
        let object;
        if (result.status === 'fulfilled') {
          object = result.value;
          if (reviver) await abortable(Promise.resolve().then(() => reviver(batch[index], object)), signal);
        } else {
          // Missing children cannot be silently omitted from an atomic page.
          if (!reviver) throw result.reason;
          const fallback = Promise.resolve().then(() => reviver(batch[index], undefined, result.reason)).then(value => {
            if (abandoned) release(value);
            else if (value) owned.add(value);
            return value;
          });
          object = await abortable(fallback, signal);
          if (!object) throw result.reason;
        }
        check();
        if (!object) throw new Error('Notebook child could not be prepared');
        output.push(object);
      }
    }
    return output;
  } catch (error) {
    abandoned = true;
    owned.forEach(release);
    throw error;
  } finally { slice.reset(); }
}
