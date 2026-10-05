import { freezeNotebookRecord } from './notebookRecords.js';
import { notebookPageAppend } from './notebookPageDelta.js';
import { util } from 'fabric';
import { applyNotebookOperation, isNotebookOperation } from './notebookOperations.js';

const workspaces = new WeakMap();
const EMPTY_PAGE = Object.freeze([]);
const isNotebook = object => String(object?.type).toLowerCase() === 'boardnotebook';
function workspace(notebook) {
  let state = workspaces.get(notebook);
  if (!state) { state = { tail: Promise.resolve(), viewEpoch: 0, attachmentEpoch: 0, disposed: false }; workspaces.set(notebook, state); }
  return state;
}
export function notebookPageWorkGuard(notebook) {
  const state = workspace(notebook), attachment = state.attachmentEpoch, view = state.viewEpoch;
  return () => !state.disposed && state.attachmentEpoch === attachment && state.viewEpoch === view;
}
export function retireNotebookPageWork(notebook, permanently = false) {
  const state = workspace(notebook);
  state.attachmentEpoch++; state.viewEpoch++; state.disposed ||= permanently;
}
const dispose = objects => objects.forEach(object => object.dispose());
const pageRecords = (notebook, page) => notebook.notebookPages[page - 1] ?? EMPTY_PAGE;
function modelFor(notebook) {
  if (notebook._pageContentInvalid) notebook.syncPage({ invalidate: false });
  return { type: 'BoardNotebook', boardObjectId: notebook.boardObjectId,
    notebookPages: notebook.notebookPages, notebookPageNumber: notebook.notebookPageNumber };
}

/** Navigation is a view operation. An earlier async image load cannot win late. */
export async function navigateNotebookPage(notebook, page, options = {}) {
  if (!isNotebook(notebook) || !Number.isInteger(page) || page < 1
    || page > Math.max(notebook.notebookPageNumber, notebook.notebookPages.length) + 1) return false;
  const state = workspace(notebook), ticket = ++state.viewEpoch, attachment = state.attachmentEpoch;
  if (state.disposed) return false;
  if (page === notebook.notebookPageNumber) return true; // also cancels older loads
  if (notebook._pageContentInvalid) notebook.syncPage({ invalidate: false });
  // Bounded retry only when that target page actually changes during image load.
  // Never attach stale page data merely to finish a slow navigation request.
  for (let attempt = 0; attempt < 3; attempt++) {
    const records = pageRecords(notebook, page);
    const objects = await util.enlivenObjects(records, options);
    if (state.disposed || ticket !== state.viewEpoch || attachment !== state.attachmentEpoch || options.signal?.aborted) {
      dispose(objects); return false;
    }
    if (pageRecords(notebook, page) !== records) { dispose(objects); continue; }
    notebook.notebookPageNumber = page;
    notebook.replacePageObjects(objects, records);
    notebook.dirty = true; notebook.canvas?.requestRenderAll(); return true;
  }
  return false;
}

/**
 * Applies accepted child deltas in wire order. Only changed visible records are
 * revived. While they prepare, the existing page/model remains intact so local
 * input cannot serialize a half-replaced page. Hidden changes remain plain data.
 */
export function applyPageDeltaToFabric(notebook, operation, options = {}) {
  if (!isNotebook(notebook) || !isNotebookOperation(operation)) return Promise.resolve({ changed: false });
  operation = freezeNotebookRecord(structuredClone(operation));
  const state = workspace(notebook), attachment = state.attachmentEpoch;
  const cancelled = () => state.disposed || attachment !== state.attachmentEpoch || options.signal?.aborted;
  const run = async () => {
    if (cancelled()) return { changed: false, cancelled: true };
    for (let attempt = 0; attempt < 3; attempt++) {
      const before = modelFor(notebook), base = pageRecords(notebook, operation.pageNumber);
      const next = { ...before }, change = applyNotebookOperation(next, operation);
      if (!change.changed) return change;
      if (operation.pageNumber !== notebook.notebookPageNumber) {
        notebook.notebookPages = next.notebookPages;
        if (operation.updatedAt != null) notebook.updatedAt = operation.updatedAt;
        if (operation.updatedBy != null) notebook.updatedBy = operation.updatedBy;
        return change;
      }
      const changedIds = new Set(change.changedChildIds);
      const append = notebookPageAppend(base, pageRecords(next, operation.pageNumber));
      const records = append ? [append.record]
        : pageRecords(next, operation.pageNumber).filter(record => changedIds.has(String(record.boardObjectId)));
      const prepared = await util.enlivenObjects(records, options);
      if (cancelled()) { dispose(prepared); return { changed: false, cancelled: true }; }
      const latest = modelFor(notebook), currentPage = pageRecords(latest, operation.pageNumber);
      // Reuse validated preparation only if ALL page references and navigation
      // remain unchanged; another page's update must not be replaced by next.
      const unchanged = latest.notebookPages === before.notebookPages
        && latest.notebookPageNumber === before.notebookPageNumber;
      const final = unchanged ? next : { ...latest };
      const finalChange = unchanged ? change : applyNotebookOperation(final, operation);
      if (!finalChange.changed) { dispose(prepared); return finalChange; }
      if (operation.pageNumber !== notebook.notebookPageNumber) {
        dispose(prepared); notebook.notebookPages = final.notebookPages;
        if (operation.updatedAt != null) notebook.updatedAt = operation.updatedAt;
        if (operation.updatedBy != null) notebook.updatedBy = operation.updatedBy;
        return finalChange;
      }
      if (base !== currentPage) {
        const oldById = new Map(base.map(record => [String(record.boardObjectId), record]));
        const newById = new Map(currentPage.map(record => [String(record.boardObjectId), record]));
        // A new sibling doesn't invalidate prepared geometry. A concurrent edit
        // to the SAME child does: prepare the merged final child, not stale text.
        if ([...changedIds].some(id => oldById.get(id) !== newById.get(id))) { dispose(prepared); continue; }
      }
      try { notebook.applyPreparedPageDelta(pageRecords(final, operation.pageNumber), prepared, final.notebookPages); }
      catch (error) { dispose(prepared.filter(object => object.group !== notebook)); throw error; }
      if (operation.updatedAt != null) notebook.updatedAt = operation.updatedAt;
      if (operation.updatedBy != null) notebook.updatedBy = operation.updatedBy;
      notebook.canvas?.requestRenderAll(); return finalChange;
    }
    throw Object.assign(new Error('Notebook page changed during preparation; retry from current state'), { code: 'notebook_page_changed' });
  };
  const task = state.tail.then(run);
  state.tail = task.catch(() => {}); // a failed image cannot permanently poison the queue
  return task;
}
