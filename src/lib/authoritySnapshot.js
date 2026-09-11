import { applySerializedObjectPatch } from './operationProtocol.js';

const EMPTY_SNAPSHOT = { version: 2, background: 'grid', canvas: { objects: [] } };

function cloneValue(value) {
  if (value == null || typeof value !== 'object') return value;
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function isSerializedActiveSelection(object) {
  const type = String(object?.type ?? '');
  return type === 'ActiveSelection' || type === 'activeSelection';
}

function applyMutable(snapshot, ops, background = null) {
  snapshot.version = 2;
  if (!snapshot.canvas || typeof snapshot.canvas !== 'object') snapshot.canvas = { objects: [] };
  if (!Array.isArray(snapshot.canvas.objects)) snapshot.canvas.objects = [];

  const objects = snapshot.canvas.objects;
  for (let index = objects.length - 1; index >= 0; index -= 1) {
    if (isSerializedActiveSelection(objects[index])) objects.splice(index, 1);
  }

  const sourceOps = (Array.isArray(ops) ? ops : []).filter((op) => (
    op?.type !== 'upsert' || !isSerializedActiveSelection(op.object)
  ));
  const isExplicitReorder = (op) => (
    (op?.type === 'upsert' && op.object?.boardObjectId && Boolean(op.reorder || op.restore))
    || (op?.type === 'patch' && op.id && Boolean(op.reorder))
  );
  const orderedOps = [
    ...sourceOps.filter((op) => !isExplicitReorder(op)),
    ...sourceOps.filter(isExplicitReorder).sort((left, right) => (
      Number(left.zIndex ?? Number.MAX_SAFE_INTEGER) - Number(right.zIndex ?? Number.MAX_SAFE_INTEGER)
    )),
  ];
  const reorderIds = new Set(orderedOps.filter(isExplicitReorder)
    .map((op) => String(op.object?.boardObjectId ?? op.id)));
  const reorderSources = new Map(objects
    .filter((object) => reorderIds.has(String(object?.boardObjectId ?? '')))
    .map((object) => [String(object.boardObjectId), object]));
  if (reorderIds.size) {
    for (let index = objects.length - 1; index >= 0; index -= 1) {
      if (reorderIds.has(String(objects[index]?.boardObjectId ?? ''))) objects.splice(index, 1);
    }
  }
  const objectById = new Map([...objects, ...reorderSources.values()]
    .filter((object) => object?.boardObjectId)
    .map((object) => [String(object.boardObjectId), object]));

  for (const op of orderedOps) {
    if (op?.type === 'delete' && op.id) {
      const id = String(op.id);
      const existing = objectById.get(id);
      const index = existing ? objects.indexOf(existing) : -1;
      if (index >= 0) objects.splice(index, 1);
      objectById.delete(id);
      continue;
    }

    if (op?.type === 'patch' && op.id) {
      const id = String(op.id);
      const existing = objectById.get(id);
      const patched = applySerializedObjectPatch(existing, op);
      if (!existing || !patched) continue;
      const existingIndex = objects.indexOf(existing);
      if (existingIndex >= 0) objects[existingIndex] = patched;
      objectById.set(id, patched);
      if (op.reorder && Number.isInteger(op.zIndex)) {
        if (existingIndex >= 0) objects.splice(existingIndex, 1);
        const targetIndex = Math.max(0, Math.min(objects.length, op.zIndex));
        objects.splice(targetIndex, 0, patched);
      } else if (existingIndex < 0) {
        objects.push(patched);
      }
      continue;
    }

    if (op?.type === 'transform') {
      const patches = Array.isArray(op.objects) ? op.objects : (op.id ? [{
        id: op.id,
        transform: op.transform,
        updatedAt: op.updatedAt,
        updatedBy: op.updatedBy,
        zIndex: op.zIndex,
      }] : []);
      for (const patch of patches) {
        const id = String(patch?.id ?? '');
        if (!id || !patch?.transform || typeof patch.transform !== 'object') continue;
        const existing = objectById.get(id);
        if (!existing) continue;
        Object.assign(existing, patch.transform, {
          boardObjectId: id,
          updatedAt: Number(patch.updatedAt ?? existing.updatedAt ?? Date.now()),
          updatedBy: patch.updatedBy ?? existing.updatedBy ?? null,
        });
        if (op.reorder && Number.isInteger(patch.zIndex)) {
          const existingIndex = objects.indexOf(existing);
          if (existingIndex >= 0) objects.splice(existingIndex, 1);
          const targetIndex = Math.max(0, Math.min(objects.length, patch.zIndex));
          objects.splice(targetIndex, 0, existing);
        }
      }
      continue;
    }

    if (op?.type !== 'upsert' || !op.object?.boardObjectId) continue;
    const objectId = String(op.object.boardObjectId);
    const previousObject = objectById.get(objectId);
    const existingIndex = previousObject ? objects.indexOf(previousObject) : -1;
    if (existingIndex >= 0) objects.splice(existingIndex, 1);
    const requestedIndex = op.preserveOrder && existingIndex >= 0
      ? existingIndex
      : (Number.isInteger(op.zIndex) ? op.zIndex : objects.length);
    const targetIndex = Math.max(0, Math.min(objects.length, requestedIndex));
    const nextObject = cloneValue(op.object);
    objects.splice(targetIndex, 0, nextObject);
    objectById.set(objectId, nextObject);
  }

  if (['grid', 'dots', 'blank'].includes(background)) snapshot.background = background;
  snapshot.savedAt = new Date().toISOString();
  return snapshot;
}

export function applyAuthorityOps(sourceSnapshot, ops, background = null) {
  return applyMutable(cloneValue(sourceSnapshot ?? EMPTY_SNAPSHOT), ops, background);
}

export function applyAuthorityActions(sourceSnapshot, actions) {
  const snapshot = cloneValue(sourceSnapshot ?? EMPTY_SNAPSHOT);
  for (const action of Array.isArray(actions) ? actions : []) {
    applyMutable(snapshot, action?.ops ?? [], action?.background ?? null);
  }
  return snapshot;
}
