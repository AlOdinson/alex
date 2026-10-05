import { rememberNotebookPageAppend } from './notebookPageDelta.js';
import { freezeNotebookRecord as freeze } from './notebookRecords.js';
/**
 * Versioned, copy-on-write notebook child operations. No Fabric/React dependency.
 * Full notebookPages remain the checkpoint format; ordinary changes only inspect
 * the addressed page. Wire activation is deliberately a separate rollout gate.
 */
export const NOTEBOOK_OPERATION_VERSION = 1;
const own = (value, key) => Object.prototype.hasOwnProperty.call(value ?? {}, key);
const record = value => value != null && typeof value === 'object' && !Array.isArray(value);
const id = value => typeof value === 'string' && value.trim().length > 0;
const clone = value => value == null ? value : structuredClone(value);
// Transport timestamps are not content versions: undoing a later edit must not
// make an earlier undo stale solely because the same content was restamped.
const childVersion = child => Object.fromEntries(Object.entries(child ?? {})
  .filter(([key]) => key !== 'updatedAt' && key !== 'updatedBy'));
const unsafeKeys = new Set(['__proto__', 'prototype', 'constructor']);
const identityKeys = new Set(['boardObjectId', 'updatedAt', 'updatedBy', 'type']);
const guardKeys = new Set(['ifAbsent', 'ifFields', 'ifObjectVersion', 'ifDeletedBy', 'ifDeletedMutationId', 'ifZIndex']);
const mutableKey = key => typeof key === 'string' && !unsafeKeys.has(key) && !identityKeys.has(key)
  && key !== 'notebookPages' && key !== 'notebookPageNumber';

export const isSerializedNotebook = value => String(value?.type ?? '').toLowerCase() === 'boardnotebook'
  && Array.isArray(value?.notebookPages);
export const notebookChildKey = (parentId, pageNumber, childId) => JSON.stringify([String(parentId), pageNumber, String(childId)]);

function equal(left, right) {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  if (Array.isArray(left)) return left.length === right.length && left.every((value, index) => equal(value, right[index]));
  // Undefined object fields disappear at the JSON transport boundary.
  const keys = Object.keys(left).filter(key => left[key] !== undefined);
  const other = Object.keys(right).filter(key => right[key] !== undefined);
  return keys.length === other.length && keys.every(key => own(right, key) && equal(left[key], right[key]));
}


function childAllowed(object) {
  if (!record(object) || !id(object.boardObjectId) || !id(object.type)) return false;
  if (Object.keys(object).some(key => unsafeKeys.has(key))) return false;
  return !['boardnotebook', 'boardmedia', 'boardscreenshare', 'activeselection'].includes(object.type.toLowerCase())
    && !own(object, 'notebookPages') && !['gif', 'pdf', 'screen-share'].includes(object.mediaKind);
}

function changeAllowed(change) {
  if (!record(change)) return false;
  if (own(change, 'ifDeletedBy') !== own(change, 'ifDeletedMutationId')) return false;
  if (own(change, 'ifDeletedBy') && (!id(change.ifDeletedBy) || !id(change.ifDeletedMutationId))) return false;
  if (own(change, 'ifZIndex') && (!Number.isSafeInteger(change.ifZIndex) || change.ifZIndex < 0)) return false;
  if (change.type === 'insert') return childAllowed(change.object)
    && (!own(change, 'zIndex') || Number.isSafeInteger(change.zIndex) && change.zIndex >= 0)
    && (!own(change, 'ifAbsent') || change.ifAbsent === true);
  if (!id(change.id)) return false;
  if (change.type === 'delete') return !own(change, 'ifObjectVersion') || record(change.ifObjectVersion);
  if (change.type !== 'patch' || !record(change.patch) || !Object.keys(change.patch).every(mutableKey)) return false;
  return (!own(change, 'unset') || Array.isArray(change.unset) && change.unset.every(mutableKey))
    && (!own(change, 'ifAbsent') || Array.isArray(change.ifAbsent) && change.ifAbsent.every(mutableKey))
    && (!own(change, 'ifFields') || record(change.ifFields) && Object.keys(change.ifFields).every(mutableKey));
}

export function isNotebookOperation(operation) {
  return record(operation) && operation.type === 'notebook' && operation.version === NOTEBOOK_OPERATION_VERSION
    && id(operation.id) && Number.isSafeInteger(operation.pageNumber) && operation.pageNumber > 0
    && Array.isArray(operation.changes) && operation.changes.length > 0 && operation.changes.every(changeAllowed);
}

export function isNotebookPageNavigationAllowed(notebook, page) {
  return isSerializedNotebook(notebook) && Number.isSafeInteger(page) && page > 0
    && page <= Math.max(notebook.notebookPages.length, Number.isSafeInteger(notebook.notebookPageNumber) ? notebook.notebookPageNumber : 1) + 1;
}

function targetValid(notebook, operation) {
  return isSerializedNotebook(notebook) && String(notebook.boardObjectId) === operation.id
    // Never allocate a huge sparse page range from a malformed proposal.
    && isNotebookPageNavigationAllowed(notebook, operation.pageNumber);
}

function stamp(object, change, operation) {
  const time = change.updatedAt ?? operation.updatedAt;
  if (Number.isFinite(time) && time >= 0) object.updatedAt = time;
  const author = change.updatedBy ?? operation.updatedBy;
  if (author != null) object.updatedBy = author;
  return object;
}

function editPage(source) {
  const items = source.slice();
  const byId = new Map(items.map(child => [String(child.boardObjectId), child]));
  const touched = new Set();
  function apply(change, operation) {
    const childId = String(change.object?.boardObjectId ?? change.id);
    const current = byId.get(childId);
    if (change.type === 'insert') {
      if (current) return false; // Ordered journal replay is idempotent by identity.
      const next = freeze(stamp(clone(change.object), change, operation));
      const index = Number.isSafeInteger(change.zIndex) ? Math.min(items.length, change.zIndex) : items.length;
      items.splice(index, 0, next); byId.set(childId, next);
    } else if (change.type === 'delete') {
      if (!current) return false;
      items.splice(items.indexOf(current), 1); byId.delete(childId);
    } else {
      if (!current) return false;
      const next = { ...current };
      let changed = false;
      for (const key of change.unset ?? []) {
        if (own(next, key)) { delete next[key]; changed = true; }
      }
      for (const [key, value] of Object.entries(change.patch)) {
        if (!own(next, key) || !equal(next[key], value)) { next[key] = clone(value); changed = true; }
      }
      if (!changed) return false;
      freeze(stamp(next, change, operation));
      items[items.indexOf(current)] = next; byId.set(childId, next);
    }
    touched.add(childId);
    return true;
  }
  return { items, byId, touched, apply };
}

export function applyNotebookOperation(notebook, operation) {
  const empty = { changed: false, changedChildIds: [], pageNumber: operation?.pageNumber };
  if (!isNotebookOperation(operation) || !targetValid(notebook, operation)) return empty;
  const beforePage = notebook.notebookPages[operation.pageNumber - 1] ?? [];
  const editor = editPage(beforePage);
  for (const change of operation.changes) editor.apply(change, operation);
  if (!editor.touched.size) return empty;
  const pages = notebook.notebookPages.slice();
  pages[operation.pageNumber - 1] = freeze(editor.items);
  const only = operation.changes[0];
  // Duplicate/unsafe old identities and structural changes cannot mint a proof.
  if (operation.changes.length === 1 && only.type === 'insert'
    && (only.zIndex == null || only.zIndex >= beforePage.length)
    && editor.byId.size === editor.items.length) rememberNotebookPageAppend(beforePage, editor.items);
  notebook.notebookPages = Object.freeze(pages);
  stamp(notebook, {}, operation);
  return { changed: true, changedChildIds: [...editor.touched], pageNumber: operation.pageNumber };
}

const cleanChange = change => Object.fromEntries(Object.entries(change)
  .filter(([key]) => !guardKeys.has(key)).map(([key, value]) => [key, clone(value)]));

function deletionRecord(operation, change, context) {
  return {
    clientId: String(context.clientId ?? operation.updatedBy ?? ''),
    mutationId: String(change.mutationId ?? operation.mutationId ?? context.mutationId ?? context.actionId ?? ''),
    actionId: String(context.actionId ?? ''),
    revision: Number(context.revision ?? 0),
  };
}

/** Separate child namespace: parent IDs and page/child IDs cannot collide. */
export function updateNotebookTombstones(source, operations, context = {}) {
  let next = source ?? {};
  const writable = () => { if (next === source) next = { ...source }; };
  for (const operation of operations ?? []) {
    if (!isNotebookOperation(operation)) continue;
    for (const change of operation.changes) {
      const key = notebookChildKey(operation.id, operation.pageNumber, change.object?.boardObjectId ?? change.id);
      if (change.type === 'delete') { writable(); next[key] = deletionRecord(operation, change, context); }
      else if (change.type === 'insert' && own(next, key)) { writable(); delete next[key]; }
    }
  }
  return next;
}

export function evaluateNotebookOperation(notebook, operation, tombstones = {}, context = {}) {
  const appliedChanges = [], skippedConflicts = [];
  const result = () => ({ changed: appliedChanges.length > 0, appliedChanges, skippedConflicts });
  const conflict = (childId, reason, fields) => skippedConflicts.push({ childId, reason, ...(fields?.length ? { fields } : {}) });
  if (!isNotebookOperation(operation)) { conflict(null, 'invalid_notebook_operation'); return result(); }
  if (!targetValid(notebook, operation)) { conflict(null, 'notebook_page_missing'); return result(); }
  const editor = editPage(notebook.notebookPages[operation.pageNumber - 1] ?? []);
  const deleted = new Map(); // Per-action overlay, never enumerate old deletions.
  for (const change of operation.changes) {
    const childId = String(change.object?.boardObjectId ?? change.id);
    const current = editor.byId.get(childId);
    const key = notebookChildKey(operation.id, operation.pageNumber, childId);
    let clean = cleanChange(change);
    if (change.type === 'insert') {
      if (current) { conflict(childId, 'child_exists'); continue; }
      const tombstone = deleted.has(key) ? deleted.get(key) : (own(tombstones, key) ? tombstones[key] : null);
      if (own(change, 'ifDeletedBy')) {
        if (!tombstone || String(tombstone.clientId) !== change.ifDeletedBy
          || String(tombstone.mutationId) !== change.ifDeletedMutationId) {
          conflict(childId, 'child_changed'); continue;
        }
      } else if (tombstone) { conflict(childId, 'child_deleted'); continue; }
      clean.zIndex = Math.min(editor.items.length, change.zIndex ?? editor.items.length);
    } else {
      if (!current) { conflict(childId, 'child_missing'); continue; }
      if (own(change, 'ifZIndex') && editor.items.indexOf(current) !== change.ifZIndex) {
        conflict(childId, 'child_order_changed'); continue;
      }
      if (change.type === 'delete') {
        if (own(change, 'ifObjectVersion') && !equal(childVersion(current), childVersion(change.ifObjectVersion))) {
          conflict(childId, 'child_changed'); continue;
        }
      } else {
        const fields = [];
        const matches = field => {
          if (own(change.ifFields, field)) return own(current, field) && equal(current[field], change.ifFields[field]);
          if (change.ifAbsent?.includes(field)) return !own(current, field);
          return true;
        };
        clean.patch = {};
        for (const [field, value] of Object.entries(change.patch)) {
          if (matches(field)) clean.patch[field] = clone(value); else fields.push(field);
        }
        clean.unset = (change.unset ?? []).filter(field => {
          if (matches(field)) return true;
          fields.push(field); return false;
        });
        if (!clean.unset.length) delete clean.unset;
        if (fields.length) conflict(childId, 'fields_changed', [...new Set(fields)]);
      }
    }
    if (!editor.apply(clean, operation)) continue;
    appliedChanges.push(clean);
    if (clean.type === 'delete') deleted.set(key, deletionRecord(operation, clean, context));
    if (clean.type === 'insert') deleted.set(key, null);
  }
  return result();
}

/**
 * Computes a net page inverse from only touched child records. Optional afterState
 * is an already-staged authority view; it avoids reapplying multi-operation pages.
 */
export function invertNotebookOperation(before, operation, context = {}) {
  if (!isNotebookOperation(operation) || !targetValid(before, operation)) return [];
  const after = context.afterState ?? { ...before };
  if (!context.afterState) applyNotebookOperation(after, operation);
  const beforePage = before.notebookPages[operation.pageNumber - 1] ?? [];
  const afterPage = after.notebookPages[operation.pageNumber - 1] ?? [];
  const original = new Map(beforePage.map((child, index) => [String(child.boardObjectId), { child, index }]));
  const final = new Map(afterPage.map((child, index) => [String(child.boardObjectId), { child, index }]));
  const touched = new Set(operation.changes.map(change => String(change.object?.boardObjectId ?? change.id)));
  const changes = [], restores = [];
  let atomicGroup = operation.atomicGroup;
  for (const childId of touched) {
    const previous = original.get(childId), next = final.get(childId);
    if (!previous && next) changes.push({ type: 'delete', id: childId, ifObjectVersion: clone(childVersion(next.child)) });
    else if (previous && !next) {
      const deletion = operation.changes.filter(change => change.type === 'delete' && change.id === childId).at(-1);
      const guard = deletionRecord(operation, deletion ?? {}, context);
      if (!guard.clientId || !guard.mutationId) throw new Error('Notebook restore inverse requires deleting client and mutation identity');
      restores.push({ type: 'insert', object: clone(previous.child), zIndex: previous.index, ifAbsent: true,
        ifDeletedBy: guard.clientId, ifDeletedMutationId: guard.mutationId });
    } else if (previous && next) {
      const replaced = operation.changes.some(change => change.type === 'delete' && change.id === childId)
        && operation.changes.some(change => change.type === 'insert' && change.object.boardObjectId === childId);
      if (replaced && (previous.child.type !== next.child.type || previous.index !== next.index)) {
        if (!context.clientId || !context.actionId) throw new Error('Notebook replacement inverse requires action identity');
        const mutationId = JSON.stringify(['notebook-inverse', context.actionId, operation.id, operation.pageNumber, childId]);
        atomicGroup ||= JSON.stringify(['notebook-history', context.actionId, operation.id, operation.pageNumber]);
        changes.push({ type: 'delete', id: childId, ifObjectVersion: clone(childVersion(next.child)), mutationId });
        restores.push({ type: 'insert', object: clone(previous.child), zIndex: previous.index, ifAbsent: true,
          ifDeletedBy: String(context.clientId), ifDeletedMutationId: mutationId });
        continue;
      }
      const patch = {}, unset = [], ifFields = {}, ifAbsent = [];
      for (const key of new Set([...Object.keys(previous.child), ...Object.keys(next.child)])) {
        if (!mutableKey(key) || own(previous.child, key) === own(next.child, key) && equal(previous.child[key], next.child[key])) continue;
        if (own(previous.child, key)) patch[key] = clone(previous.child[key]); else unset.push(key);
        if (own(next.child, key)) ifFields[key] = clone(next.child[key]); else ifAbsent.push(key);
      }
      if (Object.keys(patch).length || unset.length) changes.push({ type: 'patch', id: childId, patch,
        ...(unset.length ? { unset } : {}), ...(Object.keys(ifFields).length ? { ifFields } : {}), ...(ifAbsent.length ? { ifAbsent } : {}) });
    }
  }
  // Delete added children first, then restore removed children at original indices.
  changes.push(...restores.sort((a, b) => a.zIndex - b.zIndex));
  if (!changes.length) return [];
  return [{ type: 'notebook', version: NOTEBOOK_OPERATION_VERSION, id: operation.id, pageNumber: operation.pageNumber, changes,
    ...(atomicGroup ? { atomicGroup } : {}) }];
}
