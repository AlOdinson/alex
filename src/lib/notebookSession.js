import { notebookCheckpoint as checkpoint } from './notebookCheckpoint.js';
import { createNotebookWorkSlice } from './notebookWorkScheduler.js';
import { applyBoardTombstoneOperations } from './boardTombstoneIndex.js';
import { createIndexedBoardModel, readSnapshotRecord } from './indexedBoardModel.js';
import { prepareIndexedNotebookAction, applyIndexedNotebookOps } from './notebookIndexedTransaction.js';
import { randomToken } from './ids.js';
import { isAuthoritativeBoardOperation } from './operationProtocol.js';
import { applyAuthorityOpsInPlace, forkAuthoritySnapshot } from './authoritySnapshot.js';
import { evaluateAuthorityAction } from './authorityOperationEvaluator.js';
import { prepareAuthoritativeHistory } from './historyOperations.js';
import { updateNotebookTombstones } from './notebookOperations.js';
import { freezeNotebookRecord } from './notebookRecords.js';
import { assertNotebookCommitReadable } from './notebookProtocol.js';

const clone = value => structuredClone(value);
const errorWith = (message, code) => Object.assign(new Error(message), { code });
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  // Closing a board must not create unhandled rejections for unobserved handles.
  // The original promise still rejects for callers awaiting it.
  promise.catch(() => {});
  return { promise, resolve, reject };
};
const safeRevision = value => Number.isSafeInteger(value) && value >= 0;
function seal(snapshot) {
  snapshot.canvas.objects.forEach(Object.freeze);
  Object.freeze(snapshot.canvas.objects); Object.freeze(snapshot.canvas); return Object.freeze(snapshot);
}

function boardTombstones(source, operations, context) {
  return applyBoardTombstoneOperations(source, operations, context);
}
function advance(model, operations, background, context) {
  let snapshot = applyIndexedNotebookOps(model.snapshot, operations, background);
  if (!snapshot) {
    // Explicit structural boundary: ordinary board insert/delete/reorder still
    // uses the legacy reducer. Do not materialize arrays for a child-only edit.
    snapshot = forkAuthoritySnapshot(model.snapshot, operations);
    applyAuthorityOpsInPlace(snapshot, operations, background);
    snapshot = createIndexedBoardModel(seal(snapshot)).snapshot;
  }
  return { snapshot, revision: context.revision ?? model.revision,
    tombstones: boardTombstones(model.tombstones, operations, context),
    notebookTombstones: updateNotebookTombstones(model.notebookTombstones, operations, context) };
}
function equivalent(a, b) {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
  const ak = Object.keys(a).filter(key => a[key] !== undefined), bk = Object.keys(b).filter(key => b[key] !== undefined);
  return ak.length === bk.length && ak.every(key => Object.hasOwn(b, key) && equivalent(a[key], b[key]));
}

/**
 * Ordered local notebook intents. Preview never waits for transport. Confirmed
 * state and pending state are separate; a rejection rebases, never restores an
 * old whole-notebook copy. The outbox must save before publishing and is cleared
 * only after an authoritative outcome. No polling or scheduled snapshots.
 * Opted-in large recoveries retain a coherent previous optimistic view while
 * rebuilding in task-sized slices; consumers await whenReconciled before using
 * the recovered model as a snapshot/paint barrier. Small synchronous paths stay
 * immediate, and direct legacy session callers opt in explicitly.
 *
 * confirmedState: {snapshot,revision,tombstones?,notebookTombstones?}
 * publish(action): Promise<Commit | NoopOutcome> (must deduplicate by actionId)
 * outbox?: {save(action):Promise<void>,remove(actionId):Promise<void>}
 * initialPendingActions?: persisted intents in original order, loaded by caller
 */
export function createNotebookSession({ confirmedState, publish, onChange = () => {}, onError = () => {},
  clientId = 'local', outbox = null, initialPendingActions = [], canEdit = () => true,
  maxPending = 512, maxPendingBytes = 8 * 1024 * 1024, maxInFlight = 8, cooperativeRecovery = false } = {}) {
  if (typeof publish !== 'function') throw new TypeError('Notebook session publish callback is required');
  for (const number of [maxPending, maxPendingBytes, maxInFlight]) {
    if (!Number.isSafeInteger(number) || number < 1) throw new TypeError('Notebook queue limits must be positive integers');
  }
  if (outbox && (typeof outbox.save !== 'function' || typeof outbox.remove !== 'function')) throw new TypeError('Invalid notebook outbox');
  let confirmed = checkpoint(confirmedState), optimistic = confirmed;
  let pending = [], bytes = 0, active = 0, generation = 0, paused = null, disposed = false, scheduled = false;
  let saveTail = Promise.resolve(), storageFailure = null;
  let recovery = null, recoveryVersion = 0, recoveryError = null;
  const byId = new Map(), commits = new Map(), flushWaiters = new Set(), cleanup = new Map(), settledIds = new Set();
  // Realtime onCommit and publish() can acknowledge the same commit. Remember a
  // bounded recent window so a safe duplicate cannot rebase every pending stroke.
  // Unknown older results retain the recovery path; never drop a restored intent.
  const recentCommits = new Map();
  let recentCommitBytes = 0;
  const committedPayload = result => ({ actionId: String(result.actionId), clientId: String(result.clientId ?? ''),
    ops: result.ops ?? result.appliedOps ?? [], background: result.background ?? result.appliedBackground ?? null });
  function rememberCommit(result) {
    const payload = committedPayload(result);
    const size = new TextEncoder().encode(JSON.stringify(payload)).byteLength;
    if (size > maxPendingBytes) return;
    const previous = recentCommits.get(result.revision);
    if (previous) { recentCommitBytes -= previous.bytes; recentCommits.delete(result.revision); }
    while (recentCommits.size && (recentCommitBytes + size > maxPendingBytes || recentCommits.size >= maxPending * 2)) {
      const oldest = recentCommits.keys().next().value;
      recentCommitBytes -= recentCommits.get(oldest).bytes; recentCommits.delete(oldest);
    }
    recentCommits.set(result.revision, { payload, bytes: size }); recentCommitBytes += size;
  }

  function report(error) { try { onError(error); } catch { /* observer must not break the edit queue */ } }
  function view(model) { return Object.freeze({ snapshot: model.snapshot, revision: model.revision }); }
  function flushFailure() {
    return disposed ? errorWith('Notebook session disposed', 'notebook_disposed') : paused
      ?? recoveryError ?? pending.find(entry => entry.error)?.error
      ?? (!recovery && pending.some(entry => entry.blocked) ? errorWith('Notebook action blocked: target missing or lease lost', 'notebook_action_blocked') : null);
  }
  function settleFlush() {
    const failure = flushFailure();
    if (failure || !recovery && !pending.length && !cleanup.size) {
      for (const waiter of flushWaiters) failure ? waiter.reject(failure) : waiter.resolve(view(confirmed));
      flushWaiters.clear();
    }
  }
  function notify(reason, actionId = null) {
    if (disposed) return;
    const settledActionIds = [...settledIds]; settledIds.clear();
    try { onChange(view(optimistic), { reason, actionId, pendingCount: pending.length, pendingBytes: bytes,
      unsavedCount: pending.filter(entry => !entry.saved).length,
      blockedCount: pending.filter(entry => entry.blocked).length, needsSync: commits.size > 0, recovering: Boolean(recovery), settledActionIds }); }
    catch (error) { report(error); }
    settleFlush();
  }
  function assertOpen() { if (disposed) throw errorWith('Notebook session disposed', 'notebook_disposed'); }
  function normalize(input) {
    const source = input?.type ? { ops: [input] } : input;
    if (!source || !Array.isArray(source.ops) || !source.ops.length || !source.ops.every(isAuthoritativeBoardOperation)) {
      throw new TypeError('Notebook session requires valid board operations');
    }
    const action = { actionId: String(source.actionId || randomToken(18)), clientId: String(source.clientId || clientId),
      baseRevision: safeRevision(source.baseRevision) ? source.baseRevision : confirmed.revision, ops: clone(source.ops),
      ...(source.background != null ? { background: source.background } : {}),
      ...(source.history ? { history: true } : {}) };
    // A notebook gesture and any outside fragment are one indivisible intent.
    if (action.ops.some(op => op.type === 'notebook') && action.ops.length > 1) {
      action.ops.forEach(op => { op.atomicGroup = action.actionId; });
    }
    return freezeNotebookRecord(action);
  }
  function preview(entry, model, makeInverse = false) {
    const input = { ...model, ops: entry.action.ops, background: entry.action.background,
      notebookVersion: 1, clientId: entry.action.clientId, actionId: entry.action.actionId };
    const scoped = prepareIndexedNotebookAction(input, { history: makeInverse });
    const evaluation = scoped?.evaluation ?? evaluateAuthorityAction(input);
    entry.previewOps = evaluation.appliedOps;
    entry.previewBackground = evaluation.appliedBackground;
    // Uncertain outcomes after reconnect may already exist in a new snapshot.
    // Resend that SAME identity for deduplication, even if local preflight finds
    // child_exists/child_deleted. Only a genuinely missing parent blocks replay.
    const parents = new Set(entry.action.ops.filter(op => op.type === 'notebook').map(op => op.id));
    entry.blocked = [...parents].some(id => !readSnapshotRecord(model.snapshot, id));
    if (makeInverse) entry.inverseOps = freezeNotebookRecord((scoped?.history ?? prepareAuthoritativeHistory(model.snapshot,
      evaluation.appliedOps, evaluation.appliedBackground, entry.action)).historyInverseOps);
    return evaluation.changed ? advance(model, evaluation.appliedOps, evaluation.appliedBackground, entry.action) : model;
  }
  function finishRecovery() {
    const previous = recovery;
    recovery = null;
    recoveryVersion++;
    previous?.ready.resolve(view(optimistic));
  }
  function rebuild(forceAsync = false) {
    recoveryVersion++;
    recoveryError = null;
    if (!pending.length && !commits.has(confirmed.revision + 1)) { optimistic = confirmed; finishRecovery(); return; }
    // Preserve the original synchronous contract for callers not opting in and
    // for short queues. Do not expose a partly replayed snapshot for large ones.
    if (!cooperativeRecovery || !forceAsync && pending.length <= 32 && !recovery) {
      let next = confirmed;
      for (const entry of pending) next = preview(entry, next);
      optimistic = next;
      return;
    }
    if (recovery) return; // invalidate its draft; retain one runner and observer
    const job = { ready: deferred() };
    recovery = job;
    Promise.resolve().then(async () => {
      const slice = createNotebookWorkSlice();
      try {
        while (!disposed && recovery === job) {
          // A missing revision may unlock hundreds of buffered commits at once.
          // Commit only complete operations, yielding before the next one. The
          // old optimistic view remains visible until the pending replay below.
          while (commits.has(confirmed.revision + 1)) {
            const pause = slice.beforeWork();
            if (pause) await pause;
            if (disposed || recovery !== job) return;
            if (commits.has(confirmed.revision + 1)) advanceNextCommit();
          }
          const version = recoveryVersion, source = confirmed, entries = pending;
          const updates = [];
          let next = source;
          for (let i = 0; i < entries.length; i++) {
            const pause = slice.beforeWork();
            if (pause) await pause;
            if (disposed || recovery !== job) return;
            if (version !== recoveryVersion || source !== confirmed || entries !== pending) break;
            // preview mutates metadata: keep it PRIVATE until the draft commits.
            // New enqueues append to this same array and are replayed at its tail.
            const entry = entries[i], prepared = { action: entry.action };
            next = preview(prepared, next);
            updates.push([entry, prepared]);
          }
          if (version !== recoveryVersion || source !== confirmed || entries !== pending) continue;
          for (const [entry, prepared] of updates) {
            entry.previewOps = prepared.previewOps;
            entry.previewBackground = prepared.previewBackground;
            entry.blocked = prepared.blocked;
          }
          optimistic = next;
          if (commits.has(confirmed.revision + 1)) {
            // This is a complete coherent prefix, not a partial replay. Commit
            // arrivals are buffered while replaying so a busy peer cannot cause
            // repeated abandonment of the same prefix on every message.
            notify('recovery-progress');
            continue;
          }
          finishRecovery();
          notify('recovered'); schedule();
          return;
        }
      } catch (error) {
        if (!disposed && recovery === job) {
          recovery = null; recoveryError = error; paused = error;
          job.ready.reject(error); report(error); notify('recovery-error');
        }
      } finally { slice.reset(); }
    });
  }
  function whenReconciled() {
    if (disposed) return Promise.reject(errorWith('Notebook session disposed', 'notebook_disposed'));
    if (recoveryError) return Promise.reject(recoveryError);
    return recovery ? recovery.ready.promise.then(whenReconciled) : Promise.resolve(view(optimistic));
  }
  function forgetDurable(entry) {
    if (!outbox) return;
    const id = entry.action.actionId;
    const task = Promise.resolve().then(() => outbox.remove(id));
    cleanup.set(id, task);
    task.then(() => { if (cleanup.get(id) === task) cleanup.delete(id); settleFlush(); }, error => {
      // A confirmed action left in the outbox is safe: restart resends its stable
      // identity and the authority returns its original outcome, not a new edit.
      report(error); if (!disposed) paused = error; settleFlush();
    });
  }
  function removeEntry(entry, outcome) {
    if (!entry || !byId.has(entry.action.actionId)) return;
    byId.delete(entry.action.actionId); settledIds.add(entry.action.actionId); pending = pending.filter(item => item !== entry); bytes -= entry.bytes;
    entry.settled.resolve(outcome); forgetDurable(entry);
  }
  function markFailure(entry, error, kind) {
    if (disposed || !byId.has(entry.action.actionId)) return;
    entry.error = error; entry.failureKind = kind; entry.status = 'failed';
    paused = error; report(error); notify(kind, entry.action.actionId);
  }
  function persist(entry) {
    if (entry.saving || entry.saved || disposed) return;
    entry.saving = true; entry.status = 'saving';
    const task = outbox ? saveTail.then(() => {
      if (storageFailure) throw storageFailure;
      return outbox.save(entry.action);
    }) : Promise.resolve();
    if (outbox) saveTail = task.catch(error => { storageFailure ||= error; });
    task.then(() => {
      entry.saving = false; entry.saved = true; entry.durable.resolve();
      if (disposed || !byId.has(entry.action.actionId)) return;
      entry.status = 'queued'; notify('durable', entry.action.actionId); schedule();
    }, error => { entry.saving = false; markFailure(entry, error, 'storage'); });
  }
  function pump() {
    if (disposed || paused || recovery || recoveryError) { settleFlush(); return; }
    for (const entry of pending) {
      if (active >= maxInFlight) break;
      if (entry.status === 'sending' || entry.status === 'acknowledged') continue;
      // Do not let later saves overtake a slow/failed earlier save.
      if (!entry.saved || entry.error || entry.blocked) break;
      let editable = false;
      try { editable = Boolean(canEdit(entry.action)); } catch (error) { report(error); }
      if (!editable) { entry.blocked = true; entry.error = errorWith('Notebook lease lost', 'notebook_lease_lost'); break; }
      entry.status = 'sending'; active++;
      const attempt = generation;
      Promise.resolve().then(() => publish(entry.action)).then(result => {
        if (disposed || attempt !== generation) return;
        try { ack(result); } catch (error) { markFailure(entry, error, 'protocol'); }
      }, error => { if (!disposed && attempt === generation) markFailure(entry, error, 'transport'); }).finally(() => {
        if (disposed || attempt !== generation) return;
        active--; schedule();
      });
    }
    settleFlush();
  }
  function schedule() {
    if (scheduled || disposed) return;
    scheduled = true;
    queueMicrotask(() => { scheduled = false; pump(); });
  }
  function enqueue(input, restoring = false) {
    assertOpen();
    const action = normalize(input), existing = byId.get(action.actionId);
    if (existing) {
      if (!equivalent(existing.action, action)) throw errorWith('Notebook action identity reused with different content', 'notebook_identity_collision');
      return existing.handle;
    }
    if (!restoring && !canEdit(action)) throw errorWith('Notebook lease lost', 'notebook_lease_lost');
    const size = new TextEncoder().encode(JSON.stringify(action)).byteLength;
    if (pending.length >= maxPending || bytes + size > maxPendingBytes) throw errorWith('Notebook queue full; keep input for retry', 'notebook_queue_full');
    const entry = { action, bytes: size, status: restoring ? 'queued' : 'saving', saved: restoring,
      saving: false, error: null, blocked: false, durable: deferred(), settled: deferred() };
    const next = preview(entry, optimistic, true);
    if (!restoring && entry.blocked) throw errorWith('Notebook target missing', 'notebook_target_missing');
    entry.handle = Object.freeze({ actionId: action.actionId, inverseOps: entry.inverseOps,
      durable: entry.durable.promise, settled: entry.settled.promise });
    pending.push(entry); byId.set(action.actionId, entry); bytes += size; optimistic = next;
    if (restoring) entry.durable.resolve(); else persist(entry);
    notify('enqueue', action.actionId); schedule(); return entry.handle;
  }
  function advanceNextCommit() {
    const result = commits.get(confirmed.revision + 1);
    const entry = byId.get(result.actionId);
    const matchesPreview = pending[0] === entry && entry && !entry.blocked
      && equivalent(entry.previewOps, result.ops ?? result.appliedOps ?? [])
      && equivalent(entry.previewBackground, result.background ?? result.appliedBackground ?? null);
    const next = advance(confirmed, result.ops ?? result.appliedOps ?? [], result.background ?? result.appliedBackground ?? null, result);
    // Never discard a received revision before its atomic application succeeds.
    confirmed = next; commits.delete(result.revision);
    removeEntry(entry, result); rememberCommit(result);
    return !matchesPreview;
  }
  function drainCommits() {
    if (recovery) return; // its runner owns draining and the next replay boundary
    if (cooperativeRecovery && commits.size > 32 && commits.has(confirmed.revision + 1)) {
      rebuild(true); return;
    }
    let mustRebuild = false;
    while (commits.has(confirmed.revision + 1)) {
      if (advanceNextCommit()) mustRebuild = true;
    }
    if (!pending.length) { optimistic = confirmed; finishRecovery(); }
    else if (mustRebuild || recovery) rebuild();
  }
  function ack(result) {
    if (disposed) return false;
    if (!result || !String(result.actionId ?? '') || !safeRevision(result.revision)) throw new TypeError('Invalid notebook acknowledgement');
    assertNotebookCommitReadable(result, 1);
    const operations = result.ops ?? result.appliedOps ?? [];
    if (!Array.isArray(operations) || !operations.every(isAuthoritativeBoardOperation)) throw new TypeError('Invalid committed notebook operations');
    const entry = byId.get(String(result.actionId));
    if (result.changed === false || result.accepted === false) {
      if (!entry) return true;
      if (result.accepted === false || result.rejectedObjectIds?.length
        || result.skippedConflicts?.length && !entry.action.history) return reject(result);
      removeEntry(entry, clone(result)); rebuild(); notify('ack', result.actionId); schedule(); return true;
    }
    const recent = recentCommits.get(result.revision);
    if (recent) {
      if (!equivalent(recent.payload, committedPayload(result))) {
        throw errorWith('Conflicting notebook revision', 'notebook_revision_conflict');
      }
      if (!entry) return true;
    }
    const copy = freezeNotebookRecord(clone({ ...result, ops: operations }));
    if (entry) entry.status = 'acknowledged';
    if (copy.revision <= confirmed.revision) { removeEntry(entry, copy); rebuild(); }
    else {
      if (commits.size >= maxPending * 2 && !commits.has(copy.revision)) throw errorWith('Notebook revision gap requires a checkpoint', 'notebook_revision_gap');
      const prior = commits.get(copy.revision);
      if (prior && (prior.actionId !== copy.actionId || prior.clientId !== copy.clientId
        || !equivalent(prior.ops, copy.ops) || !equivalent(prior.background, copy.background))) {
        throw errorWith('Conflicting notebook revision', 'notebook_revision_conflict');
      }
      commits.set(copy.revision, copy); drainCommits();
    }
    notify('ack', result.actionId); schedule(); return true;
  }
  function reject(result) {
    if (disposed) return false;
    const entry = byId.get(String(result?.actionId ?? '')); if (!entry) return false;
    const error = errorWith('Notebook action rejected by authority', 'notebook_action_rejected');
    error.outcome = clone(result); entry.settled.reject(error);
    removeEntry(entry, result); rebuild(); notify('reject', result.actionId); schedule(); return true;
  }
  function rebase(value) {
    assertOpen();
    if (!safeRevision(value?.revision)) throw new TypeError('Invalid notebook checkpoint revision');
    if (value.revision < confirmed.revision) return false;
    confirmed = checkpoint(value); generation++; active = 0;
    const acknowledged = new Set(value.acknowledgedActionIds ?? []);
    for (const [revision, result] of commits) {
      if (revision <= confirmed.revision) { acknowledged.add(result.actionId); removeEntry(byId.get(result.actionId), result); commits.delete(revision); }
    }
    for (const entry of [...pending]) {
      if (acknowledged.has(entry.action.actionId)) { removeEntry(entry, { actionId: entry.action.actionId, revision: confirmed.revision, recovered: true }); continue; }
      if (entry.status === 'sending' || entry.status === 'acknowledged') entry.status = entry.saved ? 'queued' : 'saving';
    }
    rebuild(); drainCommits(); notify('rebase'); schedule(); return true;
  }
  function pause(reason = 'Notebook transmission paused') {
    assertOpen(); paused = reason instanceof Error ? reason : errorWith(String(reason), 'notebook_paused'); notify('pause');
  }
  function resume() {
    assertOpen(); paused = null; storageFailure = null;
    for (const entry of pending) {
      entry.error = null; entry.failureKind = null;
      if (entry.status === 'failed') entry.status = entry.saved ? 'queued' : 'saving';
      if (!entry.saved) persist(entry);
    }
    // Retry only removals already justified by an authoritative acknowledgement.
    for (const id of [...cleanup.keys()]) {
      cleanup.delete(id); forgetDurable({ action: { actionId: id } });
    }
    rebuild(); notify('resume'); schedule();
  }
  function flush() {
    if (!pending.length && !cleanup.size && !disposed && !recovery && !recoveryError) return Promise.resolve(view(confirmed));
    const failure = flushFailure(); if (failure) return Promise.reject(failure);
    const waiter = deferred(); flushWaiters.add(waiter); schedule(); return waiter.promise;
  }
  function exportPending() { return pending.map(entry => clone(entry.action)); }
  function dispose() {
    if (disposed) return [];
    const retained = exportPending(); disposed = true; generation++;
    const error = errorWith('Notebook session disposed; pending intents retained', 'notebook_disposed');
    recovery?.ready.reject(error); recovery = null; recoveryVersion++;
    for (const entry of pending) { entry.settled.reject(error); if (!entry.saved) entry.durable.reject(error); }
    settleFlush(); pending = []; byId.clear(); settledIds.clear(); commits.clear(); recentCommits.clear(); recentCommitBytes = 0; bytes = 0; return retained;
  }
  try { for (const input of initialPendingActions) enqueue(input, true); }
  catch (error) { dispose(); throw error; }
  return { enqueue: input => enqueue(input), ack, reject, rebase, pause, resume, flush, dispose, exportPending,
    whenReconciled, isRecovering: () => Boolean(recovery),
    pendingCount: () => pending.length, pendingBytes: () => bytes, getState: () => view(optimistic),
    getConfirmedState: () => view(confirmed) };
}
