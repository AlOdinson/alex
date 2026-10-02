import { captureNotebookObject, isBoardNotebook } from './boardNotebook.js';
import { util } from 'fabric';
import { randomToken } from './ids.js';
import { createConditionalDeleteOps, createConditionalRecordPatchOps } from './operationProtocol.js';
import { prepareNotebookProjection } from './notebookProjection.js';

const CHILD_FIELDS = ['id', 'shapeType', 'boardObjectId', 'objectKind', 'storagePath', 'isEraserPath', 'updatedAt', 'updatedBy'];
const serialized = object => object.toObject(CHILD_FIELDS);
const stale = () => new Error('Страница блокнота изменилась — повторите действие');

/** Notebook gesture preparation is serialized by Board, NOT by network replies. */
export function createNotebookBoardActions({ getCanvas, getController, clientId, getRecords, recordAction,
  acquireLease, ownsLease, releaseLease, mutate = work => work(), onChange = () => {}, onError = () => {} } = {}) {
  const stamp = object => { object.updatedAt = Date.now(); object.updatedBy = clientId; return object; };
  const guardOps = (ops, actionId) => ops.map(op => ({ ...op, atomicGroup: actionId }));
  function requireTarget(notebook, page, child = null) {
    if (!getCanvas()?.getObjects().includes(notebook) || notebook.notebookPageNumber !== page
      || child && !notebook.getPageObjects().includes(child) || !ownsLease(notebook)) throw stale();
  }
  function follow(handle, target, controller, historyAction = null) {
    handle.settled.then(() => {}, error => onError(error, historyAction)).finally(() => {
      const pending = controller.pendingObjectIds();
      const targets = Array.isArray(target) ? target : [target];
      if (ownsLease(target) && !targets.some(object => pending.has(String(object.boardObjectId)))) releaseLease(target);
    }).catch(error => onError(error));
  }
  function history(handle, inverse = handle.inverseOps, metadata = null) {
    const action = { type: 'compound', nextHistoryOps: inverse, notebookActionId: handle.actionId };
    recordAction(action, metadata); return action;
  }
  const operation = (notebook, pageNumber, changes) => ({ type: 'notebook', version: 1,
    id: String(notebook.boardObjectId), pageNumber, changes, updatedAt: Date.now(), updatedBy: clientId });

  async function capture(notebook, object, { before = [], published = false, newText = false, pageNumber = notebook.notebookPageNumber } = {}) {
    const controller = await getController(), canvas = getCanvas();
    if (!canvas?.getObjects().includes(notebook) || !canvas.getObjects().includes(object)) return false;
    const target = published ? [notebook, object] : notebook;
    if (!await acquireLease(target)) throw new Error('Блокнот сейчас занят другим участником — штрих не сохранён, повторите действие');
    let prepared = null, enqueued = false;
    try {
      prepared = await captureNotebookObject(notebook, object);
      if (!prepared) return false;
      if (getCanvas() !== canvas || notebook.notebookPageNumber !== pageNumber || !canvas.getObjects().includes(notebook)
        || !canvas.getObjects().includes(object) || !ownsLease(target)) throw stale();
      const sourceBefore = before.length ? before : getRecords([object]);
      const sourceId = String(object.boardObjectId), actionId = randomToken(24), mutationId = randomToken(24);
      const historySource = newText && prepared.split ? getRecords([object]) : sourceBefore;
      const restoreSource = published && (!newText || prepared.split);
      const inside = stamp(prepared.inside), outside = prepared.outside;
      const childRecord = serialized(inside), childIndex = notebook.getPageObjects().length;
      let outsideRecords = [];
      if (outside) {
        outside.boardObjectId = sourceId; stamp(outside);
        outsideRecords = [{ object: serialized(outside), zIndex: Math.max(0, sourceBefore[0]?.zIndex ?? canvas.getObjects().length - 1) }];
      }
      const ops = guardOps([
        operation(notebook, pageNumber, [{ type: 'insert', object: childRecord, zIndex: childIndex, ifAbsent: true }]),
        ...(outside ? (published ? createConditionalRecordPatchOps(sourceBefore, outsideRecords)
          : outsideRecords.map(record => ({ type: 'upsert', ...record })))
          : [{ ...(published ? createConditionalDeleteOps(sourceBefore)[0] : { type: 'delete', id: sourceId }), mutationId }]),
      ], actionId);
      // Queue limits/storage readiness are checked BEFORE removing visible input.
      const handle = controller.enqueue({ actionId, ops }); enqueued = true;
      const inverse = guardOps([
        ...handle.inverseOps.filter(op => op.type === 'notebook'),
        ...(restoreSource ? (outside ? createConditionalRecordPatchOps(outsideRecords, historySource)
          : historySource.map(record => ({ type: 'upsert', ...record, restore: true, reorder: true,
            ifDeletedBy: clientId, ifDeletedMutationId: mutationId }))) : createConditionalDeleteOps(outsideRecords)),
      ], actionId);
      const historyAction = history(handle, inverse, { sourceId, newText, split: prepared.split, historySource });
      mutate(() => {
        if (canvas.getActiveObject?.() === object) canvas.discardActiveObject();
        canvas.remove(object); notebook.addPageObject(inside);
        notebook.updatedAt = ops[0].updatedAt; notebook.updatedBy = clientId;
        if (outside) { canvas.add(outside); canvas.moveObjectTo(outside, outsideRecords[0].zIndex); }
      });
      follow(handle, target, controller, historyAction); onChange([notebook, outside].filter(Boolean)); canvas.requestRenderAll(); return true;
    } finally {
      if (!enqueued) {
        prepared?.inside?.dispose(); prepared?.outside?.dispose();
        if (ownsLease(target)) releaseLease(target);
      }
    }
  }

  async function changePage(notebook, page) {
    if (!isBoardNotebook(notebook) || page === notebook.notebookPageNumber) return false;
    const from = notebook.notebookPageNumber;
    if (!Number.isSafeInteger(page) || page < 1 || page > Math.max(from, notebook.notebookPages.length) + 1) return false;
    const controller = await getController();
    if (!await acquireLease(notebook)) return false;
    let projection = null, enqueued = false;
    try {
      requireTarget(notebook, from);
      const pages = notebook.notebookPages.slice();
      while (pages.length < page) pages.push(Object.freeze([]));
      const op = { type: 'patch', version: 1, id: String(notebook.boardObjectId), patch: { notebookPageNumber: page },
        ifFields: { notebookPageNumber: from }, updatedAt: Date.now(), updatedBy: clientId };
      projection = await prepareNotebookProjection(notebook, { ...notebook.toObject(['boardObjectId']), notebookPages: Object.freeze(pages),
        notebookPageNumber: page, updatedAt: op.updatedAt, updatedBy: clientId });
      requireTarget(notebook, from);
      const handle = controller.enqueue({ ops: [op] }); enqueued = true;
      mutate(() => projection.apply());
      follow(handle, notebook, controller); onChange([notebook]); getCanvas()?.requestRenderAll(); return true;
    } finally { projection?.dispose(); if (!enqueued && ownsLease(notebook)) releaseLease(notebook); }
  }

  async function saveText({ notebook, child, pageNumber }, text) {
    const controller = await getController(), canvas = getCanvas();
    if (!await acquireLease(notebook)) return false;
    let draft, prepared, enqueued = false;
    try {
      requireTarget(notebook, pageNumber, child);
      const index = notebook.getPageObjects().indexOf(child), before = notebook.notebookPages[pageNumber - 1][index];
      draft = await child.clone(CHILD_FIELDS);
      util.applyTransformToObject(draft, child.calcTransformMatrix()); draft.set('text', text); draft.setCoords();
      prepared = await captureNotebookObject(notebook, draft);
      requireTarget(notebook, pageNumber, child);
      if (!prepared) throw new Error('Текст оказался за пределами страницы');
      const actionId = randomToken(24), outside = prepared.outside, inside = stamp(prepared.inside);
      if (!prepared.split) inside.boardObjectId = child.boardObjectId;
      const after = serialized(inside);
      const changes = !prepared.split
        ? createConditionalRecordPatchOps([{ object: before, zIndex: index }], [{ object: after, zIndex: index }])
        : [{ type: 'delete', id: child.boardObjectId, ifObjectVersion: before },
          { type: 'insert', object: after, zIndex: index, ifAbsent: true }];
      if (!changes.length) return true;
      const ops = [operation(notebook, pageNumber, changes)];
      if (outside) { outside.boardObjectId = randomToken(14); stamp(outside); ops.push({ type: 'upsert', object: serialized(outside), zIndex: canvas.getObjects().length }); }
      const handle = controller.enqueue({ actionId, ops: guardOps(ops, actionId) }); enqueued = true;
      const historyAction = history(handle);
      mutate(() => {
        notebook.remove(child); notebook.addPageObject(inside); notebook.moveObjectTo(inside, index);
        notebook.syncPage({ invalidate: false }); child.dispose();
        notebook.updatedAt = ops[0].updatedAt; notebook.updatedBy = clientId;
        if (outside) canvas.add(outside);
      });
      follow(handle, notebook, controller, historyAction); onChange([notebook, outside].filter(Boolean)); canvas.requestRenderAll(); return true;
    } finally {
      draft?.dispose();
      if (!enqueued) { prepared?.inside?.dispose(); prepared?.outside?.dispose(); if (ownsLease(notebook)) releaseLease(notebook); }
    }
  }

  async function erase(entries) {
    const controller = await getController(), canvas = getCanvas();
    const notebooks = entries.map(entry => canvas?.getObjects().find(object => object.boardObjectId === entry.id)).filter(isBoardNotebook);
    if (!notebooks.length || !await acquireLease(notebooks)) return false;
    let enqueued = false;
    try {
      const affected = [], ops = [];
      for (const notebook of notebooks) {
        const entry = entries.find(item => item.id === notebook.boardObjectId);
        if (entry.page !== notebook.notebookPageNumber) continue;
        const children = notebook.getPageObjects().filter(child => entry.childIds.has(child.boardObjectId));
        const byId = new Map(notebook.notebookPages[entry.page - 1].map(record => [String(record.boardObjectId), record]));
        if (!children.length) continue;
        ops.push(operation(notebook, entry.page, children.map(child => ({ type: 'delete', id: String(child.boardObjectId), ifObjectVersion: byId.get(String(child.boardObjectId)) }))));
        affected.push({ notebook, children });
      }
      if (!ops.length) return false;
      const actionId = randomToken(24), handle = controller.enqueue({ actionId, ops: guardOps(ops, actionId) }); enqueued = true;
      const historyAction = history(handle);
      mutate(() => affected.forEach(({ notebook, children }, index) => {
        notebook.remove(...children); notebook.syncPage({ invalidate: false }); children.forEach(child => child.dispose());
        notebook.updatedAt = ops[index].updatedAt; notebook.updatedBy = clientId;
      }));
      follow(handle, notebooks, controller, historyAction); onChange(notebooks); canvas.requestRenderAll(); return true;
    } finally { if (!enqueued && ownsLease(notebooks)) releaseLease(notebooks); }
  }
  return { capture, changePage, saveText, erase };
}
