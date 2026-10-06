import { changedSnapshotObjectIds, readSnapshotRecord } from './indexedBoardModel.js';
import { createNotebookSession } from './notebookSession.js';
import { operationObjectIds } from './operationProtocol.js';
import { randomToken } from './ids.js';

const shallowEqual = (a, b) => {
  if (a === b) return true;
  if (!a || !b) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => Object.is(a[key], b[key]));
};
const PROJECTION_SLICE_MS = 4;
const yieldBrowserTask = () => new Promise(resolve => setTimeout(resolve, 0));
const index = view => new Map((view?.snapshot?.canvas?.objects ?? []).map(object => [String(object.boardObjectId), object]));

/**
 * Owns one board/client's confirmed+pending session and its Canvas projection.
 * Network acknowledgement never blocks enqueue or preview. Projection work is
 * coalesced by model generation, not by dropping independent drawing intents.
 * No polling or whole-board snapshots are scheduled here.
 */
export function createNotebookBoardController({ confirmedState, paint, onError = () => {}, onPending = () => {},
  initialPendingActions = [], ...options } = {}) {
  if (typeof paint !== 'function') throw new TypeError('Notebook controller requires a projection callback');
  let latest = confirmedState, generation = 0, notifications = 0;
  let disposed = false, scheduled = false, paintError = null, paintTask = Promise.resolve(), suspended = 0, mutedIds = null;
  const dirty = new Set(), pendingIds = new Map(), reorderIds = new Set(), recoveryMutedIds = new Set();
  for (const action of initialPendingActions) pendingIds.set(String(action.actionId), operationObjectIds(action.ops));
  const report = error => { try { onError(error); } catch { /* observer */ } };
  const emitPending = event => { try { onPending(event); } catch (error) { report(error); } };

  function schedulePaint() {
    if (disposed || suspended || scheduled || !dirty.size || paintError) return;
    scheduled = true;
    paintTask = paintTask.catch(() => {}).then(async () => {
      let sliceStarted = performance.now();
      try {
        while (!disposed && !suspended && dirty.size) {
          const ids = new Set(dirty), ticket = generation, view = latest, reorders = new Set(reorderIds);
          dirty.clear();
          const isCurrent = () => !disposed && ticket === generation;
          try {
            const applied = await paint(view, { objectIds: ids, reorderIds: reorders, isCurrent, generation: ticket });
            if (!disposed && (applied === false || !isCurrent())) {
              ids.forEach(id => dirty.add(id));
              if (isCurrent()) throw new Error('Notebook projection could not install its current model');
            } else if (isCurrent()) reorders.forEach(id => reorderIds.delete(id));
          } catch (error) {
            ids.forEach(id => dirty.add(id));
            paintError = error; report(error); throw error;
          }
          // Yield only BETWEEN complete projections. A chain of already-resolved
          // promises otherwise drains all corrections before native input can
          // run. Never yield inside installation or drop a user's queued intent.
          if (!disposed && !suspended && dirty.size && performance.now() - sliceStarted >= PROJECTION_SLICE_MS) {
            await yieldBrowserTask();
            sliceStarted = performance.now();
          }
        }
      } finally { scheduled = false; }
    });
    paintTask.catch(() => {});
  }
  function changed(view, event) {
    if (disposed) return;
    notifications++;
    const excluded = (event.reason === 'recovered' || event.reason === 'recovery-progress') ? new Set([...(mutedIds ?? []), ...recoveryMutedIds]) : mutedIds;
    if (event.reason === 'recovered') recoveryMutedIds.clear();
    if (view.snapshot !== latest?.snapshot) {
      const touched = changedSnapshotObjectIds(latest?.snapshot, view.snapshot);
      if (touched) {
        for (const id of touched) if (!excluded?.has(id) && !shallowEqual(
          readSnapshotRecord(latest.snapshot, id)?.object, readSnapshotRecord(view.snapshot, id)?.object)) dirty.add(id);
      } else {
        // A new layout/checkpoint is the explicit full-diff boundary.
        const previous = index(latest), next = index(view);
        for (const [id, object] of next) if (!excluded?.has(id) && !shallowEqual(previous.get(id), object)) dirty.add(id);
        for (const id of previous.keys()) if (!excluded?.has(id) && !next.has(id)) dirty.add(id);
      }
      generation++;
    }
    latest = view;
    event.settledActionIds?.forEach(id => pendingIds.delete(String(id)));
    if (!event.pendingCount) pendingIds.clear();
    emitPending(event); schedulePaint();
  }
  const session = createNotebookSession({ cooperativeRecovery: true, ...options, confirmedState, initialPendingActions,
    maxInFlight: options.maxInFlight ?? 1, onError: report, onChange: changed });
  latest = session.getState();
  // Restored intents have no returned handles in the constructor. Acknowledgement
  // callbacks remove their pending markers just like ordinary enqueue handles.
  function forget(id) { pendingIds.delete(String(id)); }
  function markOperations(ops) {
    operationObjectIds(ops).forEach(id => dirty.add(id));
    for (const op of ops ?? []) if (op.reorder || op.restore) operationObjectIds([op]).forEach(id => reorderIds.add(id));
  }
  function enqueue(input) {
    const action = input?.type ? { ops: [input] } : input;
    const actionId = String(action?.actionId || randomToken(24));
    pendingIds.set(actionId, operationObjectIds(action?.ops));
    operationObjectIds(action?.ops).forEach(id => recoveryMutedIds.delete(id));
    try {
      markOperations(action?.ops);
      const handle = session.enqueue({ ...action, actionId });
      handle.settled.then(() => forget(actionId), () => forget(actionId));
      return handle;
    } catch (error) { forget(actionId); throw error; }
  }
  async function whenPainted() {
    do { await session.whenReconciled(); await paintTask; } while (scheduled || session.isRecovering());
    if (paintError) throw paintError;
  }
  return {
    enqueue,
    ack(result, { paint: project = true } = {}) {
      let accepted;
      mutedIds = project ? null : operationObjectIds(result.ops ?? result.appliedOps);
      const before = notifications;
      try {
        accepted = session.ack(result);
        // A verified duplicate emits nothing; do not dirty an already-painted
        // page. A newly accepted result still projects even without a model diff.
        if (session.isRecovering()) {
          for (const id of operationObjectIds(result.ops ?? result.appliedOps)) {
            if (project) recoveryMutedIds.delete(id); else recoveryMutedIds.add(id);
          }
          for (const op of result.ops ?? result.appliedOps ?? []) {
            if (project && (op.reorder || op.restore)) operationObjectIds([op]).forEach(id => reorderIds.add(id));
          }
        } else if (project && notifications !== before) { markOperations(result.ops ?? result.appliedOps); schedulePaint(); }
      } finally { mutedIds = null; }
      // A future out-of-order acknowledgement is still pending in the session.
      if (result.revision <= session.getConfirmedState().revision || result.changed === false) forget(result.actionId);
      return accepted;
    },
    rebase(value) { recoveryMutedIds.clear(); return session.rebase(value); },
    async rebaseAsync(value) { recoveryMutedIds.clear(); const accepted = session.rebase(value); await session.whenReconciled(); return accepted; },
    whenReconciled: () => session.whenReconciled(),
    suspendProjection() { suspended++; generation++; },
    resumeProjection() { suspended = Math.max(0, suspended - 1); schedulePaint(); },
    pause: reason => session.pause(reason),
    resume() { session.resume(); this.retryPaint(); },
    retryPaint() { paintError = null; schedulePaint(); },
    whenPainted,
    async flush() { const state = await session.flush(); await whenPainted(); return state; },
    pendingCount: () => session.pendingCount(),
    pendingObjectIds: () => new Set([...pendingIds.values()].flatMap(ids => [...ids])),
    getState: () => session.getState(),
    getConfirmedState: () => session.getConfirmedState(),
    exportPending: () => session.exportPending(),
    dispose() { disposed = true; generation++; dirty.clear(); pendingIds.clear(); recoveryMutedIds.clear(); return session.dispose(); },
  };
}
