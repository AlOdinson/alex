function safeRevision(value) {
  const revision = Number(value ?? 0);
  return Number.isInteger(revision) && revision >= 0 ? revision : 0;
}

export function createStudentPeerSession({
  transport,
  getRevision,
  applyCommit,
  installSnapshot,
  onAck = () => {},
  onError = () => {},
} = {}) {
  if (!transport?.send) throw new Error('peer transport is required');
  if (typeof getRevision !== 'function') throw new Error('getRevision is required');
  if (typeof applyCommit !== 'function') throw new Error('applyCommit is required');
  if (typeof installSnapshot !== 'function') throw new Error('installSnapshot is required');

  let applyQueue = Promise.resolve();

  const requestSync = () => transport.send('sync-request', {
    revision: safeRevision(getRevision()),
  });

  const enqueue = (work) => {
    const task = applyQueue.then(work);
    applyQueue = task.catch((error) => {
      try { onError(error); } catch { /* observer errors are ignored */ }
    });
    return task;
  };

  return {
    start() {
      return requestSync();
    },

    handleMessage(message) {
      const type = String(message?.type ?? '');
      const payload = message?.payload && typeof message.payload === 'object'
        ? message.payload
        : {};

      if (type === 'head') {
        if (safeRevision(payload.revision) > safeRevision(getRevision())) return requestSync();
        return Promise.resolve();
      }

      if (type === 'ack') {
        onAck(payload);
        return Promise.resolve();
      }

      if (type !== 'commit') return Promise.resolve();

      return enqueue(async () => {
        const currentRevision = safeRevision(getRevision());
        const incomingRevision = safeRevision(payload.revision);
        if (incomingRevision <= currentRevision) return;
        if (incomingRevision !== currentRevision + 1) {
          await requestSync();
          return;
        }
        await applyCommit(payload);
      });
    },

    handleTransfer(transfer) {
      if (transfer?.kind !== 'snapshot') return Promise.resolve();
      return enqueue(async () => {
        const parsed = JSON.parse(String(transfer?.text ?? ''));
        const revision = safeRevision(parsed?.revision);
        if (!parsed || typeof parsed !== 'object' || !parsed.snapshot) {
          throw new Error('Invalid authoritative snapshot transfer');
        }
        if (revision < safeRevision(getRevision())) return;
        await installSnapshot(parsed.snapshot, revision);
      });
    },

    proposeAction(action) {
      const payload = {
        ...(action && typeof action === 'object' ? action : {}),
        baseRevision: safeRevision(getRevision()),
      };
      return transport.send('action-proposal', payload);
    },

    whenIdle() {
      return applyQueue;
    },
  };
}
