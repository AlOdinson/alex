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

// A trusted internal lazy page slot is memoized and freezes its value at its
// export boundary. Never certify shallow caller freezes or unknown accessors.
const immutablePageReaders = new WeakSet();
export function createLazyNotebookPages(pages, index, materialize) {
  if (!Array.isArray(pages) || !Number.isSafeInteger(index) || index < 0 || typeof materialize !== 'function') return null;
  const descriptors = Object.getOwnPropertyDescriptors(pages);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (key === 'length' || key === String(index)) continue;
    const descriptor = descriptors[key];
    if (descriptor.get ? !immutablePageReaders.has(descriptor.get) : !isImmutableNotebookRecord(descriptor.value)) return null;
  }
  let value;
  const read = () => {
    if (!value) {
      const records = materialize();
      if (!Array.isArray(records)) throw new TypeError('Notebook page must export an array');
      value = freezeNotebookRecord(records);
    }
    return value;
  };
  immutablePageReaders.add(read);
  descriptors[index] = { get: read, enumerable: true, configurable: false };
  descriptors.length = { value: Math.max(pages.length, index + 1), writable: false, enumerable: false, configurable: false };
  const next = Object.defineProperties([], descriptors);
  Object.freeze(next); immutableRecords.add(next);
  return next;
}
