import { createBoardIntegritySession } from './boardIntegritySession.js';
import { createBrowserAuthorityDurableBridge } from './browserAuthorityDurableBridge.js';
import { registerBoardRuntime as registerDefaultBoardRuntime } from './browserBoardRuntimeRegistry.js';
import {
  applyReplicaCommit as applyDefaultReplicaCommit,
  getReplicaRevision as getDefaultReplicaRevision,
  getReplicaState as getDefaultReplicaState,
  getReplicaIntegritySource,
  repairReplicaIntegrityRecords,
  installReplicaSnapshot as installDefaultReplicaSnapshot,
} from './browserReplicaStore.js';
import { createStudentBoardRuntime as createDefaultStudentRuntime } from './studentBoardRuntime.js';
import { createTeacherBoardRuntime as createDefaultTeacherRuntime } from './teacherBoardRuntime.js';
import { createTeacherTabAuthority as createDefaultTeacherTabAuthority } from './teacherTabAuthority.js';

const TERMINAL_STUDENT_STATES = new Set(['failed', 'closed']);
const RUNTIME_STATE_EVENT = 'alex-board-runtime-state';

function safeId(value) {
  return String(value ?? '').trim();
}

function safeRevision(value) {
  const revision = Number(value ?? 0);
  return Number.isInteger(revision) && revision >= 0 ? revision : 0;
}

export function createBrowserBoardSession({
  boardId,
  clientId,
  permission,
  sendScreenShareSignal,
  onAuthoritativeCommit = async () => {},
  onAuthoritativeSnapshot = async () => {},
  onPeerState = () => {},
  onRuntimeState = () => {},
  onError = () => {},
  rtcConfig = {},
  integrityCanvas = null,
  createTeacherTabAuthority = createDefaultTeacherTabAuthority,
  createTeacherRuntime = createDefaultTeacherRuntime,
  createStudentRuntime = createDefaultStudentRuntime,
  registerRuntime = registerDefaultBoardRuntime,
  getReplica = getDefaultReplicaState,
  getReplicaRevision = null,
  applyReplicaCommit = applyDefaultReplicaCommit,
  installReplicaSnapshot = installDefaultReplicaSnapshot,
} = {}) {
  const safeBoardId = safeId(boardId);
  const safeClientId = safeId(clientId);
  const isOwner = permission === 'owner';
  if (!safeBoardId) throw new Error('boardId is required');
  if (!safeClientId) throw new Error('clientId is required');
  if (typeof sendScreenShareSignal !== 'function') throw new Error('sendScreenShareSignal is required');

  let runtime = null;
  let connectingRuntime = null;
  let connectingTeacherId = '';
  let unregisterRuntime = null;
  let durableBridge = null;
  let teacherId = '';
  let closed = false;
  let startPromise = null;
  let transitionQueue = Promise.resolve();
  let teacherTabAuthority = null;
  let teacherTabAuthorityHeld = false;
  let teacherTabReadyPromise = null;
  let rejectTeacherTabReady = null;
  let runtimeState = 'idle';
  let replicaNeedsSnapshot = false;
  let desiredTeacherId = '';
  let studentRetryTimer = null;
  let studentRetryFailures = 0;
  let integrity = null;
  let integrityEpoch = '';
  let unsubscribeIntegrityWake = null;
  const reportIntegrityError = (error) => {
    // Additional auditing must not change durable connection/readiness status.
    console.warn('Additional board integrity check deferred', error);
  };
  const stopIntegrity = () => {
    integrity?.close(); integrity = null; integrityEpoch = '';
    try { unsubscribeIntegrityWake?.(); } catch { /* view may already be disposed */ }
    unsubscribeIntegrityWake = null;
  };
  const markIntegrity = (commit) => {
    try { integrity?.markCommit(commit); } catch (error) { reportIntegrityError(error); }
  };
  const setupIntegrity = (nextRuntime, info = null) => {
    if (closed || runtime !== nextRuntime) return;
    const source = isOwner ? nextRuntime.getIntegritySource?.() : null;
    const enabled = isOwner ? source?.version === 1 : info?.version === 1 && info.boardId === safeBoardId;
    const epoch = isOwner ? 'owner' : String(info?.sessionId ?? '');
    if (!enabled) { stopIntegrity(); return; }
    if (integrity && integrityEpoch === epoch) return;
    stopIntegrity(); integrityEpoch = epoch;
    integrity = createBoardIntegritySession({
      getSource: isOwner ? () => nextRuntime.getIntegritySource?.() : () => getReplicaIntegritySource(safeBoardId),
      canvas: integrityCanvas,
      runWork: isOwner ? nextRuntime.runIntegrityWork : undefined,
      requestCheck: isOwner ? null : (payload) => nextRuntime.requestIntegrity(payload),
      repairSource: isOwner ? null : (revision, records, background) => repairReplicaIntegrityRecords(safeBoardId, revision, records, background),
      onAhead: isOwner ? undefined : () => nextRuntime.requestIntegritySync?.(),
      onBatch: isOwner ? (ids, revision) => nextRuntime.broadcastIntegrityHint?.(ids, revision) : undefined,
      onError: reportIntegrityError,
    });
    unsubscribeIntegrityWake = integrityCanvas?.subscribeWake?.(() => integrity?.wake());
    // One event-created initial sample, not a periodic scan. Existing boards never
    // create this coordinator, subscribe wake listeners, or schedule audit timers.
    integrity.markHint([]);
  };

  const cancelStudentRetry = () => {
    clearTimeout(studentRetryTimer);
    studentRetryTimer = null;
  };

  const scheduleStudentRetry = () => {
    if (closed || isOwner || !desiredTeacherId || runtime || connectingRuntime || studentRetryTimer !== null) return;
    const delay = Math.min(15_000, 1000 * (2 ** Math.min(studentRetryFailures++, 4)));
    studentRetryTimer = setTimeout(() => {
      studentRetryTimer = null;
      if (closed || !desiredTeacherId || runtime || connectingRuntime) return;
      // Retrying must not require a new presence event. A failed presence refresh
      // must not leave live Ably previews working with editing blocked forever.
      enqueueTransition(() => startStudent(desiredTeacherId)).catch(() => undefined);
    }, delay);
    studentRetryTimer?.unref?.();
  };
  const runtimeWaiters = new Set();

  const reportRuntimeState = (nextState, error = null) => {
    const normalized = String(nextState || 'waiting');
    if (runtimeState === normalized) return;
    runtimeState = normalized;
    const detail = {
      state: normalized,
      boardId: safeBoardId,
      clientId: safeClientId,
      permission,
      teacherId,
      error: error instanceof Error ? error.message : (error ? String(error) : null),
    };
    try {
      onRuntimeState(normalized, detail);
    } catch {
      // Runtime-state observers are diagnostic/UI only and must never break authority.
    }
    try {
      if (typeof window !== 'undefined'
        && typeof window.dispatchEvent === 'function'
        && typeof CustomEvent === 'function') {
        window.dispatchEvent(new CustomEvent(RUNTIME_STATE_EVENT, { detail }));
      }
    } catch {
      // Browser UI diagnostics/gating must never break the durable authority runtime.
    }
  };

  const replicaRevision = () => replicaNeedsSnapshot ? 0 : safeRevision(
    typeof getReplicaRevision === 'function'
      ? getReplicaRevision(safeBoardId)
      : (getReplica === getDefaultReplicaState
        ? getDefaultReplicaRevision(safeBoardId)
        : getReplica(safeBoardId)?.revision),
  );

  const settleRuntimeWaiters = (nextRuntime) => {
    for (const waiter of runtimeWaiters) waiter.resolve(nextRuntime);
    runtimeWaiters.clear();
  };

  const rejectRuntimeWaiters = (error) => {
    for (const waiter of runtimeWaiters) waiter.reject(error);
    runtimeWaiters.clear();
  };

  const clearRuntime = ({ nextState = closed ? 'closed' : 'waiting' } = {}) => {
    stopIntegrity();
    const previousRuntime = runtime;
    const previousUnregister = unregisterRuntime;
    runtime = null;
    unregisterRuntime = null;
    durableBridge = null;
    previousUnregister?.();
    try { previousRuntime?.close?.(); } catch (error) { onError(error); }
    reportRuntimeState(nextState);
  };

  const clearConnectingRuntime = (expectedRuntime = null, { closeRuntime = true } = {}) => {
    const pending = connectingRuntime;
    if (!pending) return false;
    if (expectedRuntime && pending !== expectedRuntime) return false;
    connectingRuntime = null;
    connectingTeacherId = '';
    if (closeRuntime) {
      try { pending.close?.(); } catch (error) { onError(error); }
    }
    return true;
  };

  const failRuntimeReadiness = (error) => {
    const resolvedError = error instanceof Error ? error : new Error(String(error));
    rejectRuntimeWaiters(resolvedError);
    reportRuntimeState('error', resolvedError);
    return resolvedError;
  };

  const releaseTeacherTabAuthority = (error = new Error('Teacher tab authority was released')) => {
    const authority = teacherTabAuthority;
    teacherTabAuthority = null;
    teacherTabAuthorityHeld = false;
    const rejectReady = rejectTeacherTabReady;
    rejectTeacherTabReady = null;
    teacherTabReadyPromise = null;
    rejectReady?.(error);
    try { authority?.stop?.(); } catch (caught) { onError(caught); }
  };

  const ensureTeacherTabAuthority = () => {
    if (!isOwner) return Promise.resolve();
    if (teacherTabAuthorityHeld) return Promise.resolve();
    if (teacherTabReadyPromise) return teacherTabReadyPromise;

    let settled = false;
    let resolveReady;
    let rejectReadyRaw;
    const ready = new Promise((resolve, reject) => {
      resolveReady = resolve;
      rejectReadyRaw = reject;
    });
    teacherTabReadyPromise = ready;

    const resolveOnce = () => {
      if (settled) return;
      settled = true;
      rejectTeacherTabReady = null;
      resolveReady();
    };
    const rejectOnce = (error) => {
      if (settled) return;
      settled = true;
      rejectTeacherTabReady = null;
      rejectReadyRaw(error instanceof Error ? error : new Error(String(error)));
    };
    rejectTeacherTabReady = rejectOnce;

    let authority = null;
    const handleAuthorityChange = (nextAuthority) => {
      if (teacherTabAuthority !== authority) return;
      const wasAuthority = teacherTabAuthorityHeld;
      teacherTabAuthorityHeld = Boolean(nextAuthority);
      if (teacherTabAuthorityHeld) {
        resolveOnce();
        return;
      }
      if (wasAuthority && !closed) {
        clearRuntime();
        try { onError(new Error('Teacher tab authority was lost')); } catch { /* observer errors are ignored */ }
      }
    };

    try {
      authority = createTeacherTabAuthority({
        boardId: safeBoardId,
        onChange: handleAuthorityChange,
      });
      teacherTabAuthority = authority;
      Promise.resolve(authority.start()).then(() => {
        if (teacherTabAuthority !== authority) return;
        if (!teacherTabAuthorityHeld) rejectOnce(new Error('Teacher tab authority lock was not acquired'));
      }).catch((error) => {
        if (teacherTabAuthority !== authority) return;
        if (!settled) rejectOnce(error);
        else if (!closed) {
          try { onError(error); } catch { /* observer errors are ignored */ }
        }
      });
    } catch (error) {
      teacherTabAuthority = null;
      teacherTabAuthorityHeld = false;
      rejectOnce(error);
    }

    return ready;
  };

  const installRuntime = (nextRuntime, { getRevision = null, integrityInfo = null } = {}) => {
    if (!nextRuntime || typeof nextRuntime !== 'object') throw new Error('Board runtime is required');
    clearRuntime();
    if (typeof nextRuntime.getRevision !== 'function' && typeof getRevision === 'function') {
      nextRuntime.getRevision = getRevision;
    }
    runtime = nextRuntime;
    cancelStudentRetry();
    studentRetryFailures = 0;
    unregisterRuntime = registerRuntime(safeBoardId, nextRuntime);
    durableBridge = createBrowserAuthorityDurableBridge({ runtime: nextRuntime, clientId: safeClientId });
    try { setupIntegrity(nextRuntime, integrityInfo); } catch (error) { stopIntegrity(); reportIntegrityError(error); }
    reportRuntimeState('ready');
    settleRuntimeWaiters(nextRuntime);
    return nextRuntime;
  };

  const startTeacher = async () => {
    await ensureTeacherTabAuthority();
    if (closed) return null;
    if (!teacherTabAuthorityHeld) throw new Error('Teacher tab authority lock is not held');
    let nextRuntime;
    try {
      nextRuntime = await createTeacherRuntime({
        boardId: safeBoardId,
        clientId: safeClientId,
        sendScreenShareSignal,
        rtcConfig,
        onRemoteCommit: async (commit) => {
          try { await onAuthoritativeCommit(commit); }
          finally { if (runtime === nextRuntime) markIntegrity(commit); }
        },
        onPeerState,
        onError,
      });
    } catch (error) {
      releaseTeacherTabAuthority(error);
      throw error;
    }
    if (closed) {
      nextRuntime?.close?.();
      return null;
    }
    if (!teacherTabAuthorityHeld) {
      nextRuntime?.close?.();
      const error = new Error('Teacher tab authority was lost before runtime startup');
      releaseTeacherTabAuthority(error);
      throw error;
    }
    return installRuntime(nextRuntime);
  };

  const startStudent = async (nextTeacherId) => {
    const resolvedTeacherId = safeId(nextTeacherId);
    if (closed || !resolvedTeacherId || resolvedTeacherId !== desiredTeacherId) return null;
    if (runtime && teacherId === resolvedTeacherId) return runtime;
    if (runtime && teacherId !== resolvedTeacherId) clearRuntime();
    reportRuntimeState('waiting');

    let nextRuntime = null;
    let nextIntegrityInfo = null;
    const handleStudentState = (state) => {
      if (closed || !nextRuntime || (runtime !== nextRuntime && connectingRuntime !== nextRuntime)) return;
      const normalizedState = String(state ?? '');
      if (TERMINAL_STUDENT_STATES.has(normalizedState)) {
        if (runtime === nextRuntime) {
          teacherId = '';
          clearRuntime();
          scheduleStudentRetry();
        } else if (connectingRuntime === nextRuntime) {
          teacherId = '';
          reportRuntimeState('waiting');
        }
      }
      onPeerState(state);
    };

    nextRuntime = createStudentRuntime({
      clientId: safeClientId,
      teacherId: resolvedTeacherId,
      sendScreenShareSignal,
      rtcConfig,
      getRevision: replicaRevision,
      integrityVersion: 1,
      onIntegrityInfo: (info) => {
        nextIntegrityInfo = info;
        if (runtime === nextRuntime) {
          try { setupIntegrity(nextRuntime, info); } catch (error) { reportIntegrityError(error); }
        }
      },
      onIntegrityHint: (ids) => {
        if (runtime === nextRuntime) {
          try { integrity?.markHint(ids); } catch (error) { reportIntegrityError(error); }
        }
      },
      applyCommit: async (commit) => {
        const applied = applyReplicaCommit(safeBoardId, commit);
        if (applied?.needsSnapshot) throw new Error('Student replica needs authoritative snapshot');
        if (applied?.applied) {
          try { await onAuthoritativeCommit(commit); }
          finally { if (runtime === nextRuntime) markIntegrity(commit); }
        }
        return applied;
      },
      installSnapshot: async (snapshot, revision) => {
        // The replica is installed before the Canvas callback so repository reads
        // during painting see the new baseline. Keep startup requesting a full
        // snapshot if painting fails; a cached head alone cannot repair the Canvas.
        replicaNeedsSnapshot = true;
        installReplicaSnapshot(safeBoardId, snapshot, revision);
        await onAuthoritativeSnapshot(snapshot, safeRevision(revision));
        replicaNeedsSnapshot = false;
        if (runtime === nextRuntime) integrity?.markHint([]);
      },
      onState: handleStudentState,
      onError,
    });

    if (closed) {
      nextRuntime?.close?.();
      return null;
    }

    teacherId = resolvedTeacherId;
    connectingTeacherId = resolvedTeacherId;
    connectingRuntime = nextRuntime;
    try {
      await nextRuntime.start();
    } catch (error) {
      clearConnectingRuntime(nextRuntime);
      if (teacherId === resolvedTeacherId) teacherId = '';
      if (!closed) failRuntimeReadiness(error);
      throw error;
    }

    if (closed || connectingRuntime !== nextRuntime || connectingTeacherId !== resolvedTeacherId) {
      try { nextRuntime.close?.(); } catch (error) { onError(error); }
      return null;
    }

    connectingRuntime = null;
    connectingTeacherId = '';
    return installRuntime(nextRuntime, { getRevision: replicaRevision, integrityInfo: nextIntegrityInfo });
  };

  const enqueueTransition = (work) => {
    const task = transitionQueue.then(() => closed ? null : work());
    transitionQueue = task.catch((error) => {
      if (closed) return;
      try { onError(error); } catch { /* observer errors are ignored */ }
      scheduleStudentRetry();
    });
    return task;
  };

  return {
    start() {
      if (closed) return Promise.reject(new Error('Board session is closed'));
      if (startPromise) return startPromise;
      reportRuntimeState('waiting');
      const task = isOwner ? startTeacher() : Promise.resolve(null);
      startPromise = task.catch((error) => {
        throw failRuntimeReadiness(error);
      });
      return startPromise;
    },
    whenRuntimeReady() {
      if (runtime) return Promise.resolve(runtime);
      if (closed) return Promise.reject(new Error('Board session is closed'));
      if (runtimeState === 'error') return Promise.reject(new Error('Browser durable runtime startup failed'));
      return new Promise((resolve, reject) => runtimeWaiters.add({ resolve, reject }));
    },
    updateParticipants(users) {
      if (closed || isOwner) return Promise.resolve(runtime);
      const ownerIds = (Array.isArray(users) ? users : [])
        .filter((user) => user?.permission === 'owner')
        .map((user) => safeId(user?.clientId))
        .filter((id) => id && id !== safeClientId)
        .sort();
      const nextTeacherId = ownerIds[0] ?? '';
      if (desiredTeacherId !== nextTeacherId) studentRetryFailures = 0;
      desiredTeacherId = nextTeacherId;
      cancelStudentRetry();
      if (!nextTeacherId) {
        if (!runtime && !connectingRuntime) reportRuntimeState('teacher-offline');
        return Promise.resolve(runtime);
      }
      return enqueueTransition(() => startStudent(nextTeacherId));
    },
    handleRealtimeSignal(payload) {
      return connectingRuntime?.handleRealtimeSignal?.(payload)
        ?? runtime?.handleRealtimeSignal?.(payload)
        ?? false;
    },
    async sendOps(ops, options = {}) {
      if (!durableBridge) throw new Error('Browser durable runtime is unavailable');
      const currentRuntime = runtime;
      const result = await durableBridge.sendOps(ops, options);
      if (runtime === currentRuntime) markIntegrity(result);
      return result;
    },
    requestLock(operation, payload = {}) {
      if (!runtime?.requestLock) return Promise.reject(new Error('Board lock runtime is unavailable'));
      return runtime.requestLock(operation, payload);
    },
    getRuntime() { return runtime; },
    getIntegrityStatus() { return integrity?.inspect() ?? null; },
    wakeIntegrity() { integrity?.wake(); },
    getRuntimeState() { return runtimeState; },
    getTeacherId() { return teacherId; },
    getRevision() {
      if (typeof runtime?.getRevision === 'function') return safeRevision(runtime.getRevision());
      return isOwner ? 0 : replicaRevision();
    },
    close() {
      if (closed) return;
      closed = true;
      desiredTeacherId = '';
      cancelStudentRetry();
      teacherId = '';
      const closeError = new Error('Board session is closed');
      rejectRuntimeWaiters(closeError);
      clearConnectingRuntime(null, { closeRuntime: true });
      clearRuntime({ nextState: 'closed' });
      if (isOwner) releaseTeacherTabAuthority(closeError);
    },
  };
}
