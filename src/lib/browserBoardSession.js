import { createBrowserAuthorityDurableBridge } from './browserAuthorityDurableBridge.js';
import { registerBoardRuntime as registerDefaultBoardRuntime } from './browserBoardRuntimeRegistry.js';
import {
  applyReplicaCommit as applyDefaultReplicaCommit,
  getReplicaState as getDefaultReplicaState,
  installReplicaSnapshot as installDefaultReplicaSnapshot,
} from './browserReplicaStore.js';
import { createStudentBoardRuntime as createDefaultStudentRuntime } from './studentBoardRuntime.js';
import { createTeacherBoardRuntime as createDefaultTeacherRuntime } from './teacherBoardRuntime.js';

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

  const replicaRevision = () => safeRevision(getReplica(safeBoardId)?.revision);

  const clearRuntime = () => {
    const previousRuntime = runtime;
    const previousUnregister = unregisterRuntime;
    runtime = null;
    unregisterRuntime = null;
    durableBridge = null;
    previousUnregister?.();
    try { previousRuntime?.close?.(); } catch (error) { onError(error); }
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
    return nextRuntime;
  };

  const startTeacher = async () => {
    const nextRuntime = await createTeacherRuntime({
      boardId: safeBoardId,
      clientId: safeClientId,
      sendScreenShareSignal,
      rtcConfig,
      onRemoteCommit: (commit) => onAuthoritativeCommit(commit),
      onPeerState,
      onError,
    });
    if (closed) {
      nextRuntime?.close?.();
      return null;
    }
    return installRuntime(nextRuntime);
  };

  const startStudent = async (nextTeacherId) => {
    const resolvedTeacherId = safeId(nextTeacherId);
    if (!resolvedTeacherId) return null;
    if (runtime && teacherId === resolvedTeacherId) return runtime;

    const nextRuntime = createStudentRuntime({
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
      onState: onPeerState,
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
      clearRuntime();
    },
  };
}
