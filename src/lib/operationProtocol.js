const RUNTIME_ONLY_KEYS = new Set([
  'selectable',
  'evented',
  'hasControls',
  'hasBorders',
  'hoverCursor',
  'moveCursor',
  'objectCaching',
  'pendingImage',
  'pendingImageSerialized',
]);

const IDENTITY_KEYS = new Set([
  'boardObjectId',
  'updatedAt',
  'updatedBy',
]);

function cloneJsonValue(value) {
  if (value == null || typeof value !== 'object') return value;
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function valuesEqual(left, right) {
  if (Object.is(left, right)) return true;
  if (left == null || right == null) return false;
  if (typeof left !== 'object' || typeof right !== 'object') return false;
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

function shouldSynchronizeKey(key) {
  return !IDENTITY_KEYS.has(key)
    && !RUNTIME_ONLY_KEYS.has(key)
    && !String(key).startsWith('transient');
}

export function createObjectPatch(beforeObject, afterObject) {
  if (!afterObject?.boardObjectId) return null;
  const before = beforeObject && typeof beforeObject === 'object' ? beforeObject : {};
  const after = afterObject && typeof afterObject === 'object' ? afterObject : {};
  const patch = {};
  const unset = [];

  Object.keys(after).forEach((key) => {
    if (!shouldSynchronizeKey(key) || valuesEqual(before[key], after[key])) return;
    patch[key] = cloneJsonValue(after[key]);
  });
  Object.keys(before).forEach((key) => {
    if (!shouldSynchronizeKey(key) || Object.prototype.hasOwnProperty.call(after, key)) return;
    unset.push(key);
  });

  if (!Object.keys(patch).length && !unset.length) return null;
  return {
    type: 'patch',
    version: 1,
    id: String(after.boardObjectId),
    patch,
    ...(unset.length ? { unset } : {}),
    updatedAt: Number(after.updatedAt ?? Date.now()),
    updatedBy: after.updatedBy ?? null,
  };
}

export function createRecordPatchOps(beforeRecords, afterRecords, { reorder = false } = {}) {
  const beforeById = new Map((Array.isArray(beforeRecords) ? beforeRecords : [])
    .filter((record) => record?.object?.boardObjectId)
    .map((record) => [String(record.object.boardObjectId), record]));

  return (Array.isArray(afterRecords) ? afterRecords : []).flatMap((record) => {
    const objectId = String(record?.object?.boardObjectId ?? '');
    if (!objectId) return [];
    const previous = beforeById.get(objectId);
    if (!previous) {
      return [{
        type: 'upsert',
        object: record.object,
        zIndex: record.zIndex,
        reorder: Boolean(reorder),
      }];
    }
    const operation = createObjectPatch(previous.object, record.object);
    const layerChanged = Boolean(reorder)
      && Number(previous.zIndex ?? -1) !== Number(record.zIndex ?? -1);
    if (!operation && !layerChanged) return [];
    return [{
      ...(operation ?? {
        type: 'patch',
        version: 1,
        id: objectId,
        patch: {},
        updatedAt: Number(record.object.updatedAt ?? Date.now()),
        updatedBy: record.object.updatedBy ?? null,
      }),
      ...(layerChanged ? { reorder: true, zIndex: Number(record.zIndex) } : {}),
    }];
  });
}

export function applySerializedObjectPatch(sourceObject, operation) {
  if (!sourceObject || operation?.type !== 'patch' || !operation.id) return null;
  if (String(sourceObject.boardObjectId ?? '') !== String(operation.id)) return null;
  const next = cloneJsonValue(sourceObject);
  for (const key of Array.isArray(operation.unset) ? operation.unset : []) {
    if (shouldSynchronizeKey(key)) delete next[key];
  }
  Object.entries(operation.patch && typeof operation.patch === 'object'
    ? operation.patch
    : {}).forEach(([key, value]) => {
    if (shouldSynchronizeKey(key)) next[key] = cloneJsonValue(value);
  });
  next.boardObjectId = String(operation.id);
  next.updatedAt = Number(operation.updatedAt ?? next.updatedAt ?? Date.now());
  next.updatedBy = operation.updatedBy ?? next.updatedBy ?? null;
  return next;
}

export function operationObjectIds(operations) {
  const ids = new Set();
  for (const operation of Array.isArray(operations) ? operations : []) {
    if (operation?.type === 'delete' && operation.id) ids.add(String(operation.id));
    if (operation?.type === 'patch' && operation.id) ids.add(String(operation.id));
    if (operation?.type === 'upsert' && operation.object?.boardObjectId) {
      ids.add(String(operation.object.boardObjectId));
    }
    if (operation?.type === 'transform') {
      const entries = Array.isArray(operation.objects)
        ? operation.objects
        : (operation.id ? [operation] : []);
      entries.forEach((entry) => {
        if (entry?.id) ids.add(String(entry.id));
      });
    }
  }
  return ids;
}

export function isAuthoritativeBoardOperation(operation) {
  if (!operation || typeof operation !== 'object') return false;
  if (operation.type === 'delete') return Boolean(operation.id);
  if (operation.type === 'patch') return Boolean(operation.id)
    && operation.patch != null
    && typeof operation.patch === 'object';
  if (operation.type === 'upsert') return Boolean(operation.object?.boardObjectId);
  if (operation.type === 'transform') {
    const entries = Array.isArray(operation.objects) ? operation.objects : [operation];
    return entries.some((entry) => entry?.id && entry?.transform);
  }
  return false;
}
