// Additional integrity work never owns the durable operation/undo queue.
export const INTEGRITY_LIMITS = Object.freeze({
  batchSize: 100, changedSlots: 80, queueSize: 1000,
  debounceMs: 200, maxWaitMs: 1000, intervalMs: 250, sliceMs: 4,
});

export function createBoardIntegrityQueue({
  run, sample = () => [], now = () => performance.now(),
  setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (id) => clearTimeout(id),
  onError = () => {},
} = {}) {
  if (typeof run !== 'function') throw new Error('Integrity batch runner is required');
  const pending = new Map();
  const controller = new AbortController();
  let serial = 0;
  let timer = null;
  let running = false;
  let closed = false;
  let paused = false;
  let rescan = false;
  let rescanGeneration = 0;
  let background = false;
  let backgroundGeneration = 0;
  let wakeGeneration = 0;
  let firstAt = null;
  let latestAt = 0;
  let lastStart = -Infinity;
  const hasWork = () => pending.size > 0 || rescan || background;
  const put = (id, generation) => {
    if (!id) return;
    if (pending.has(id) || pending.size < INTEGRITY_LIMITS.queueSize) pending.set(id, generation);
    else { rescan = true; rescanGeneration++; }
  };
  const schedule = () => {
    if (closed || running || paused || !hasWork()) return;
    if (timer !== null) clearTimer(timer);
    const due = Math.max(lastStart + INTEGRITY_LIMITS.intervalMs,
      Math.min(latestAt + INTEGRITY_LIMITS.debounceMs, (firstAt ?? now()) + INTEGRITY_LIMITS.maxWaitMs));
    timer = setTimer(() => { timer = null; void drain(); }, Math.max(0, due - now()));
  };
  const drain = async () => {
    if (closed || running || paused || !hasWork()) return;
    running = true;
    lastStart = now();
    const startedRescan = rescanGeneration;
    const startedBackground = backgroundGeneration;
    const startedWake = wakeGeneration;
    const selected = new Map();
    let sampled = null;
    try {
      for (const [id, generation] of pending) {
        selected.set(id, generation);
        if (selected.size === INTEGRITY_LIMITS.changedSlots) break;
      }
      sampled = await sample(INTEGRITY_LIMITS.batchSize - selected.size, {
        rescan, signal: controller.signal, exclude: new Set(selected.keys()),
      });
      if (closed) return;
      const candidates = Array.isArray(sampled) ? sampled : sampled?.ids ?? [];
      for (const value of candidates) {
        const id = String(value ?? '');
        if (!id || selected.has(id)) continue;
        selected.set(id, pending.get(id));
        if (selected.size === INTEGRITY_LIMITS.batchSize) break;
      }
      for (const [id, generation] of pending) {
        if (selected.size === INTEGRITY_LIMITS.batchSize) break;
        if (!selected.has(id)) selected.set(id, generation);
      }
      const result = selected.size || background
        ? await run([...selected.keys()], { signal: controller.signal, background })
        : { status: 'done' };
      if (closed) return;
      if (result?.status === 'paused') paused = wakeGeneration === startedWake;
      if (!result || result.status === 'done') {
        sampled?.acknowledge?.();
        const retry = new Set(result?.retryIds ?? []);
        for (const [id, generation] of selected) {
          if (retry.has(id)) { if (!pending.has(id)) put(id, ++serial); continue; }
          if (pending.get(id) === generation) pending.delete(id);
        }
        if (startedBackground === backgroundGeneration && !result?.retryBackground) background = false;
        if (rescan && rescanGeneration === startedRescan && sampled?.more === false) rescan = false;
      }
      // A stale/deferred result leaves its IDs pending. A transport failure pauses
      // work until a new event; it does not install a new timer/backoff policy.
    } catch (error) {
      if (!closed) {
        paused = true;
        try { onError(error); } catch { /* checker diagnostics cannot break edits */ }
      }
    } finally {
      running = false;
      if (!hasWork()) firstAt = null;
      schedule();
    }
  };
  return {
    mark(ids = [], { background: changedBackground = false } = {}) {
      if (closed) return;
      for (const value of ids) put(String(value ?? ''), ++serial);
      if (changedBackground) { background = true; backgroundGeneration++; }
      if (!hasWork()) return;
      wakeGeneration++;
      const at = now();
      if (firstAt === null) firstAt = at;
      latestAt = at;
      paused = false;
      schedule();
    },
    wake() { if (!closed) { wakeGeneration++; paused = false; schedule(); } },
    inspect() { return { pending: pending.size, running, paused, rescan, timerPending: timer !== null }; },
    close() {
      if (closed) return;
      closed = true; controller.abort();
      if (timer !== null) clearTimer(timer);
      timer = null; pending.clear(); rescan = false; background = false;
    },
  };
}
