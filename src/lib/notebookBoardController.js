import { createNotebookSession } from './notebookSession.js';
import { operationObjectIds } from './operationProtocol.js';
import { randomToken } from './ids.js';

const shallowEqual = (a, b) => {
  if (a === b) return true;
  if (!a || !b) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => Object.is(a[key], b[key]));
};
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
  let latest = confirmedState, previousIndex = index(confirmedState), generation = 0;
  let disposed = false, scheduled = false, paintError = null, paintTask = Promise.resolve(), suspended = 0, mutedIds = null;
  const dirty = new Set(), pendingIds = new Map(), reorderIds = new Set();
  for (const action of initialPendingActions) pendingIds.set(String(action.actionId), operationObjectIds(action.ops));
  const report = error => { try { onError(error); } catch { /* observer */ } };
  const emitPending = event => { try { onPending(event); } catch (error) { report(error); } };

  function schedulePaint() {
    if (disposed || suspended || scheduled || !dirty.size || paintError) return;
    scheduled = true;
    paintTask = paintTask.catch(() => {}).then(async () => {
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
        }
      } finally { scheduled = false; }
    });
    paintTask.catch(() => {});
  }
  function changed(view, event) {
    if (disposed) return;
    if (view.snapshot !== latest?.snapshot) {
      const next = index(view);
      for (const [id, object] of next) if (!mutedIds?.has(id) && !shallowEqual(previousIndex.get(id), object)) dirty.add(id);
      for (const id of previousIndex.keys()) if (!mutedIds?.has(id) && !next.has(id)) dirty.add(id);
      previousIndex = next; generation++;
    }
    latest = view;
    if (!event.pendingCount) pendingIds.clear();
    emitPending(event); schedulePaint();
  }
  const session = createNotebookSession({ ...options, confirmedState, initialPendingActions,
    maxInFlight: options.maxInFlight ?? 1, onError: report, onChange: changed });
  latest = session.getState();
  previousIndex = index(latest);
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
    try {
      markOperations(action?.ops);
      const handle = session.enqueue({ ...action, actionId });
      handle.settled.then(() => forget(actionId), () => forget(actionId));
      return handle;
    } catch (error) { forget(actionId); throw error; }
  }
  async function whenPainted() {
    do { await paintTask; } while (scheduled);
    if (paintError) throw paintError;
  }
  return {
    enqueue,
    ack(result, { paint: project = true } = {}) {
      let accepted;
      mutedIds = project ? null : operationObjectIds(result.ops ?? result.appliedOps);
      try { if (project) markOperations(result.ops ?? result.appliedOps); accepted = session.ack(result); }
      finally { mutedIds = null; }
      // A future out-of-order acknowledgement is still pending in the session.
      if (result.revision <= session.getConfirmedState().revision || result.changed === false) forget(result.actionId);
      return accepted;
    },
    rebase: value => session.rebase(value),
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
    dispose() { disposed = true; generation++; dirty.clear(); pendingIds.clear(); return session.dispose(); },
  };
}
