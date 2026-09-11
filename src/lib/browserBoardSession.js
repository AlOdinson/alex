import { createBrowserAuthorityDurableBridge } from './browserAuthorityDurableBridge.js';
import { registerBoardRuntime as registerDefaultBoardRuntime } from './browserBoardRuntimeRegistry.js';
import {
  applyReplicaCommit as applyDefaultReplicaCommit,
  getReplicaState as getDefaultReplicaState,
  installReplicaSnapshot as installDefaultReplicaSnapshot,
} from './browserReplicaStore.js';
import { createStudentBoardRuntime as createDefaultStudentRuntime } from './studentBoardRuntime.js';
import { createTeacherBoardRuntime as createDefaultTeacherRuntime } from './teacherBoardRuntime.js';
import { createTeacherTabAuthority as createDefaultTeacherTabAuthority } from './teacherTabAuthority.js';

const TERMINAL_STUDENT_STATES = new Set(['failed', 'closed']);

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
  onError = () => {},
  rtcConfig = {},
  createTeacherTabAuthority = createDefaultTeacherTabAuthority,
  createTeacherRuntime = createDefaultTeacherRuntime,
  createStudentRuntime = createDefaultStudentRuntime,
  registerRuntime = registerDefaultBoardRuntime,
  getReplica = getDefaultReplicaState,
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
  const runtimeWaiters = new Set();

  const replicaRevision = () => safeRevision(getReplica(safeBoardId)?.revision);

  const settleRuntimeWaiters = (nextRuntime) => {
    for (const waiter of runtimeWaiters) waiter.resolve(nextRuntime);
    runtimeWaiters.clear();
  };

  const rejectRuntimeWaiters = (error) => {
    for (const waiter of runtimeWaiters) waiter.reject(error);
    runtimeWaiters.clear();
  };

  const clearRuntime = () => {
    const previousRuntime = runtime;
    const previousUnregister = unregisterRuntime;
    runtime = null;
    unregisterRuntime = null;
    durableBridge = null;
    previousUnregister?.();
    try { previousRuntime?.close?.(); } catch (error) { onError(error); }
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
        if (!teacherTabAuthorityHeld) {
          rejectOnce(new Error('Teacher tab authority lock was not acquired'));
        }
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
    unregisterRuntime = registerRuntime(safeBoardId, nextRuntime);
    durableBridge = createBrowserAuthorityDurableBridge({
      runtime: nextRuntime,
      clientId: safeClientId,
    });
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
        onRemoteCommit: (commit) => onAuthoritativeCommit(commit),
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
    if (!resolvedTeacherId) return null;
    if (runtime && teacherId === resolvedTeacherId) return runtime;

    let nextRuntime = null;
    const handleStudentState = (state) => {
      const normalizedState = String(state ?? '');
      // A brief WebRTC "disconnected" state can heal without renegotiation. Only
      // terminal states retire the peer. Clearing only the runtime that emitted this
      // event also prevents a late callback from an old peer from deleting its newer
      // replacement for the same teacher.
      if (TERMINAL_STUDENT_STATES.has(normalizedState) && runtime === nextRuntime) {
        teacherId = '';
        clearRuntime();
      }
      onPeerState(state);
    };

    nextRuntime = createStudentRuntime({
      clientId: safeClientId,
      teacherId: resolvedTeacherId,
      sendScreenShareSignal,
      rtcConfig,
      getRevision: replicaRevision,
      applyCommit: async (commit) => {
        const applied = applyReplicaCommit(safeBoardId, commit);
        if (applied?.needsSnapshot) throw new Error('Student replica needs authoritative snapshot');
        if (applied?.applied && safeId(commit?.clientId) !== safeClientId) {
          await onAuthoritativeCommit(commit);
        }
        return applied;
      },
      installSnapshot: async (snapshot, revision) => {
        installReplicaSnapshot(safeBoardId, snapshot, revision);
        await onAuthoritativeSnapshot(snapshot, safeRevision(revision));
      },
      onState: handleStudentState,
      onError,
    });

    if (closed) {
      nextRuntime?.close?.();
      return null;
    }
    teacherId = resolvedTeacherId;
    const installed = installRuntime(nextRuntime, { getRevision: replicaRevision });
    try {
      await installed.start();
    } catch (error) {
      if (runtime === installed) {
        teacherId = '';
        clearRuntime();
      }
      throw error;
    }
    return installed;
  };

  const enqueueTransition = (work) => {
    const task = transitionQueue.then(work);
    transitionQueue = task.catch((error) => {
      try { onError(error); } catch { /* observer errors are ignored */ }
    });
    return task;
  };

  return {
    start() {
      if (closed) return Promise.reject(new Error('Board session is closed'));
      if (startPromise) return startPromise;
      startPromise = isOwner ? startTeacher() : Promise.resolve(null);
      return startPromise;
    },

    whenRuntimeReady() {
      if (runtime) return Promise.resolve(runtime);
      if (closed) return Promise.reject(new Error('Board session is closed'));
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
      if (!nextTeacherId) return Promise.resolve(runtime);
      return enqueueTransition(() => startStudent(nextTeacherId));
    },

    handleRealtimeSignal(payload) {
      return runtime?.handleRealtimeSignal?.(payload) ?? false;
    },

    async sendOps(ops, options = {}) {
      if (!durableBridge) throw new Error('Browser durable runtime is unavailable');
      return durableBridge.sendOps(ops, options);
    },

    requestLock(operation, payload = {}) {
      if (!runtime?.requestLock) return Promise.reject(new Error('Board lock runtime is unavailable'));
      return runtime.requestLock(operation, payload);
    },

    getRuntime() {
      return runtime;
    },

    getTeacherId() {
      return teacherId;
    },

    getRevision() {
      if (typeof runtime?.getRevision === 'function') return safeRevision(runtime.getRevision());
      return isOwner ? 0 : replicaRevision();
    },

    close() {
      if (closed) return;
      closed = true;
      teacherId = '';
      const closeError = new Error('Board session is closed');
      rejectRuntimeWaiters(closeError);
      clearRuntime();
      if (isOwner) releaseTeacherTabAuthority(closeError);
    },
  };
}
