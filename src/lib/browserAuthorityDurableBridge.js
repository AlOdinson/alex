import { randomToken } from './ids.js';

function safeRevision(value) {
  const revision = Number(value ?? 0);
  return Number.isInteger(revision) && revision >= 0 ? revision : 0;
}

function cloneArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeDurableResult(result, { actionId, fallbackOps, fallbackBackground }) {
  const source = result && typeof result === 'object' ? result : {};
  const rejectedObjectIds = cloneArray(source.rejectedObjectIds).map(String).filter(Boolean);
  const accepted = source.accepted !== false && rejectedObjectIds.length === 0;
  const changed = accepted && source.changed !== false;
  const appliedOps = Object.prototype.hasOwnProperty.call(source, 'appliedOps')
    ? cloneArray(source.appliedOps)
    : (changed ? cloneArray(source.ops ?? fallbackOps) : []);
  const appliedBackground = Object.prototype.hasOwnProperty.call(source, 'appliedBackground')
    ? (source.appliedBackground ?? null)
    : (changed ? (source.background ?? fallbackBackground ?? null) : null);

  return {
    actionId: String(source.actionId ?? actionId ?? ''),
    revision: safeRevision(source.revision),
    needsSync: Boolean(source.needsSync),
    updatedAt: Number(source.committedAt ?? Date.now()),
    alreadyApplied: Boolean(source.duplicate),
    accepted,
    changed,
    appliedOps,
    appliedBackground,
    rejectedObjectIds,
    skippedConflicts: cloneArray(source.skippedConflicts),
  };
}

export function createBrowserAuthorityDurableBridge({
  runtime,
  clientId,
  createActionId = () => randomToken(24),
} = {}) {
  const safeClientId = String(clientId ?? '').trim();
  if (!safeClientId) throw new Error('clientId is required');

  return {
    async sendOps(ops, { background = null, actionId = null } = {}) {
      const safeOps = Array.isArray(ops) ? ops.filter(Boolean) : [];
      if (!safeOps.length && background == null) return null;
      const resolvedActionId = String(actionId ?? createActionId()).trim();
      if (!resolvedActionId) throw new Error('actionId is required');
      const action = {
        actionId: resolvedActionId,
        clientId: safeClientId,
        baseRevision: safeRevision(runtime?.getRevision?.()),
        ops: safeOps,
        background,
      };

      let result;
      if (typeof runtime?.commitTeacherAction === 'function') {
        result = await runtime.commitTeacherAction(action);
      } else if (typeof runtime?.proposeActionAndWait === 'function') {
        result = await runtime.proposeActionAndWait(action);
      } else {
        throw new Error('Browser durable runtime is unavailable');
      }

      return normalizeDurableResult(result, {
        actionId: resolvedActionId,
        fallbackOps: safeOps,
        fallbackBackground: background,
      });
    },
  };
}
