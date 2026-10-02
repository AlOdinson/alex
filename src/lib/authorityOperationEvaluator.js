import { applyAuthorityOpsInPlace } from './authoritySnapshot.js';
import { evaluateNotebookOperation, updateNotebookTombstones, isSerializedNotebook, isNotebookPageNavigationAllowed } from './notebookOperations.js';

function cloneValue(value) {
  if (value == null || typeof value !== 'object') return value;
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function equalJson(left, right) {
  if (Object.is(left, right)) return true;
  if (left == null || right == null) return false;
  if (typeof left !== 'object' || typeof right !== 'object') return false;
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

function objectIndex(snapshot) {
  const objects = Array.isArray(snapshot?.canvas?.objects) ? snapshot.canvas.objects : [];
  const byId = new Map();
  objects.forEach((object, zIndex) => {
    const id = String(object?.boardObjectId ?? '');
    if (id) byId.set(id, { object, zIndex });
  });
  return byId;
}

function withoutKeys(source, keys) {
  const next = cloneValue(source ?? {});
  keys.forEach((key) => delete next[key]);
  return next;
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object ?? {}, key);
}

function conditionalKeysPresent(operation) {
  return [
    'ifFields',
    'ifAbsent',
    'ifObjectVersion',
    'ifDeletedBy',
    'ifDeletedMutationId',
    'ifZIndex',
  ].some((key) => hasOwn(operation, key));
}

function fieldsMatch(currentObject, expected) {
  if (!currentObject || !expected || typeof expected !== 'object') return false;
  return Object.entries(expected).every(([key, value]) => (
    hasOwn(currentObject, key) && equalJson(currentObject[key], value)
  ));
}

function cleanUpsert(operation) {
  return withoutKeys(operation, [
    'ifDeletedBy',
    'ifDeletedMutationId',
    'ifFields',
    'ifAbsent',
    'ifZIndex',
  ]);
}

function cleanDelete(operation) {
  return withoutKeys(operation, ['ifObjectVersion', 'ifZIndex', 'ifFields', 'ifAbsent']);
}

function evaluateUpsert(operation, tombstones, appliedOps, skipped) {
  const id = String(operation?.object?.boardObjectId ?? '');
  if (!id) return;
  const tombstone = tombstones?.[id] ?? null;
  let ok = true;
  if (hasOwn(operation, 'ifDeletedBy')) {
    ok = Boolean(tombstone) && String(tombstone.clientId ?? '') === String(operation.ifDeletedBy ?? '');
  }
  if (ok && hasOwn(operation, 'ifDeletedMutationId')) {
    ok = Boolean(tombstone)
      && String(tombstone.mutationId ?? '') === String(operation.ifDeletedMutationId ?? '');
  }
  if (ok) appliedOps.push(cleanUpsert(operation));
  else skipped.push({ objectId: id, reason: 'object_changed' });
}

function evaluateDelete(operation, currentById, appliedOps, skipped) {
  const id = String(operation?.id ?? '');
  if (!id) return;
  const current = currentById.get(id);
  let ok = true;
  if (hasOwn(operation, 'ifObjectVersion')) {
    ok = Boolean(current?.object) && fieldsMatch(current.object, operation.ifObjectVersion);
  }
  if (ok && hasOwn(operation, 'ifZIndex')) {
    ok = Boolean(current) && current.zIndex === Number(operation.ifZIndex);
  }
  if (ok) appliedOps.push(cleanDelete(operation));
  else skipped.push({ objectId: id, reason: 'object_changed' });
}

function fieldConditionMatches(currentObject, operation, key) {
  const expectedFields = operation?.ifFields && typeof operation.ifFields === 'object'
    ? operation.ifFields
    : {};
  const expectedAbsent = Array.isArray(operation?.ifAbsent) ? operation.ifAbsent : [];
  if (hasOwn(expectedFields, key)) {
    return hasOwn(currentObject, key) && equalJson(currentObject[key], expectedFields[key]);
  }
  if (expectedAbsent.includes(key)) return !hasOwn(currentObject, key);
  return true;
}

function evaluatePatch(operation, currentById, appliedOps, skipped) {
  const id = String(operation?.id ?? '');
  if (!id) return;
  const current = currentById.get(id);
  if (isSerializedNotebook(current?.object) && hasOwn(operation.patch, 'notebookPageNumber')
    && !isNotebookPageNavigationAllowed(current.object, operation.patch.notebookPageNumber)) {
    skipped.push({ objectId: id, reason: 'notebook_page_invalid' });
    return;
  }
  const conditioned = conditionalKeysPresent(operation);

  if (!current?.object && conditioned) {
    skipped.push({ objectId: id, reason: 'object_missing' });
    return;
  }
  if (!current?.object) {
    appliedOps.push(withoutKeys(operation, ['ifFields', 'ifAbsent', 'ifZIndex']));
    return;
  }

  const safePatch = {};
  const safeUnset = [];
  const skippedFields = [];
  const patch = operation?.patch && typeof operation.patch === 'object' ? operation.patch : {};

  Object.entries(patch).forEach(([key, value]) => {
    if (fieldConditionMatches(current.object, operation, key)) safePatch[key] = cloneValue(value);
    else skippedFields.push(key);
  });
  (Array.isArray(operation?.unset) ? operation.unset : []).forEach((keyValue) => {
    const key = String(keyValue);
    if (fieldConditionMatches(current.object, operation, key)) safeUnset.push(key);
    else skippedFields.push(key);
  });

  const requestedReorder = Boolean(operation?.reorder);
  let reorderOk = requestedReorder;
  if (reorderOk && hasOwn(operation, 'ifZIndex')) {
    reorderOk = current.zIndex === Number(operation.ifZIndex);
    if (!reorderOk) skippedFields.push('__zIndex');
  }

  if (Object.keys(safePatch).length || safeUnset.length || reorderOk || !conditioned) {
    const clean = withoutKeys(operation, ['ifFields', 'ifAbsent', 'ifZIndex']);
    clean.patch = safePatch;
    if (safeUnset.length) clean.unset = safeUnset;
    else delete clean.unset;
    if (requestedReorder && !reorderOk) {
      delete clean.reorder;
      delete clean.zIndex;
    }
    appliedOps.push(clean);
  }

  if (skippedFields.length) {
    skipped.push({ objectId: id, reason: 'fields_changed', fields: skippedFields });
  }
}

function transformEntries(operation) {
  if (Array.isArray(operation?.objects)) return operation.objects;
  if (!operation?.id) return [];
  return [{
    id: operation.id,
    transform: operation.transform,
    updatedAt: operation.updatedAt,
    updatedBy: operation.updatedBy,
    zIndex: operation.zIndex,
    ifTransform: operation.ifTransform,
    ifZIndex: operation.ifZIndex,
  }];
}

function evaluateTransform(operation, currentById, appliedOps, skipped) {
  const safeEntries = [];
  transformEntries(operation).forEach((entry) => {
    const id = String(entry?.id ?? '');
    if (!id || !entry?.transform || typeof entry.transform !== 'object') return;
    const current = currentById.get(id);
    let ok = true;
    if (hasOwn(entry, 'ifTransform')) {
      ok = Boolean(current?.object) && fieldsMatch(current.object, entry.ifTransform);
    }
    if (ok && hasOwn(entry, 'ifZIndex')) {
      ok = Boolean(current) && current.zIndex === Number(entry.ifZIndex);
    }
    if (ok) safeEntries.push(withoutKeys(entry, ['ifTransform', 'ifZIndex']));
    else skipped.push({ objectId: id, reason: 'transform_changed' });
  });

  if (!safeEntries.length) return;
  const clean = withoutKeys(operation, [
    'id',
    'transform',
    'updatedAt',
    'updatedBy',
    'ifTransform',
    'ifZIndex',
    'objects',
  ]);
  clean.objects = safeEntries;
  appliedOps.push(clean);
}

export function evaluateAuthorityAction({
  snapshot,
  tombstones = {},
  notebookTombstones = {},
  notebookVersion = 0,
  clientId = '',
  actionId = '',
  ops = [],
  background = null,
} = {}) {
  const sourceOps = (Array.isArray(ops) ? ops : []).filter(op => op && typeof op === 'object');
  const rejectedGroups = new Set();
  const rejectedConflicts = [];
  const context = { clientId, actionId };

  // Start again without a failed group rather than keeping its earlier members.
  // This also preserves original order for interleaved groups and dependent ops.
  // Each restart rejects a new group, so the number of passes is bounded.
  for (;;) {
    const staged = { ...snapshot, canvas: { ...snapshot?.canvas,
      objects: (snapshot?.canvas?.objects ?? []).map(object => ({ ...object })),
    } };
    const stagedTombstones = Object.assign(Object.create(null), tombstones);
    let stagedNotebookTombstones = notebookTombstones;
    const appliedOps = [], skippedConflicts = [...rejectedConflicts];
    let appliedBackground = ['grid', 'dots', 'blank'].includes(background) ? background : null;
    let restart = false;

    for (const operation of sourceOps) {
      const group = operation.atomicGroup ? String(operation.atomicGroup) : null;
      if (group && rejectedGroups.has(group)) continue;
      const currentById = objectIndex(staged);
      const accepted = [], conflicts = [];
      let nextBackground = null;
      if (operation.type === 'background') {
        if (['grid', 'dots', 'blank'].includes(operation.background)) {
          if (operation.ifBackground === staged.background) nextBackground = operation.background;
          else conflicts.push({ objectId: '__background', reason: 'background_changed' });
        }
      } else if (operation.type === 'upsert') evaluateUpsert(operation, stagedTombstones, accepted, conflicts);
      else if (operation.type === 'delete') evaluateDelete(operation, currentById, accepted, conflicts);
      else if (operation.type === 'patch') evaluatePatch(operation, currentById, accepted, conflicts);
      else if (operation.type === 'transform') evaluateTransform(operation, currentById, accepted, conflicts);
      else if (operation.type === 'notebook') {
        if (notebookVersion !== 1) conflicts.push({ objectId: String(operation.id ?? ''), reason: 'notebook_protocol_disabled' });
        else {
          const result = evaluateNotebookOperation(currentById.get(String(operation.id))?.object,
            operation, stagedNotebookTombstones, context);
          conflicts.push(...result.skippedConflicts.map(conflict => ({ objectId: String(operation.id), ...conflict })));
          if (result.changed) accepted.push({ ...cloneValue(operation), changes: result.appliedChanges });
        }
      }
      if (group && conflicts.length) {
        rejectedGroups.add(group);
        rejectedConflicts.push(...conflicts);
        restart = true;
        break;
      }
      skippedConflicts.push(...conflicts);
      appliedOps.push(...accepted);
      if (nextBackground != null) appliedBackground = nextBackground;
      applyAuthorityOpsInPlace(staged, accepted, nextBackground);
      for (const acceptedOp of accepted) {
        if (acceptedOp.type === 'delete') stagedTombstones[String(acceptedOp.id)] = {
          clientId, actionId, mutationId: String(acceptedOp.mutationId ?? actionId),
        };
        else if (acceptedOp.type === 'upsert') delete stagedTombstones[String(acceptedOp.object.boardObjectId)];
      }
      stagedNotebookTombstones = updateNotebookTombstones(stagedNotebookTombstones, accepted, context);
    }
    if (!restart) return { changed: appliedOps.length > 0 || appliedBackground !== null,
      appliedOps, appliedBackground, skippedConflicts };
  }
}
