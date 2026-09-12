function safeRevision(value) {
  const revision = Number(value ?? 0);
  return Number.isInteger(revision) && revision >= 0 ? revision : 0;
}

export function createAuthoritativeSnapshotGate({
  isReady = () => false,
  applySnapshot,
} = {}) {
  if (typeof applySnapshot !== 'function') throw new Error('applySnapshot is required');

  let pending = null;
  let closed = false;
  let latestRevision = -1;

  const apply = async (snapshot, revision) => {
    if (closed || !snapshot?.canvas) return false;
    await applySnapshot(snapshot, safeRevision(revision));
    return true;
  };

  const settleSuperseded = (nextRevision) => {
    if (!pending) return;
    if (safeRevision(nextRevision) < pending.revision) return;
    const previous = pending;
    pending = null;
    previous.resolve(false);
  };

  return {
    getLatestRevision() {
      return latestRevision;
    },

    shouldApplyRecovery(revision) {
      return safeRevision(revision) > latestRevision;
    },

    receive(snapshot, revision) {
      const normalizedRevision = safeRevision(revision);
      if (closed || !snapshot?.canvas) return Promise.resolve(false);
      if (normalizedRevision < latestRevision) return Promise.resolve(false);
      latestRevision = Math.max(latestRevision, normalizedRevision);
      if (isReady()) return apply(snapshot, normalizedRevision);

      if (pending && normalizedRevision < pending.revision) return Promise.resolve(false);
      settleSuperseded(normalizedRevision);
      return new Promise((resolve, reject) => {
        pending = {
          snapshot,
          revision: normalizedRevision,
          resolve,
          reject,
        };
      });
    },

    async flush() {
      if (closed || !isReady() || !pending) return false;
      const current = pending;
      pending = null;
      try {
        const applied = await apply(current.snapshot, current.revision);
        current.resolve(applied);
        return applied;
      } catch (error) {
        current.reject(error);
        throw error;
      }
    },

    close(error = new Error('Authoritative snapshot gate closed')) {
      if (closed) return;
      closed = true;
      if (pending) {
        const current = pending;
        pending = null;
        current.reject(error);
      }
    },
  };
}
