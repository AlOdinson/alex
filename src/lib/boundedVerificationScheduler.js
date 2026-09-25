// Additional integrity work only. Never enqueue user actions in this scheduler and
// never await it from a commit/history command. Disabled unless explicitly opted in.
export const BOUNDED_VERIFICATION_LIMITS = Object.freeze({
  maxObjects: 100,
  dirtyQuota: 80,
  olderQuota: 20,
  maxDirtyIds: 1000,
  debounceMs: 200,
  maxDeferralMs: 1000,
  minIntervalMs: 250,
  cpuBudgetMs: 4,
});

export function createBoundedVerificationScheduler({
  enabled = false,
  verify,
  // Return bounded candidate ids, including local-only/deleted identities when
  // fullSweep is true. The adapter owns a cursor; it must not clone the board.
  readOlder = () => ({ ids: [], done: true }),
  now = () => globalThis.performance?.now?.() ?? Date.now(),
  schedule = (fn, milliseconds) => setTimeout(fn, milliseconds),
  cancel = (timer) => clearTimeout(timer),
  onError = () => {},
} = {}) {
  if (typeof verify !== 'function') throw new TypeError('verify must be a function');
  if (typeof readOlder !== 'function') throw new TypeError('readOlder must be a function');
  const limits = BOUNDED_VERIFICATION_LIMITS;
  const dirty = new Map();
  const controller = new AbortController();
  let closed = false;
  let active = false;
  let paused = false;
  let timer = null;
  let generation = 0;
  let backgroundGeneration = 0;
  let sweepGeneration = 0;
  let scannedSweepGeneration = 0;
  let firstPendingAt = null;
  let lastInputAt = null;
  let lastStartAt = -Infinity;

  const hasWork = () => dirty.size > 0 || backgroundGeneration > 0 || sweepGeneration > 0;
  const usable = () => enabled === true && !closed;
  const report = (error) => { try { onError(error); } catch { /* diagnostic only */ } };

  const arm = () => {
    if (timer !== null) { cancel(timer); timer = null; }
    if (!usable() || active || paused || !hasWork()) return;
    const current = now();
    firstPendingAt ??= current;
    lastInputAt ??= current;
    const due = Math.max(lastStartAt + limits.minIntervalMs,
      Math.min(lastInputAt + limits.debounceMs, firstPendingAt + limits.maxDeferralMs));
    timer = schedule(() => {
      timer = null;
      void run();
    }, Math.max(0, due - current));
  };

  const run = async () => {
    if (!usable() || active || paused || !hasWork()) return;
    active = true;
    lastStartAt = now();
    const batchGeneration = generation;
    const background = backgroundGeneration;
    const sweep = sweepGeneration;
    const captured = new Map();
    const chosen = new Set();
    let older = { ids: [], done: true };
    try {
      // An iterator rather than [...dirty] avoids copying the entire dirty queue.
      for (const [id, token] of dirty) {
        if (captured.size >= limits.dirtyQuota) break;
        captured.set(id, token); chosen.add(id);
      }
      older = readOlder(limits.maxObjects - chosen.size, {
        fullSweep: sweep > 0,
        reset: sweep > 0 && scannedSweepGeneration !== sweep,
        generation: batchGeneration,
      }) ?? older;
      // A broken adapter must not turn its result into an unbounded traversal.
      let inspected = 0;
      for (const input of older.ids ?? []) {
        if (++inspected > limits.maxObjects || chosen.size >= limits.maxObjects) break;
        const id = typeof input === 'string' ? input : '';
        if (id) chosen.add(id);
      }
      // Lend unavailable older capacity to dirty objects. Track every chosen dirty
      // token, including an id returned by both the adapter and the dirty queue.
      for (const [id, token] of dirty) {
        if (chosen.has(id)) { captured.set(id, token); continue; }
        if (chosen.size >= limits.maxObjects) break;
        chosen.add(id); captured.set(id, token);
      }
      for (const id of chosen) {
        if (dirty.has(id)) captured.set(id, dirty.get(id));
      }
      const result = await verify({
        ids: [...chosen],
        dirtyIds: [...captured.keys()],
        generation: batchGeneration,
        fullSweep: sweep > 0,
        checkBackground: background > 0,
        cpuBudgetMs: limits.cpuBudgetMs,
        signal: controller.signal,
      });
      if (closed) return;
      if (result?.complete === false) {
        // No timeout/retry policy: another committed input or an existing lifecycle
        // recovery event can resume this work. In particular, do not busy-loop on a
        // held gesture or an unavailable peer.
        paused = generation === batchGeneration;
        if (sweep) scannedSweepGeneration = 0;
        return;
      }
      for (const [id, token] of captured) {
        // A response for the previous state cannot clear a newer change of the id.
        if (dirty.get(id) === token) dirty.delete(id);
      }
      if (backgroundGeneration === background) backgroundGeneration = 0;
      if (sweepGeneration === sweep && sweep > 0) {
        scannedSweepGeneration = sweep;
        if (older.done !== false) {
          sweepGeneration = 0;
          scannedSweepGeneration = 0;
        }
      }
    } catch (error) {
      if (!closed) {
        paused = generation === batchGeneration;
        if (sweep) scannedSweepGeneration = 0;
        report(error);
      }
    } finally {
      active = false;
      if (!hasWork()) { firstPendingAt = null; lastInputAt = null; }
      arm();
    }
  };

  const input = () => {
    const current = now();
    firstPendingAt ??= current;
    lastInputAt = current;
    generation++;
    paused = false;
  };

  return {
    mark(ids = [], { background = false } = {}) {
      if (!usable()) return;
      input();
      if (background) backgroundGeneration = generation;
      // A single huge action need not populate an unbounded pending-id structure.
      // Once an unseen id exceeds the limit, a bilateral membership sweep is needed.
      for (const id of ids) {
        if (typeof id !== 'string' || !id) continue;
        if (dirty.has(id) || dirty.size < limits.maxDirtyIds) dirty.set(id, generation);
        else { sweepGeneration = generation; break; }
      }
      if (!hasWork()) { firstPendingAt = null; lastInputAt = null; }
      arm();
    },
    requestSweep() {
      if (!usable()) return;
      input(); sweepGeneration = generation; arm();
    },
    resume() {
      if (!usable() || !hasWork()) return;
      paused = false;
      arm();
    },
    stats() {
      return {
        enabled: enabled === true && !closed,
        active,
        paused,
        pendingIds: dirty.size,
        sweepPending: sweepGeneration > 0,
        scheduled: timer !== null,
        generation,
      };
    },
    close() {
      if (closed) return;
      closed = true;
      controller.abort();
      if (timer !== null) cancel(timer);
      timer = null;
      dirty.clear();
      backgroundGeneration = 0; sweepGeneration = 0;
    },
  };
}
