import { applyAuthorityOpsInPlace, authoritySnapshotLookup } from './authoritySnapshot.js';

export const isBoundedVerificationBoard = (board) => board?.verificationVersion === 1;
export const validVerificationRecords = (records) => Array.isArray(records)
  && records.length <= 100
  && new Set(records.map((r) => r?.id)).size === records.length
  && records.every((r) => typeof r?.id === 'string' && r.id.length > 0 && r.id.length <= 200
    && (r.object === null || (r.object && typeof r.object === 'object'
      && !Array.isArray(r.object) && r.object.boardObjectId === r.id
      && Number.isInteger(r.zIndex) && r.zIndex >= 0)));

// The getters must expose internal serialized state, never getReplicaState() or
// authority.getSnapshot(), which clone entire boards. Callers must not mutate reads.
export function createVerificationView({ getSnapshot, getRevision }) {
  if (typeof getSnapshot !== 'function' || typeof getRevision !== 'function') {
    throw new TypeError('Verification view requires state/revision getters');
  }
  let iterator = null;
  let remaining = 0;
  const current = () => {
    const snapshot = getSnapshot();
    if (!snapshot?.canvas?.objects) throw new Error('Verification state is unavailable');
    return { snapshot, lookup: authoritySnapshotLookup(snapshot) };
  };
  return {
    revision: () => Number(getRevision()),
    background: () => current().snapshot.background,
    count: () => current().lookup.objects.length,
    capture() {
      const { snapshot, lookup } = current();
      return { snapshot, revision: Number(getRevision()), generation: lookup.generation };
    },
    isCurrent(stamp) {
      const { snapshot, lookup } = current();
      return stamp?.snapshot === snapshot && stamp.revision === Number(getRevision())
        && stamp.generation === lookup.generation;
    },
    read(input) {
      const id = String(input);
      const { lookup } = current();
      const object = lookup.byId.get(id) ?? null;
      return { id, object, zIndex: object ? lookup.objects.indexOf(object) : -1 };
    },
    page(offset = 0, limit = 20) {
      const { lookup } = current();
      const start = Math.max(0, Math.floor(Number(offset) || 0));
      const end = Math.min(lookup.objects.length, start + Math.max(0, Math.min(100, Number(limit) || 0)));
      const ids = [];
      for (let i = start; i < end; i++) {
        const id = lookup.objects[i]?.boardObjectId;
        if (typeof id === 'string' && id) ids.push(id);
      }
      return { ids, next: end, done: end >= lookup.objects.length, total: lookup.objects.length };
    },
    readOlder(limit, { fullSweep = false, reset = false } = {}) {
      const { lookup } = current();
      const maximum = Math.max(0, Math.min(100, Number(limit) || 0));
      if (reset || !iterator || (!fullSweep && remaining <= 0)) {
        // Retain the existing map's key iterator rather than indexing a mutating
        // array or copying every object/id. Selective deletions can shift array
        // offsets during this same sweep; those identities must not be skipped.
        iterator = lookup.byId.keys();
        remaining = lookup.byId.size;
      }
      const ids = [];
      while (ids.length < maximum && remaining > 0) {
        const next = iterator.next();
        if (next.done) { remaining = 0; break; }
        remaining--;
        if (typeof next.value === 'string' && next.value) ids.push(next.value);
      }
      return { ids, done: remaining <= 0 };
    },
  };
}

export function applyVerificationRecords(snapshot, records, background = null) {
  if (!snapshot?.canvas?.objects || !validVerificationRecords(records)) return false;
  if (background !== null && !['grid', 'dots', 'blank'].includes(background)) return false;
  const ids = new Set(records.map((r) => r.id));
  // Repairs are exceptional. Remove every duplicate of a repaired id, not just the
  // last object in the lookup, and preserve all unrelated object references.
  snapshot.canvas.objects = snapshot.canvas.objects.filter((o) => !ids.has(String(o?.boardObjectId ?? '')));
  const ops = records.filter((r) => r.object !== null).sort((a, b) => a.zIndex - b.zIndex)
    .map((r) => ({ type: 'upsert', object: r.object, zIndex: r.zIndex, reorder: true }));
  applyAuthorityOpsInPlace(snapshot, ops, background);
  return true;
}
