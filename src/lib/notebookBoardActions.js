import { captureNotebookObject, prepareContainedNotebookStroke, isBoardNotebook } from './boardNotebook.js';
import { util, FabricObject } from 'fabric';
import { randomToken } from './ids.js';
import { createConditionalDeleteOps, createConditionalRecordPatchOps } from './operationProtocol.js';
import { prepareNotebookProjection } from './notebookProjection.js';
import { readSnapshotRecord } from './indexedBoardModel.js';
import { notebookPageState, notebookPageChanges } from './notebookPageModel.js';
import { retireNotebookPageWork } from './notebookPageRuntime.js';

const CHILD_FIELDS = ['id', 'shapeType', 'boardObjectId', 'objectKind', 'storagePath', 'isEraserPath', 'updatedAt', 'updatedBy'];
const serialized = object => object.toObject(CHILD_FIELDS);
const stale = () => new Error('Страница блокнота изменилась — повторите действие');

const placementKeys = ['left', 'top', 'originX', 'originY', 'angle', 'scaleX', 'scaleY', 'skewX', 'skewY', 'flipX', 'flipY'];
const geometryKeys = [...placementKeys, 'width', 'height', 'strokeWidth', 'strokeUniform'];
function dropSourceBaseline(record, canonical) {
  if (!record || !canonical || placementKeys.every(key => record.object[key] === canonical.object[key])) return record;
  // ActiveSelection serializes members using a center origin. The saved object
  // may use a left/top origin: these are the SAME placement, not a user conflict.
  // Convert only equivalent geometry. Keep all content guards from gesture start.
  const matrix = value => new FabricObject(Object.fromEntries(geometryKeys
    .filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]))).calcTransformMatrix();
  const expected = matrix(record.object), actual = matrix(canonical.object);
  if (!expected.every((value, i) => Number.isFinite(value) && Math.abs(value - actual[i]) < 1e-7)) return record;
  const object = { ...record.object };
  for (const key of placementKeys) {
    if (Object.hasOwn(canonical.object, key)) object[key] = canonical.object[key];
    else delete object[key];
  }
  return { ...record, object };
}


/** Keep acknowledgements out of a held Fabric gesture. The confirmed model and
 * network keep advancing; only projection waits until release/drop preparation.
 * Capture-phase release schedules the next task so Fabric's own pointerup can
 * enqueue the final geometry or compound drop before projection resumes.
 */
export function holdNotebookTransformProjection(controller, { eventTarget = globalThis.window,
  pointerId = null, getPending = () => null, onRelease = () => {} } = {}) {
  if (!controller || !eventTarget?.addEventListener) return () => {};
  let ended = false, released = false, releaseTimer = null;
  const types = pointerId == null
    ? ['mouseup', 'touchend', 'touchcancel', 'blur', 'pagehide']
    : ['pointerup', 'pointercancel', 'blur', 'pagehide'];
  const detach = () => types.forEach(type => eventTarget.removeEventListener(type, end, true));
  const release = () => {
    if (released) return;
    released = true; detach(); clearTimeout(releaseTimer); controller.resumeProjection(); onRelease();
  };
  function end(event) {
    // Window capture also sees element blur when a toolbar button gives focus
    // to the canvas. That must not retire the newly started native transform.
    if (event.type === 'blur' && event.target !== eventTarget) return;
    if (ended || released || (event.type.startsWith('pointer') && event.pointerId !== pointerId)) return;
    ended = true; detach();
    // A browser can flush microtasks between native listeners. Yield a task,
    // not a microtask, or the old frame can paint before Fabric's pointerup.
    releaseTimer = setTimeout(() => {
      releaseTimer = null;
      if (released) return;
      try { Promise.resolve(getPending()).catch(() => {}).finally(release); }
      catch { release(); }
    }, 0);
  }
  controller.suspendProjection();
  types.forEach(type => eventTarget.addEventListener(type, end, true));
  return release;
}

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
    const canvas = getCanvas();
    if (!canvas?.getObjects().includes(notebook) || !canvas.getObjects().includes(object)) return false;
    const target = published ? [notebook, object] : notebook;
    const frames = [notebook, object].map(item => item.calcTransformMatrix().slice());
    const current = () => getCanvas() === canvas && notebook.notebookPageNumber === pageNumber
      && [notebook, object].every((item, index) => canvas.getObjects().includes(item)
        && frames[index].every((value, i) => Math.abs(value - item.calcTransformMatrix()[i]) < 1e-7));
    let prepared = null, enqueued = false, leaseAcquired = false;
    try {
      // Broad-phase bounds may intersect while all actual ink misses the page.
      // Determine real fragments before any controller/network/lease work.
      prepared = !published && !newText && !before.length
        ? prepareContainedNotebookStroke(notebook, object, { pageNumber }) : null;
      prepared ??= await captureNotebookObject(notebook, object, { isCurrent: current });
      if (!current()) throw stale();
      if (!prepared) return false;
      const controller = await getController();
      if (!current()) throw stale();
      if (!await acquireLease(target)) throw new Error('Блокнот сейчас занят другим участником — штрих не сохранён, повторите действие');
      leaseAcquired = true;
      if (!current() || !ownsLease(target)) throw stale();
      const sourceBefore = before.length ? before : (prepared.reusesSource ? [] : getRecords([object]));
      const sourceId = String(object.boardObjectId), actionId = randomToken(24), mutationId = randomToken(24);
      const historySource = newText && prepared.split ? getRecords([object]) : sourceBefore;
      const restoreSource = published && (!newText || prepared.split);
      const inside = prepared.reusesSource ? prepared.inside : stamp(prepared.inside), outside = prepared.outside;
      const childRecord = prepared.reusesSource
        ? { ...prepared.record, updatedAt: Date.now(), updatedBy: clientId } : serialized(inside);
      const childIndex = notebook.getPageObjects().length;
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
      // Only the reducer may prove that all previous children are unchanged.
      const canonicalPages = prepared.reusesSource && controller.getState
        ? readSnapshotRecord(controller.getState().snapshot, String(notebook.boardObjectId))?.object.notebookPages : null;
      mutate(() => {
        if (canvas.getActiveObject?.() === object) canvas.discardActiveObject();
        // Remove the old identity from the board registry before reusing its Path.
        canvas.remove(object);
        if (prepared.reusesSource) {
          inside.boardObjectId = childRecord.boardObjectId;
          inside.set(prepared.placement);
          inside.updatedAt = childRecord.updatedAt; inside.updatedBy = childRecord.updatedBy;
        }
        if (!canonicalPages || !notebook.appendPreparedPageObject(inside, canonicalPages)) {
          notebook.addPageObject(inside, prepared.reusesSource ? childRecord : null);
        }
        notebook.updatedAt = ops[0].updatedAt; notebook.updatedBy = clientId;
        if (outside) { canvas.add(outside); canvas.moveObjectTo(outside, outsideRecords[0].zIndex); }
      });
      follow(handle, target, controller, historyAction); onChange([notebook, outside].filter(Boolean)); canvas.requestRenderAll(); return true;
    } finally {
      if (!enqueued) {
        // A borrowed source is still the user's visible input on rejection.
        if (!prepared?.reusesSource) prepared?.inside?.dispose();
        prepared?.outside?.dispose();
        if (leaseAcquired && ownsLease(target)) releaseLease(target);
      }
    }
  }

  async function captureSelection(entries, { before = [] } = {}) {
    const canvas = getCanvas();
    const members = entries.filter(entry => canvas?.getObjects().includes(entry.object));
    if (members.length !== entries.length || !members.some(entry => entry.notebook)) return false;
    // Freeze release geometry before ANY asynchronous queue/controller/lease wait.
    const frames = new Map(members.flatMap(entry => [
      [entry.object, entry.sourceMatrix ?? entry.object.calcTransformMatrix().slice()],
      ...(entry.notebook ? [[entry.notebook, entry.notebookMatrix ?? entry.notebook.calcTransformMatrix().slice()]] : []),
    ]));
    const controller = await getController();
    const notebooks = [...new Set(members.map(entry => entry.notebook).filter(Boolean))];
    const target = [...new Set([...notebooks, ...members.map(entry => entry.object)])];
    if (!await acquireLease(target)) throw new Error('Объект или блокнот занят другим участником — перенос не сохранён');
    const prepared = [];
    let enqueued = false;
    try {
      // Keep all members at the release position while asynchronous image/text
      // preparation runs. A later gesture must not be consumed by an older drop.
      const current = () => getCanvas() === canvas && ownsLease(target)
        && target.every(object => canvas.getObjects().includes(object)
          && frames.get(object).every((value, i) => Math.abs(value - object.calcTransformMatrix()[i]) < 1e-7))
        && members.every(entry => !entry.notebook || entry.notebook.notebookPageNumber === entry.pageNumber);
      if (!current()) throw stale();
      const sourceById = new Map(before.map(record => [String(record.object.boardObjectId), record]));
      const modelById = new Map(controller.getState().snapshot.canvas.objects.map((object, zIndex) => [String(object.boardObjectId), { object, zIndex }]));
      for (const entry of members) {
        const fragments = entry.notebook ? await captureNotebookObject(entry.notebook, entry.object, { isCurrent: current }) : null;
        prepared.push({ ...entry, fragments });
        if (!current()) throw stale();
      }
      if (!prepared.some(entry => entry.fragments)) return false;
      const actionId = randomToken(24), ops = [], pageOffsets = new Map(), changed = new Set(notebooks);
      for (const entry of prepared) {
        const { object, notebook, pageNumber, fragments } = entry;
        const id = String(object.boardObjectId);
        const canonical = modelById.get(id);
        const previous = dropSourceBaseline(sourceById.get(id), canonical) ?? canonical;
        if (!previous) throw new Error('Исходный объект ещё не сохранён — повторите перенос');
        if (!fragments) {
          ops.push(...createConditionalRecordPatchOps([previous], getRecords([object])));
          changed.add(object);
          continue;
        }
        const inside = stamp(fragments.inside), outside = fragments.outside;
        const offset = pageOffsets.get(notebook) ?? 0;
        pageOffsets.set(notebook, offset + 1);
        ops.push(operation(notebook, pageNumber, [{ type: 'insert', object: serialized(inside),
          zIndex: notebook.getPageObjects().length + offset, ifAbsent: true }]));
        entry.zIndex = previous.zIndex;
        if (outside) {
          outside.boardObjectId = id; stamp(outside);
          ops.push(...createConditionalRecordPatchOps([previous], [{ object: serialized(outside), zIndex: entry.zIndex }]));
          changed.add(outside);
        } else ops.push(...createConditionalDeleteOps([previous]));
      }
      if (!current()) throw stale();
      // One authority action and one inverse cover the entire moved selection,
      // including members left outside. Never persist half a boundary split.
      const handle = controller.enqueue({ actionId, ops: guardOps(ops, actionId) });
      enqueued = true;
      const historyAction = history(handle);
      mutate(() => {
        const active = canvas.getActiveObject?.();
        if (active && (target.includes(active) || active.getObjects?.().some(object => target.includes(object)))) canvas.discardActiveObject();
        for (const { object, notebook, fragments, zIndex } of prepared) {
          if (!fragments) continue;
          canvas.remove(object);
          notebook.addPageObject(fragments.inside);
          const op = ops.find(op => op.type === 'notebook' && op.id === String(notebook.boardObjectId));
          notebook.updatedAt = op.updatedAt; notebook.updatedBy = clientId;
          if (fragments.outside) {
            canvas.add(fragments.outside);
            canvas.moveObjectTo(fragments.outside, Math.max(0, zIndex));
          }
        }
      });
      follow(handle, target, controller, historyAction);
      onChange([...changed]); canvas.requestRenderAll();
      return true;
    } finally {
      if (!enqueued) {
        for (const entry of prepared) { entry.fragments?.inside?.dispose(); entry.fragments?.outside?.dispose(); }
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
        const state = !notebook._pageContentInvalid && notebookPageState(notebook.notebookPages, entry.page - 1);
        let selected = null;
        if (typeof state?.rankOf === 'function' && state.length === notebook._objects.length) {
          const addressed = [...entry.childIds].filter(id => typeof id === 'string').map(id => {
            const rank = state.rankOf(id);
            return { child: rank < 0 ? null : notebook._objects[rank], record: state.read(id), rank, id };
          }).filter(item => item.rank >= 0);
          if (addressed.every(item => item.child?.boardObjectId === item.id
            && notebook._pageRecords.get(item.child) === item.record)) {
            selected = addressed.sort((a, b) => a.rank - b.rank);
          }
        }
        // Retain canonical behavior for unowned/legacy or unsynchronized pages.
        if (!selected) {
          const children = notebook.getPageObjects().filter(child => entry.childIds.has(child.boardObjectId));
          const byId = new Map(notebook.notebookPages[entry.page - 1].map(record => [String(record.boardObjectId), record]));
          selected = children.map(child => ({ child, record: byId.get(String(child.boardObjectId)) }));
        }
        if (!selected.length) continue;
        ops.push(operation(notebook, entry.page, selected.map(({ child, record }) => ({
          type: 'delete', id: String(child.boardObjectId), ifObjectVersion: record,
        }))));
        affected.push({ notebook, children: selected.map(item => item.child), childIds: entry.childIds });
      }
      if (!ops.length) return false;
      const actionId = randomToken(24), handle = controller.enqueue({ actionId, ops: guardOps(ops, actionId) }); enqueued = true;
      const historyAction = history(handle);
      const view = controller.getState?.();
      mutate(() => affected.forEach(({ notebook, children, childIds }, index) => {
        if (view) {
          // Only install the action's actual optimistic result, never assume a
          // guarded delete succeeded. Cold imports can have unrelated indexes.
          const target = readSnapshotRecord(view.snapshot, String(notebook.boardObjectId))?.object;
          if (target?.notebookPageNumber !== notebook.notebookPageNumber || notebook._pageContentInvalid) return;
          const changes = notebookPageChanges(
            notebookPageState(notebook.notebookPages, notebook.notebookPageNumber - 1),
            notebookPageState(target.notebookPages, target.notebookPageNumber - 1));
          let installed = false;
          if (changes && !changes.some(change => change.after || !childIds.has(change.before?.boardObjectId))) {
            if (changes.length) {
              retireNotebookPageWork(notebook);
              installed = notebook.applyAddressedPageChanges(changes, [], target.notebookPages);
            } else { notebook.notebookPages = target.notebookPages; installed = true; }
          }
          if (!installed) {
            // Keep the original synchronous release behavior on an unshared
            // imported layout, even when the caller's projection is deferred.
            // Only retire children actually absent from the canonical result;
            // rejected object-version guards must never erase visible ink.
            const state = notebookPageState(target.notebookPages, target.notebookPageNumber - 1);
            const hasChild = typeof state?.read === 'function'
              ? id => Boolean(state.read(id))
              : id => state.some(record => String(record.boardObjectId) === String(id));
            const removed = children.filter(child => !hasChild(child.boardObjectId));
            if (removed.length) {
              notebook.remove(...removed); notebook.syncPage({ invalidate: false });
              removed.forEach(child => child.dispose());
            }
          }
          notebook.updatedAt = target.updatedAt; notebook.updatedBy = target.updatedBy;
          return;
        }
        // Compatibility for an older controller without an addressed view.
        notebook.remove(...children); notebook.syncPage({ invalidate: false }); children.forEach(child => child.dispose());
        notebook.updatedAt = ops[index].updatedAt; notebook.updatedBy = clientId;
      }));
      follow(handle, notebooks, controller, historyAction); onChange(notebooks); canvas.requestRenderAll(); return true;
    } finally { if (!enqueued && ownsLease(notebooks)) releaseLease(notebooks); }
  }
  return { capture, captureSelection, changePage, saveText, erase };
}
