// Only records recursively frozen through this boundary may be memoized. A
// shallow Object.freeze supplied by a caller does not prove nested path safety.
const immutableRecords = new WeakSet();
export const isImmutableNotebookRecord = value => Boolean(value && typeof value === 'object' && immutableRecords.has(value));
export function freezeNotebookRecord(value, ancestors = new Set()) {
  if (!value || typeof value !== 'object' || immutableRecords.has(value)) return value;
  if (ancestors.has(value)) throw new TypeError('Cyclic notebook record');
  ancestors.add(value);
  for (const child of Object.values(value)) freezeNotebookRecord(child, ancestors);
  ancestors.delete(value);
  Object.freeze(value); immutableRecords.add(value);
  return value;
}
// Load/import/checkpoint boundary only. Ordinary child edits freeze their own
// new page in notebookOperations, never revisit this whole-snapshot traversal.
export function freezeSnapshotNotebookPages(snapshot) {
  const visit = object => {
    if (String(object?.type ?? '').toLowerCase() === 'boardnotebook' && Array.isArray(object.notebookPages)) {
      freezeNotebookRecord(object.notebookPages);
    } else if (Array.isArray(object?.objects)) object.objects.forEach(visit);
  };
  snapshot?.canvas?.objects?.forEach(visit);
  return snapshot;
}
