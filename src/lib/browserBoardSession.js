import { createStudentOfflineRecorder } from './studentOfflineCache.js';
import { createBoundedBoardVerifier } from './boundedBoardVerifier.js';
import { createBrowserAuthorityDurableBridge } from './browserAuthorityDurableBridge.js';
import { registerBoardRuntime as registerDefaultBoardRuntime } from './browserBoardRuntimeRegistry.js';
import {
  applyReplicaCommit as applyDefaultReplicaCommit,
  getReplicaVerificationView,
  applyReplicaVerificationRecords,
  getReplicaRevision as getDefaultReplicaRevision,
  getReplicaState as getDefaultReplicaState,
  installReplicaSnapshot as installDefaultReplicaSnapshot,
} from './browserReplicaStore.js';
import { createStudentBoardRuntime as createDefaultStudentRuntime } from './studentBoardRuntime.js';
import { createTeacherBoardRuntime as createDefaultTeacherRuntime } from './teacherBoardRuntime.js';
import { createTeacherTabAuthority as createDefaultTeacherTabAuthority } from './teacherTabAuthority.js';
import {
  COLLABORATION_LIVE_CAPABILITIES,
  normalizeCollaborationCapabilities,
  resolveCollaborationMode,
} from './collaborationTransportFlags.js';

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
  webrtcLiveV1 = false,
  localCapabilities = null,
  offlineCacheKey = '',
  sendScreenShareSignal,
  onAuthoritativeCommit = async () => {},
  onAuthoritativeSnapshot = async () => {},
  onVerificationRecords = async () => true,
  readVerificationCanvasIds = () => ({ ids: [], done: true }),
  canVerifyCanvas = () => true,
  createVerifier = createBoundedBoardVerifier,
  getVerificationReplicaView = getReplicaVerificationView,
  onPeerState = () => {},
  onLiveEvent = () => {},
  onLiveState = () => {},
  onBoardControl = () => {},
  onRuntimeState = () => {},
  onError = () => {},
  rtcConfig = {},
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
  const normalizedLocalCapabilities = normalizeCollaborationCapabilities(
    localCapabilities ?? (webrtcLiveV1 ? COLLABORATION_LIVE_CAPABILITIES : null),
  );
  if (!safeBoardId) throw new Error('boardId is required');
  if (!safeClientId) throw new Error('clientId is required');
  if (typeof sendScreenShareSignal !== 'function') throw new Error('sendScreenShareSignal is required');

  const offlineRecorder = !isOwner && offlineCacheKey ? createStudentOfflineRecorder({
    boardId: safeBoardId, roomKey: offlineCacheKey,
    onError: (error) => console.warn('Student viewing cache unavailable', error),
  }) : null;
  let runtime = null;
  let verifier = null;
  let verifierEpoch = '';
  // Integrity failures are diagnostic only, never a reason to reject user edits.
  const verificationError = (error) => {
    try { console.warn('Additional board verification postponed', error); } catch { /* observer only */ }
  };
  const notifyVerification = (commit) => {
    try { verifier?.notify?.(commit); } catch (error) { verificationError(error); }
  };
  const configureVerification = (nextRuntime) => {
    const mode = nextRuntime?.getVerificationMode?.();
    if (mode?.version !== 1 || !mode.epoch || nextRuntime !== runtime || closed) return;
    if (verifier && verifierEpoch === mode.epoch) return;
    verifier?.close?.();
    verifier = null; verifierEpoch = mode.epoch;
    try {
      const view = isOwner ? nextRuntime.getVerificationView?.() : getVerificationReplicaView(safeBoardId);
      if (!view) return;
      verifier = createVerifier({
        enabled: true, epoch: mode.epoch, view,
        isCurrentRuntime: () => !closed && runtime === nextRuntime
          && nextRuntime.getVerificationMode?.().epoch === mode.epoch,
        request: isOwner ? null : (request) => nextRuntime.verifyObjects(request),
        runWork: isOwner && typeof nextRuntime.runVerification === 'function'
          ? (work) => nextRuntime.runVerification(work) : (work) => work(),
        applyRecords: (records, revision, background) => applyReplicaVerificationRecords(safeBoardId, records, revision, background),
        checkCanvas: onVerificationRecords, readCanvasIds: readVerificationCanvasIds,
        canCheck: canVerifyCanvas, onError: verificationError,
      });
    } catch (error) { verificationError(error); }
  };
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
  let activeTeacherMode = 'legacy';
  let desiredTeacherMode = 'legacy';
  const participantCapabilities = new Map();
  let studentRetryTimer = null;
  let studentRetryFailures = 0;

  const collaborationModeFor = (peerId) => resolveCollaborationMode({
    enabled: Boolean(webrtcLiveV1),
    localCapabilities: normalizedLocalCapabilities,
    remoteCapabilities: participantCapabilities.get(safeId(peerId)) ?? null,
  });

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
    try { verifier?.close?.(); } catch (error) { verificationError(error); }
    verifier = null; verifierEpoch = '';
    const previousRuntime = runtime;
    const previousUnregister = unregisterRuntime;
    runtime = null;
    unregisterRuntime = null;
    if (!isOwner) activeTeacherMode = 'legacy';
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

  const installRuntime = (nextRuntime, { getRevision = null } = {}) => {
    if (!nextRuntime || typeof nextRuntime !== 'object') throw new Error('Board runtime is required');
    clearRuntime();
    if (typeof nextRuntime.getRevision !== 'function' && typeof getRevision === 'function') {
      nextRuntime.getRevision = getRevision;
    }
    runtime = nextRuntime;
    configureVerification(nextRuntime);
    cancelStudentRetry();
    studentRetryFailures = 0;
    unregisterRuntime = registerRuntime(safeBoardId, nextRuntime);
    durableBridge = createBrowserAuthorityDurableBridge({ runtime: nextRuntime, clientId: safeClientId });
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
          await onAuthoritativeCommit(commit);
          if (!closed && runtime === nextRuntime) notifyVerification(commit);
        },
        onPeerState,
        onLiveEvent: (peerId, type, payload, envelope) => {
          onLiveEvent(type, payload, envelope, { peerId });
        },
        onLiveState: (peerId, state) => {
          onLiveState(state, { peerId });
        },
        onBoardControl: (peerId, event, payload) => {
          onBoardControl(event, payload, { peerId });
        },
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
    const resolvedTeacherMode = collaborationModeFor(resolvedTeacherId);
    if (resolvedTeacherMode !== desiredTeacherMode) return null;
    if (runtime && teacherId === resolvedTeacherId) return runtime;
    if (runtime && teacherId !== resolvedTeacherId) clearRuntime();
    reportRuntimeState('waiting');

    let nextRuntime = null;
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
      boardId: safeBoardId,
      clientId: safeClientId,
      webrtcLiveEnabled: resolvedTeacherMode === 'webrtc-live-v1',
      teacherId: resolvedTeacherId,
      sendScreenShareSignal,
      rtcConfig,
      getRevision: replicaRevision,
      applyCommit: async (commit) => {
        const applied = applyReplicaCommit(safeBoardId, commit);
        if (applied?.needsSnapshot) throw new Error('Student replica needs authoritative snapshot');
        if (applied?.applied) {
          offlineRecorder?.commit(commit);
          await onAuthoritativeCommit(commit);
          if (!closed && runtime === nextRuntime) notifyVerification(commit);
        }
        return applied;
      },
      installSnapshot: async (snapshot, revision) => {
        // The replica is installed before the Canvas callback so repository reads
        // during painting see the new baseline. Keep startup requesting a full
        // snapshot if painting fails; a cached head alone cannot repair the Canvas.
        replicaNeedsSnapshot = true;
        installReplicaSnapshot(safeBoardId, snapshot, revision);
        offlineRecorder?.snapshot(snapshot, safeRevision(revision));
        await onAuthoritativeSnapshot(snapshot, safeRevision(revision));
        replicaNeedsSnapshot = false;
        try { verifier?.resume?.(); } catch (error) { verificationError(error); }
      },
      onVerificationMode: () => {
        if (runtime === nextRuntime) configureVerification(nextRuntime);
      },
      onState: handleStudentState,
      onLiveEvent: (type, payload, envelope) => {
        onLiveEvent(type, payload, envelope, { peerId: resolvedTeacherId });
      },
      onLiveState: (state) => {
        onLiveState(state, { peerId: resolvedTeacherId });
      },
      onBoardControl: (event, payload) => {
        onBoardControl(event, payload, { peerId: resolvedTeacherId });
      },
      onError,
    });

    if (closed) {
      nextRuntime?.close?.();
      return null;
    }

    teacherId = resolvedTeacherId;
    activeTeacherMode = resolvedTeacherMode;
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
    return installRuntime(nextRuntime, { getRevision: replicaRevision });
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
      if (closed) return Promise.resolve(runtime);
      const list = Array.isArray(users) ? users : [];
      participantCapabilities.clear();
      for (const user of list) {
        const id = safeId(user?.clientId);
        if (!id) continue;
        participantCapabilities.set(id, normalizeCollaborationCapabilities(user?.capabilities));
      }
      if (isOwner) return Promise.resolve(runtime);

      const ownerIds = list
        .filter((user) => user?.permission === 'owner')
        .map((user) => safeId(user?.clientId))
        .filter((id) => id && id !== safeClientId)
        .sort();
      const nextTeacherId = ownerIds[0] ?? '';
      const nextTeacherMode = nextTeacherId ? collaborationModeFor(nextTeacherId) : 'legacy';
      const sameTeacherModeChanged = Boolean(
        nextTeacherId
        && nextTeacherId === desiredTeacherId
        && nextTeacherMode !== desiredTeacherMode
      );
      if (desiredTeacherId !== nextTeacherId || sameTeacherModeChanged) studentRetryFailures = 0;
      if (sameTeacherModeChanged) {
        clearConnectingRuntime();
        if (runtime && teacherId === nextTeacherId && activeTeacherMode !== nextTeacherMode) {
          teacherId = '';
          clearRuntime();
        }
      }
      desiredTeacherId = nextTeacherId;
      desiredTeacherMode = nextTeacherMode;
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
      const activeRuntime = runtime;
      const result = await durableBridge.sendOps(ops, options);
      if (!closed && runtime === activeRuntime && result) notifyVerification(result);
      return result;
    },
    requestLock(operation, payload = {}) {
      if (!runtime?.requestLock) return Promise.reject(new Error('Board lock runtime is unavailable'));
      return runtime.requestLock(operation, payload);
    },
    resumeVerification() {
      try { verifier?.resume?.(); } catch (error) { verificationError(error); }
    },
    getVerificationStats() { return verifier?.stats?.() ?? { enabled: false }; },
    getRuntime() { return runtime; },
    getCollaborationMode(peerId = teacherId) { return collaborationModeFor(peerId); },
    getLiveRoutingState() {
      const remoteIds = [...participantCapabilities.keys()].filter((id) => id && id !== safeClientId);
      const modes = remoteIds.map((id) => collaborationModeFor(id));
      return {
        enabled: Boolean(webrtcLiveV1),
        hasWebRtcLivePeers: modes.includes('webrtc-live-v1'),
        hasLegacyPeers: modes.includes('legacy'),
      };
    },
    sendLive(type, payload, options = {}) {
      return runtime?.sendLive?.(type, payload, options) ?? 'unavailable';
    },
    async sendBoardControl(event, payload = {}) {
      if (!runtime) return 'unavailable';
      if (!isOwner) {
        if (collaborationModeFor(teacherId) !== 'webrtc-live-v1') return 'unavailable';
        return runtime.sendBoardControl?.(event, payload) ?? 'unavailable';
      }
      const targetIds = [...participantCapabilities.keys()]
        .filter((id) => id && id !== safeClientId && collaborationModeFor(id) === 'webrtc-live-v1');
      if (typeof runtime.sendBoardControlTo === 'function') {
        const results = [];
        for (const peerId of targetIds) {
          // eslint-disable-next-line no-await-in-loop
          results.push(await runtime.sendBoardControlTo(peerId, event, payload));
        }
        return results;
      }
      return runtime.sendBoardControl?.(event, payload) ?? 'unavailable';
    },
    getRuntimeState() { return runtimeState; },
    getTeacherId() { return teacherId; },
    getRevision() {
      if (typeof runtime?.getRevision === 'function') return safeRevision(runtime.getRevision());
      return isOwner ? 0 : replicaRevision();
    },
    close() {
      if (closed) return;
      offlineRecorder?.close();
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
