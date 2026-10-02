import { applyNotebookOperation, isSerializedNotebook } from './notebookOperations.js';
import { applySerializedObjectPatch } from './operationProtocol.js';

/** Collapse sequential notebook deltas into one prepared page installation.
 * Ordinary objects keep their established Board reconciliation path. This only
 * copies notebook frames/page arrays; never serializes hidden page contents.
 */
export function stageNotebookVisualOperations(operations, lookup) {
  const staged = new Map(), output = [], lastPosition = new Map(), markers = new WeakMap();
  const current = id => staged.has(id) ? staged.get(id).object : lookup(id);
  const install = (id, object, operation) => {
    const prior = staged.get(id);
    const placement = operation.reorder || operation.restore || operation.type === 'upsert'
      ? { zIndex: operation.zIndex, reorder: Boolean(operation.reorder), restore: Boolean(operation.restore),
        preserveOrder: Boolean(operation.preserveOrder) }
      : (prior?.placement ?? { preserveOrder: true });
    staged.set(id, { object, placement });
    const marker = {}; markers.set(marker, id);
    lastPosition.set(id, marker); output.push(marker);
  };
  for (const operation of operations ?? []) {
    if (operation?.type === 'transform') {
      const entries = Array.isArray(operation.objects) ? operation.objects : (operation.id ? [operation] : []);
      const ordinary = [], notebookEntries = [];
      for (const entry of entries) (isSerializedNotebook(current(String(entry.id))) ? notebookEntries : ordinary).push(entry);
      if (!notebookEntries.length) { output.push(operation); continue; }
      if (ordinary.length) output.push({ ...operation, objects: ordinary });
      for (const entry of notebookEntries) {
        const id = String(entry.id), next = applySerializedObjectPatch(current(id), { type: 'patch', id,
          patch: entry.transform, updatedAt: entry.updatedAt, updatedBy: entry.updatedBy });
        install(id, next, { ...operation, zIndex: entry.zIndex });
      }
      continue;
    }
    const id = String(operation?.object?.boardObjectId ?? operation?.id ?? '');
    const source = id ? current(id) : null;
    const notebook = operation?.type === 'notebook' || isSerializedNotebook(source)
      || isSerializedNotebook(operation?.object) || staged.has(id);
    if (!notebook) { output.push(operation); continue; }
    if (operation.type === 'delete') { install(id, null, operation); continue; }
    if (operation.type === 'upsert') { install(id, operation.object, operation); continue; }
    if (operation.type === 'notebook') {
      if (!isSerializedNotebook(source)) throw new Error(`Missing notebook projection parent: ${id}`);
      const next = { ...source };
      applyNotebookOperation(next, operation); install(id, next, operation); continue;
    }
    if (operation.type === 'patch') {
      const next = applySerializedObjectPatch(source, operation);
      if (!next) throw new Error(`Missing or invalid notebook projection frame: ${id}`);
      install(id, next, operation); continue;
    }
    output.push(operation);
  }
  return output.flatMap(entry => {
    if (!markers.has(entry)) return [entry];
    const id = markers.get(entry);
    if (lastPosition.get(id) !== entry) return [];
    const { object, placement } = staged.get(id);
    return [object ? { type: 'upsert', object, ...placement } : { type: 'delete', id }];
  });
}
