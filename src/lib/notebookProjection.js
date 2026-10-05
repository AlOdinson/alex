import { notebookPageState, notebookPageRecords, notebookPageChanges } from './notebookPageModel.js';
import { notebookPageAppend } from './notebookPageDelta.js';
import { enlivenNotebookObjects } from './notebookObjectPreparation.js';
import { isNotebookWorkCancelled } from './notebookWorkScheduler.js';
import { createObjectPatch } from './operationProtocol.js';
import { notebookPageWorkGuard, retireNotebookPageWork } from './notebookPageRuntime.js';

const frameRecord = value => {
  const { notebookPages, objects, layoutManager, clipPath, ...frame } = value ?? {};
  return frame;
};
const equal = (a, b) => {
  if (Object.is(a, b)) return true;
  if (a == null || b == null || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
  const ak = Object.keys(a).filter(k => a[k] !== undefined), bk = Object.keys(b).filter(k => b[k] !== undefined);
  return ak.length === bk.length && ak.every(k => Object.hasOwn(b, k) && equal(a[k], b[k]));
};
const visuallyEqual = (before, after) => {
  if (Object.is(before, after)) return true;
  if (!before || !after) return false;
  const keys = value => Object.keys(value).filter(key => key !== 'updatedAt' && key !== 'updatedBy' && value[key] !== undefined);
  const left = keys(before), right = keys(after);
  return left.length === right.length && left.every(key => Object.hasOwn(after, key) && equal(before[key], after[key]));
};
export function notebookFramePatch(before, after) {
  return createObjectPatch(frameRecord(before), frameRecord(after));
}

/**
 * Prepare all asynchronous child work without mutating the current page. The
 * caller can prepare outside split fragments too, then install the entire batch
 * synchronously. Only the target visible page is read; hidden records stay shared.
 * A pending model change or navigation invalidates the prepared transaction.
 */
export async function prepareNotebookProjection(notebook, target, { isCurrent = () => true, signal } = {}) {
  if (String(notebook?.type).toLowerCase() !== 'boardnotebook'
    || String(target?.boardObjectId) !== String(notebook.boardObjectId)
    || !Array.isArray(target.notebookPages) || !Number.isSafeInteger(target.notebookPageNumber)
    || target.notebookPageNumber < 1 || target.notebookPageNumber > target.notebookPages.length + 1) {
    throw new TypeError('Invalid notebook projection target');
  }
  if (notebook._pageContentInvalid) notebook.syncPage({ invalidate: false });
  const guard = notebookPageWorkGuard(notebook), beforePages = notebook.notebookPages;
  const beforePageNumber = notebook.notebookPageNumber, page = target.notebookPageNumber;
  const nextState = notebookPageState(target.notebookPages, page - 1);
  const beforeState = notebookPageState(beforePages, beforePageNumber - 1);
  const pageChanged = page !== beforePageNumber;
  const samePageRecords = !pageChanged && nextState === beforeState;
  const append = !pageChanged && notebookPageAppend(beforeState, nextState);
  const indexedChanges = !pageChanged && notebookPageChanges(beforeState, nextState);
  const metadataOnly = Boolean(indexedChanges && indexedChanges.every(change => change.beforeIndex === change.index && visuallyEqual(change.before, change.after)));
  const addressed = !append && !pageChanged && indexedChanges;
  let records, beforeRecords, freshRecords = append ? [append.record]
    : addressed ? addressed.filter(change => change.after && !visuallyEqual(change.before, change.after)).map(change => change.after) : [];
  if (!samePageRecords && !append && !addressed && !metadataOnly) {
    records = notebookPageRecords(nextState); beforeRecords = notebookPageRecords(beforeState);
    const currentById = new Map(beforeRecords.map(record => [String(record.boardObjectId), record]));
    const wanted = new Set(records.map(record => String(record.boardObjectId)));
    if (wanted.size !== records.length || records.some(record => !record?.boardObjectId)) throw new TypeError('Duplicate or missing notebook child identity');
    freshRecords = records.filter(record => pageChanged
      || !visuallyEqual(currentById.get(String(record.boardObjectId)), record));
  }
  let installed = false, disposed = false;
  const current = () => !installed && !disposed && !signal?.aborted && isCurrent() && guard()
    && notebook.notebookPages === beforePages && notebook.notebookPageNumber === beforePageNumber;
  let prepared;
  try { prepared = await enlivenNotebookObjects(freshRecords, { signal }, current); }
  catch (error) {
    if (!isNotebookWorkCancelled(error)) throw error;
    return { isCurrent: () => false, apply: () => false, dispose() {} };
  }
  return {
    isCurrent: current,
    apply() {
      if (!current()) return false;
      if (metadataOnly && indexedChanges.some(change => String(notebook._objects[change.index]?.boardObjectId)
        !== String(change.after.boardObjectId))) return false;
      const frame = notebookFramePatch(notebook.toObject(['boardObjectId']), target);
      const contentChanged = Boolean(append) || Boolean(addressed && !metadataOnly && addressed.length) || !samePageRecords && !addressed && !metadataOnly && (pageChanged || prepared.length > 0 || records.length !== beforeRecords.length
        || records.some((record, index) => record.boardObjectId !== beforeRecords[index]?.boardObjectId));
      // Invalidate obsolete navigation/delta preparations, never new local input.
      if (contentChanged) retireNotebookPageWork(notebook);
      notebook.notebookPageNumber = page;
      if (append) {
        if (!notebook.appendPreparedPageObject(prepared[0], target.notebookPages)) {
          notebook.applyPreparedPageDelta(notebookPageRecords(nextState), prepared, target.notebookPages);
        }
      } else if (addressed && !metadataOnly && contentChanged) {
        if (!notebook.applyAddressedPageChanges(addressed, prepared, target.notebookPages)) return false;
      } else if (contentChanged) {
        notebook.applyPreparedPageDelta(records, prepared, target.notebookPages);
        // Rebase may reorder retained siblings without creating new objects.
        const desired = new Map(records.map((record, index) => [String(record.boardObjectId), index]));
        const objects = notebook.getPageObjects();
        for (const object of objects) {
          const index = desired.get(String(object.boardObjectId));
          if (notebook._objects[index] !== object) notebook.moveObjectTo(object, index);
        }
      } else notebook.notebookPages = target.notebookPages;
      if (!samePageRecords && !append && !addressed && !metadataOnly) {
        const byId = new Map(records.map(record => [String(record.boardObjectId), record]));
        for (const child of notebook.getPageObjects()) {
          const record = byId.get(String(child.boardObjectId));
          if (record) {
            notebook._pageRecords.set(child, record);
            if (record.updatedAt != null) child.updatedAt = record.updatedAt;
            if (record.updatedBy != null) child.updatedBy = record.updatedBy;
          }
        }
      }
      if (metadataOnly) for (const change of indexedChanges) {
        const child = notebook._objects[change.index], record = change.after;
        notebook._pageRecords.set(child, record);
        if (record.updatedAt != null) child.updatedAt = record.updatedAt;
        if (record.updatedBy != null) child.updatedBy = record.updatedBy;
      }
      if (frame) {
        for (const key of frame.unset ?? []) delete notebook[key];
        notebook.set(frame.patch);
        if (frame.patch.width != null || frame.patch.height != null) {
          notebook.clipPath?.set({ width: notebook.width, height: notebook.height });
        }
        notebook.dirty = true; notebook.setCoords();
      }
      if (target.updatedAt != null) notebook.updatedAt = target.updatedAt;
      if (target.updatedBy != null) notebook.updatedBy = target.updatedBy;
      notebook._pageContentInvalid = false;
      installed = true;
      return true;
    },
    dispose() {
      if (disposed || installed) return;
      disposed = true;
      prepared.forEach(object => object.dispose());
    },
  };
}
