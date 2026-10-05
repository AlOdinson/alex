import { readSnapshotRecord } from './indexedBoardModel.js';
import { operationObjectIds } from './operationProtocol.js';

/** The UI revision advances only after the contiguous confirmed model is painted.
 * Legacy-rendered commits are acknowledged only once that legacy path has applied
 * them. Scoped recovery records fold actual confirmed state, not optimistic ink.
 */
export function createNotebookCommitBridge({ getController, getRevision, setRevision, remember } = {}) {
  const pending = new Map();
  return {
    ack(result, { managed = false, paint = managed } = {}) {
      const controller = getController();
      if (!controller) return false;
      const accepted = controller.ack(result, { paint });
      if (accepted && managed && result.changed !== false && result.accepted !== false) {
        pending.set(String(result.actionId), { revision: result.revision, ids: operationObjectIds(result.ops ?? result.appliedOps) });
      }
      return accepted;
    },
    async settle() {
      const controller = getController();
      if (!controller) return false;
      await controller.whenPainted();
      if (getController() !== controller) return false;
      const confirmed = controller.getConfirmedState();
      const eligible = [...pending].filter(([, entry]) => entry.revision <= confirmed.revision);
      if (eligible.length) {
        const ids = new Set(eligible.flatMap(([, entry]) => [...entry.ids]));
        remember([...ids].map(id => {
          const record = readSnapshotRecord(confirmed.snapshot, id);
          return record ? { type: 'upsert', ...record, preserveOrder: true } : { type: 'delete', id };
        }), confirmed.revision);
        eligible.forEach(([id]) => pending.delete(id));
      }
      if (confirmed.revision >= getRevision()) setRevision(confirmed.revision);
      return true;
    },
    clear() { pending.clear(); },
  };
}
