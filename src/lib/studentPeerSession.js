import { createIntegrityPeerClient } from './boardIntegrityPeer.js';
import { validIntegrityIds } from './boardIntegrityData.js';

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
  integrityVersion = 0,
  onIntegrityInfo = () => {},
  onIntegrityHint = () => {},
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
  let awaitingInitialSnapshot = false;
  let initialSyncTargetRevision = 0;
  let resolveInitialSync;
  let rejectInitialSync;
  const initialSync = new Promise((resolve, reject) => {
    resolveInitialSync = resolve;
    rejectInitialSync = reject;
  });
  const lockWaiters = new Map();
  const actionWaiters = new Map();
  const integrity = createIntegrityPeerClient({ send: (type, data) => transport.send(type, data) });
  const capability = integrityVersion === 1 ? { integrityVersion: 1 } : {};
  const configureIntegrity = (payload) => {
    if (integrityVersion !== 1) return;
    const info = integrity.configure(payload?.integrity);
    try { onIntegrityInfo(info); } catch { /* optional audit observer */ }
    const ids = payload?.integrity?.checkIds;
    if (info && validIntegrityIds(ids)) {
      try { onIntegrityHint(ids); } catch { /* optional audit observer */ }
    }
  };

  const requestSync = () => transport.send('sync-request', {
    revision: safeRevision(getRevision()), ...capability,
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
    const task = applyQueue.then(() => {
      if (closed) return;
      return work();
    });
    applyQueue = task.catch((error) => {
      // Parsing, replica or canvas installation failures must reject startup too.
      // Logging alone leaves the runtime and every queued edit waiting forever.
      if (initialSyncStarted) failInitialSync(error);
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
        initialSyncTargetRevision = safeRevision(getRevision());
        awaitingInitialSnapshot = initialSyncTargetRevision === 0;
        try {
          // A clean replica needs the full baseline, including imported/copied
          // objects at revision zero. Replaying every historical stroke is both
          // expensive to render and insufficient for a populated revision-zero board.
          const request = awaitingInitialSnapshot
            ? transport.send('snapshot-request', capability)
            : requestSync();
          Promise.resolve(request).catch(failInitialSync);
        } catch (error) {
          failInitialSync(error);
        }
      }
      return initialSync;
    },

    handleMessage(message) {
      if (closed) return Promise.resolve();
      const type = String(message?.type ?? '');
      const payload = message?.payload && typeof message.payload === 'object'
        ? message.payload
        : {};

      if (type === 'integrity-result') { integrity.handleMessage(message); return Promise.resolve(); }

      if (type === 'head') {
        return enqueue(async () => {
          configureIntegrity(payload);
          const headRevision = safeRevision(payload.revision);
          if (!initialSyncSettled) {
            initialSyncTargetRevision = Math.max(initialSyncTargetRevision, headRevision);
          }
          if (awaitingInitialSnapshot) return;
          if (headRevision > safeRevision(getRevision())
            || (!initialSyncSettled && initialSyncTargetRevision > safeRevision(getRevision()))) {
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
        if (!initialSyncSettled) {
          initialSyncTargetRevision = Math.max(initialSyncTargetRevision, incomingRevision);
        }
        // Do not advance an empty replica before its baseline arrives. The snapshot
        // either covers these commits or we request the remaining authoritative tail
        // after installation; no unbounded duplicate commit buffer is needed.
        if (awaitingInitialSnapshot) return;
        if (incomingRevision <= currentRevision) return;
        if (incomingRevision !== currentRevision + 1) {
          await requestSync();
          return;
        }
        await applyCommit(payload);
      });
    },

    handleTransfer(transfer) {
      if (closed) return Promise.resolve();
      if (transfer?.kind === 'integrity-result') { integrity.handleTransfer(transfer); return Promise.resolve(); }
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
        if (closed) return;
        configureIntegrity(parsed);
        awaitingInitialSnapshot = false;
        if (!initialSyncSettled && initialSyncTargetRevision > revision) {
          await requestSync();
          return;
        }
        markInitialSyncReady();
      });
    },

    requestIntegrity(payload) { return integrity.request(payload); },
    getIntegrityInfo() { return integrity.getInfo(); },
    requestIntegritySync() { return requestSync(); },

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
      integrity.close();
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
