import { applyAuthorityOpsInPlace } from './authoritySnapshot.js';
import { createConditionalDeleteOps, createConditionalRecordPatchOps, operationObjectIds } from './operationProtocol.js';

const PLACEMENT_KEYS = ['left', 'top', 'originX', 'originY', 'angle', 'scaleX', 'scaleY', 'skewX', 'skewY', 'flipX', 'flipY'];
const has = (object, key) => Object.prototype.hasOwnProperty.call(object ?? {}, key);
const clone = (value) => value == null ? value : structuredClone(value);
const records = (value) => (Array.isArray(value) ? value : []).filter((record) => record?.object?.boardObjectId);
const entries = (op) => Array.isArray(op?.objects) ? op.objects : (op?.id ? [op] : []);

export function isConditionalHistoryOperation(op) {
  if (op?.type === 'background') return has(op, 'ifBackground');
  if (op?.type === 'transform') return entries(op).some((entry) => has(entry, 'ifTransform') || has(entry, 'ifZIndex'));
  return ['ifFields', 'ifAbsent', 'ifObjectVersion', 'ifDeletedBy', 'ifDeletedMutationId', 'ifZIndex']
    .some((key) => has(op, key));
}

// Build the *actual* inverse at the serial authority, after conflict evaluation and
// before persistence. Only affected objects are copied; large untouched images and
// paths are not cloned on every undo. Store the result with the commit for retries.
export function prepareAuthoritativeHistory(snapshot, appliedOps, appliedBackground, { clientId, actionId }) {
  const ids = operationObjectIds(appliedOps);
  const original = Array.isArray(snapshot?.canvas?.objects) ? snapshot.canvas.objects : [];
  const beforeById = new Map(original.map((object, zIndex) => [String(object.boardObjectId), { object, zIndex }]));
  const preview = { ...snapshot, canvas: { ...snapshot?.canvas, objects: original.map((object) => (
    ids.has(String(object.boardObjectId)) ? clone(object) : object
  )) } };
  applyAuthorityOpsInPlace(preview, appliedOps, appliedBackground);
  const afterById = new Map(preview.canvas.objects.map((object, zIndex) => [String(object.boardObjectId), { object, zIndex }]));
  const normalizedOps = clone(appliedOps).map((op) => {
    if (op.type === 'upsert' || (op.type === 'patch' && op.reorder)) {
      const current = afterById.get(String(op.object?.boardObjectId ?? op.id));
      if (current) op.zIndex = current.zIndex;
    }
    return op;
  });
  const inverse = [];
  for (const id of ids) {
    const before = beforeById.get(id);
    const after = afterById.get(id);
    const relevant = appliedOps.filter((op) => operationObjectIds([op]).has(id));
    if (before && !after) {
      const deletion = relevant.filter((op) => op.type === 'delete').at(-1);
      inverse.push({
        type: 'upsert', object: clone(before.object), zIndex: before.zIndex,
        restore: true, reorder: true, ifDeletedBy: String(clientId),
        ifDeletedMutationId: String(deletion?.mutationId ?? actionId),
      });
    } else if (!before && after) {
      inverse.push(...createConditionalDeleteOps([after]));
    } else if (before && after) {
      const reorder = relevant.some((op) => Boolean(op.reorder));
      const transformOnly = relevant.every((op) => op.type === 'transform') && !reorder;
      const keys = [...new Set(relevant.flatMap((op) => entries(op)
        .filter((entry) => String(entry.id) === id).flatMap((entry) => Object.keys(entry.transform ?? {}))))];
      if (transformOnly && keys.length && keys.every((key) => has(before.object, key) && has(after.object, key))) {
        inverse.push({ type: 'transform', version: 1, objects: [{
          id,
          transform: Object.fromEntries(keys.map((key) => [key, clone(before.object[key])])),
          ifTransform: Object.fromEntries(keys.map((key) => [key, clone(after.object[key])])),
          updatedAt: after.object.updatedAt, updatedBy: clientId,
        }] });
      } else {
        inverse.push(...createConditionalRecordPatchOps([after], [before], { reorder }));
      }
    }
  }
  if (appliedBackground != null && snapshot.background !== appliedBackground) {
    inverse.push({ type: 'background', background: snapshot.background, ifBackground: appliedBackground });
  }
  // Restoring a selection must use the same stable layer order on every Canvas.
  inverse.sort((a, b) => Number(a.zIndex ?? -1) - Number(b.zIndex ?? -1));
  return { appliedOps: normalizedOps, historyInverseOps: inverse };
}

export function createInitialHistoryOps(action, direction, clientId) {
  if (Array.isArray(action?.nextHistoryOps)) return clone(action.nextHistoryOps);
  const undo = direction === 'undo';
  const restore = (source) => records(source).map((record) => ({
    type: 'upsert', object: clone(record.object), zIndex: record.zIndex,
    restore: true, reorder: true, ifDeletedBy: clientId,
    ...(action.deletionMutationIds?.[record.object.boardObjectId]
      ? { ifDeletedMutationId: action.deletionMutationIds[record.object.boardObjectId] } : {}),
  })).sort((a, b) => Number(a.zIndex) - Number(b.zIndex));
  if (action?.type === 'add') return undo ? createConditionalDeleteOps(records(action.records)) : restore(action.records);
  if (action?.type === 'delete') return undo ? restore(action.records) : createConditionalDeleteOps(records(action.lastRestoredRecords ?? action.records));
  if (action?.type === 'modify') {
    const sourceRecords = undo ? action.after : action.before;
    const targetRecords = undo ? action.before : action.after;
    return createConditionalRecordPatchOps(sourceRecords, targetRecords, { reorder: Boolean(action.reorder) });
  }
  if (action?.type === 'transform') {
    const source = new Map(records(undo ? action.afterRecords : action.beforeRecords)
      .map((record) => [String(record.object.boardObjectId), record.object]));
    const objects = records(undo ? action.beforeRecords : action.afterRecords).flatMap((record) => {
      const id = String(record.object.boardObjectId);
      const expected = source.get(id);
      if (!expected) return [];
      return [{ id,
        transform: Object.fromEntries(PLACEMENT_KEYS.filter((key) => has(record.object, key)).map((key) => [key, record.object[key]])),
        ifTransform: Object.fromEntries(PLACEMENT_KEYS.filter((key) => has(expected, key)).map((key) => [key, expected[key]])),
        updatedAt: expected.updatedAt,
      }];
    });
    return objects.length ? [{ type: 'transform', version: 1, objects }] : [];
  }
  if (action?.type === 'background') return [{ type: 'background',
    background: undo ? action.before : action.after, ifBackground: undo ? action.after : action.before }];
  throw new Error(`Неподдерживаемое действие истории: ${String(action?.type ?? '')}`);
}

export function refreshHistoryOps(ops, clientId, now = Date.now()) {
  let clock = Number(now) || 0;
  const stamp = (value) => {
    clock = Math.max(clock + 1, Number(value?.updatedAt ?? 0) + 1);
    value.updatedAt = clock;
    value.updatedBy = clientId;
  };
  return clone(ops).map((op) => {
    if (op.type === 'upsert') stamp(op.object);
    else if (op.type === 'patch') stamp(op);
    else if (op.type === 'transform') entries(op).forEach(stamp);
    return op;
  });
}
