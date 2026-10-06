/** Account retained Fabric page surfaces and explicitly reserved repair buffers. */
export function createNotebookRenderCache({ maxNotebookBytes = 33_554_432, maxBoardBytes = 67_108_864 } = {}) {
  if (![maxNotebookBytes, maxBoardBytes].every(value => Number.isSafeInteger(value) && value > 0)) {
    throw new TypeError('Notebook cache limits must be positive byte counts');
  }
  const entries = new Map(), reservations = new Map();
  let bytes = 0, temporary = 0;
  function release(owner) {
    const entry = entries.get(owner);
    if (!entry) return;
    entries.delete(owner); bytes -= entry.bytes; entry.onEvict?.();
  }
  function sizeOf(surfaces) {
    if (!Array.isArray(surfaces) || surfaces.length > 2) return null;
    let size = 0;
    for (const surface of surfaces) {
      if (!surface || ![surface.width, surface.height].every(n => Number.isSafeInteger(n) && n >= 0)) return null;
      size += surface.width * surface.height * 4;
      if (!Number.isSafeInteger(size)) return null;
    }
    return size;
  }
  function evictionCandidate() {
    let legacy;
    for (const [owner, entry] of entries) {
      if (reservations.get(owner)) continue; // a repair still owns these pixels
      if (typeof entry.isVisible !== 'function') { legacy ??= owner; continue; }
      try { if (!entry.isVisible()) return { owner }; } catch { /* unknown is kept */ }
    }
    // Callers without visibility metadata retain the original LRU contract.
    // Visible pages are not shuffled out on every frame for another visible page.
    return legacy === undefined ? null : { owner: legacy };
  }
  return {
    acquire(owner, value) {
      if (!value) {
        const entry = entries.get(owner); if (!entry) return false;
        entries.delete(owner); entries.set(owner, entry); return true;
      }
      const size = sizeOf(value.surfaces), previous = entries.get(owner);
      if (previous) { entries.delete(owner); bytes -= previous.bytes; }
      if (size == null || size + (reservations.get(owner) || 0) > maxNotebookBytes || size + temporary > maxBoardBytes) {
        value.onEvict?.(); return false;
      }
      while (bytes + temporary + size > maxBoardBytes) {
        const candidate = evictionCandidate(); if (!candidate) break;
        release(candidate.owner);
      }
      if (bytes + temporary + size > maxBoardBytes) { value.onEvict?.(); return false; }
      entries.set(owner, { ...value, bytes: size }); bytes += size; return true;
    },
    reserveTemporary(owner, size) {
      const entry = entries.get(owner), reserved = reservations.get(owner) || 0;
      if (!entry || !Number.isSafeInteger(size) || size < 0 || entry.bytes + reserved + size > maxNotebookBytes
        || bytes + temporary + size > maxBoardBytes) return null;
      temporary += size; reservations.set(owner, reserved + size); let released = false;
      return () => {
        if (released) return; released = true; temporary -= size;
        const remaining = (reservations.get(owner) || 0) - size;
        if (remaining) reservations.set(owner, remaining); else reservations.delete(owner);
      };
    },
    invalidate: release, release,
    dispose() { for (const owner of [...entries.keys()]) release(owner); },
    bytesUsed() { return bytes + temporary; },
  };
}
const boardCaches = new WeakMap();
export function notebookRenderCacheFor(canvas) {
  if (!canvas) return null;
  if (!boardCaches.has(canvas)) boardCaches.set(canvas, createNotebookRenderCache());
  return boardCaches.get(canvas);
}
