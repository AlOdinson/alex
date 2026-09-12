function safeRevision(value) {
  const revision = Number(value ?? 0);
  return Number.isInteger(revision) && revision >= 0 ? revision : 0;
}

function defaultRequestId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `lock-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function createStudentPeerSession({
  transport,
  getRevision,
  applyCommit,
  installSnapshot,
  onAck = () => {},
  onError = () => {},
  createRequestId = defaultRequestId,
} = {}) {
  if (!transport?.send) throw new Error('peer transport is required');
  if (typeof getRevision !== 'function') throw new Error('getRevision is required');
  if (typeof applyCommit !== 'function') throw new Error('applyCommit is required');
  if (typeof installSnapshot !== 'function') throw new Error('installSnapshot is required');

  let applyQueue = Promise.resolve();
  let closed = false;
  let initialSyncStarted = false;
  let initialSyncSettled = false;
  let resolveInitialSync;
  let rejectInitialSync;
  const initialSync = new Promise((resolve, reject) => {
    resolveInitialSync = resolve;
    rejectInitialSync = reject;
  });
  const lockWaiters = new Map();
  const actionWaiters = new Map();

  const requestSync = () => transport.send('sync-request', {
    revision: safeRevision(getRevision()),
  });

  const markInitialSyncReady = () => {
    if (initialSyncSettled || closed) return;
    initialSyncSettled = true;
    resolveInitialSync();
  };

  const failInitialSync = (error) => {
    if (initialSyncSettled) return;
    initialSyncSettled = true;
    rejectInitialSync(error instanceof Error ? error : new Error(String(error)));
  };

  const enqueue = (work) => {
    const task = applyQueue.then(work);
    applyQueue = task.catch((error) => {
      try { onError(error); } catch { /* observer errors are ignored */ }
    });
    return task;
  };

  const actionProposalPayload = (action) => ({
    ...(action && typeof action === 'object' ? action : {}),
    baseRevision: safeRevision(getRevision()),
  });

  return {
    start() {
      if (closed) return Promise.reject(new Error('Student peer session is closed'));
      if (!initialSyncStarted) {
        initialSyncStarted = true;
        Promise.resolve(requestSync()).catch(failInitialSync);
      }
      return initialSync;
    },

    handleMessage(message) {
      const type = String(message?.type ?? '');
      const payload = message?.payload && typeof message.payload === 'object'
        ? message.payload
        : {};

      if (type === 'head') {
        return enqueue(async () => {
          if (safeRevision(payload.revision) > safeRevision(getRevision())) {
            await requestSync();
            return;
          }
          markInitialSyncReady();
        });
      }

      if (type === 'ack') {
        onAck(payload);
        const actionId = String(payload.actionId ?? '').trim();
        const waiter = actionWaiters.get(actionId);
        if (waiter) {
          actionWaiters.delete(actionId);
          waiter.resolve(payload);
        }
        return Promise.resolve();
      }

      if (type === 'lock-result') {
        const requestId = String(payload.requestId ?? '');
        const waiter = lockWaiters.get(requestId);
        if (waiter) {
          lockWaiters.delete(requestId);
          waiter.resolve(payload);
        }
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
        if (revision < safeRevision(getRevision())) {
          await requestSync();
          return;
        }
        await installSnapshot(parsed.snapshot, revision);
        markInitialSyncReady();
      });
    },

    proposeAction(action) {
      return transport.send('action-proposal', actionProposalPayload(action));
    },

    proposeActionAndWait(action) {
      if (closed) return Promise.reject(new Error('Student peer session is closed'));
      const payload = actionProposalPayload(action);
      const actionId = String(payload.actionId ?? '').trim();
      if (!actionId) return Promise.reject(new Error('actionId is required'));
      if (actionWaiters.has(actionId)) {
        return Promise.reject(new Error('Action is already awaiting acknowledgement'));
      }

      const task = new Promise((resolve, reject) => {
        actionWaiters.set(actionId, { resolve, reject });
      });
      Promise.resolve(transport.send('action-proposal', payload)).catch((error) => {
        const waiter = actionWaiters.get(actionId);
        if (!waiter) return;
        actionWaiters.delete(actionId);
        waiter.reject(error);
      });
      return task;
    },

    requestLock(operation, payload = {}) {
      const safeOperation = String(operation ?? '').trim();
      if (!['acquire', 'refresh', 'release'].includes(safeOperation)) {
        return Promise.reject(new Error('Unsupported lock operation'));
      }
      const requestId = String(createRequestId()).trim();
      if (!requestId) return Promise.reject(new Error('Lock request id is required'));
      if (lockWaiters.has(requestId)) return Promise.reject(new Error('Duplicate lock request id'));

      const task = new Promise((resolve, reject) => {
        lockWaiters.set(requestId, { resolve, reject, operation: safeOperation });
      });
      Promise.resolve(transport.send('lock-request', {
        requestId,
        operation: safeOperation,
        ...(payload && typeof payload === 'object' ? payload : {}),
      })).catch((error) => {
        const waiter = lockWaiters.get(requestId);
        if (!waiter) return;
        lockWaiters.delete(requestId);
        waiter.reject(error);
      });
      return task;
    },

    whenIdle() {
      return applyQueue;
    },

    close(error = new Error('Student peer session is closed')) {
      if (closed) return;
      closed = true;
      const reason = error instanceof Error
        ? error
        : new Error(String(error ?? 'Student peer session is closed'));
      failInitialSync(reason);
      for (const waiter of actionWaiters.values()) waiter.reject(reason);
      actionWaiters.clear();
      for (const waiter of lockWaiters.values()) waiter.reject(reason);
      lockWaiters.clear();
    },
  };
}
