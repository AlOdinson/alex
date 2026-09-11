function cloneValue(value) {
  if (value == null || typeof value !== 'object') return value;
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function normalizeAction(action) {
  const actionId = String(action?.actionId ?? '').trim();
  if (!actionId) throw new Error('actionId is required');
  const ops = Array.isArray(action?.ops) ? cloneValue(action.ops) : [];
  return {
    actionId,
    clientId: String(action?.clientId ?? ''),
    baseRevision: Math.max(0, Number(action?.baseRevision ?? 0) || 0),
    ops,
    background: action?.background ?? null,
  };
}

export function createTeacherAuthority({ initialRevision = 0, persistCommit }) {
  if (typeof persistCommit !== 'function') throw new Error('persistCommit is required');

  let revision = Math.max(0, Number(initialRevision ?? 0) || 0);
  let queue = Promise.resolve();
  const committedByActionId = new Map();

  const commitOne = async (input) => {
    const action = normalizeAction(input);
    const previous = committedByActionId.get(action.actionId);
    if (previous) return { ...cloneValue(previous), duplicate: true };

    const commit = {
      ...action,
      revision: revision + 1,
      needsSync: action.baseRevision < revision,
      committedAt: Date.now(),
      duplicate: false,
    };

    await persistCommit(cloneValue(commit));

    revision = commit.revision;
    committedByActionId.set(action.actionId, cloneValue(commit));
    return cloneValue(commit);
  };

  return {
    getRevision() {
      return revision;
    },
    commitAction(action) {
      const task = queue.then(() => commitOne(action));
      queue = task.catch(() => undefined);
      return task;
    },
  };
}
