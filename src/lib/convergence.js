export function normalizeRealtimeBaseRevision(value) {
  if (value == null || value === '') return null;
  const revision = Number(value);
  return Number.isFinite(revision) && revision >= 0 ? revision : null;
}

export function isRealtimeMutationCausallyStale(fence, baseRevision) {
  const normalizedBase = normalizeRealtimeBaseRevision(baseRevision);
  if (!fence || normalizedBase == null) return false;
  return Number(fence.revision ?? 0) > normalizedBase;
}

export function shouldRejectRealtimeObjectFrame(fence, {
  baseRevision = null,
  updatedAt = 0,
} = {}) {
  if (!fence) return false;
  if (fence.kind === 'delete') return true;
  if (isRealtimeMutationCausallyStale(fence, baseRevision)) return true;
  const incomingUpdatedAt = Number(updatedAt ?? 0);
  const fencedUpdatedAt = Number(fence.updatedAt ?? 0);
  // The final preview and durable operation may have the same mutation timestamp.
  // Equality is stale only after a durable fence for this object already exists.
  return incomingUpdatedAt > 0
    && fencedUpdatedAt > 0
    && fencedUpdatedAt >= incomingUpdatedAt;
}
