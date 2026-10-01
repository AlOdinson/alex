// Serialize cross-database file ownership changes across tabs. Heavy hashing is
// performed before entering this section; ordinary drawing does not acquire it.
let queue = Promise.resolve();
export function withLocalFileLifecycle(work) {
  if (globalThis.navigator?.locks?.request) {
    return navigator.locks.request('alex-board-local-file-lifecycle', { mode: 'exclusive' }, work);
  }
  const next = queue.then(work, work);
  queue = next.catch(() => {});
  return next;
}
