import { openBrowserBoardAuthority } from './browserBoardAuthority.js';
import { createTeacherPeerHub } from './teacherPeerHub.js';
import { createBoardPeerSignalingBridge } from './boardPeerSignaling.js';
import { createTeacherPeerNetwork } from './teacherPeerNetwork.js';
import { createTeacherObjectLockAuthority } from './teacherObjectLocks.js';
import { operationObjectIds } from './operationProtocol.js';

export async function createTeacherBoardRuntime({
  boardId,
  clientId,
  sendScreenShareSignal,
  rtcConfig = {},
  onRemoteCommit = () => {},
  onPeerState = () => {},
  onError = () => {},
  openAuthority = openBrowserBoardAuthority,
  createHub = createTeacherPeerHub,
  createSignaling = createBoardPeerSignalingBridge,
  createNetwork = createTeacherPeerNetwork,
  createLockAuthority = createTeacherObjectLockAuthority,
} = {}) {
  const safeBoardId = String(boardId ?? '').trim();
  const safeClientId = String(clientId ?? '').trim();
  if (!safeBoardId) throw new Error('boardId is required');
  if (!safeClientId) throw new Error('clientId is required');
  if (typeof sendScreenShareSignal !== 'function') {
    throw new Error('sendScreenShareSignal is required');
  }

  const authority = await openAuthority({ boardId: safeBoardId });
  const lockAuthority = createLockAuthority();
  const hub = createHub({
    authority,
    getSnapshot: async () => ({
      snapshot: authority.getSnapshot(),
      revision: authority.getRevision(),
    }),
    getCommitsAfter: (revision, limit) => authority.getCommitsAfter(revision, limit),
    onCommit: onRemoteCommit,
    lockAuthority,
  });

  let network = null;
  const signaling = createSignaling({
    clientId: safeClientId,
    sendScreenShareSignal,
    onSignal: (message) => network?.handleSignal(message),
  });

  network = createNetwork({
    signaling,
    peerHub: hub,
    rtcConfig,
    onPeerState,
    onError,
  });

  const requestLock = (operation, payload = {}) => {
    const safeOperation = String(operation ?? '').trim();
    const source = payload && typeof payload === 'object' ? payload : {};
    if (safeOperation === 'acquire' && typeof lockAuthority?.acquire === 'function') {
      return Promise.resolve(lockAuthority.acquire({
        clientId: safeClientId,
        lockToken: String(source.lockToken ?? ''),
        objectIds: Array.isArray(source.objectIds) ? source.objectIds.map(String) : [],
        ttlMs: Number(source.ttlMs ?? 0),
      }));
    }
    if (safeOperation === 'refresh' && typeof lockAuthority?.refresh === 'function') {
      return Promise.resolve(lockAuthority.refresh({
        clientId: safeClientId,
        lockToken: String(source.lockToken ?? ''),
        ttlMs: Number(source.ttlMs ?? 0),
      }));
    }
    if (safeOperation === 'release' && typeof lockAuthority?.release === 'function') {
      return Promise.resolve(lockAuthority.release({
        clientId: safeClientId,
        lockToken: source.lockToken == null ? null : String(source.lockToken),
      }));
    }
    return Promise.reject(new Error('Unsupported lock operation'));
  };

  return {
    boardId: safeBoardId,

    getRevision() {
      return authority.getRevision();
    },

    getSnapshot() {
      return authority.getSnapshot();
    },

    getCommitsAfter(revision, limit) {
      return authority.getCommitsAfter(revision, limit);
    },

    async commitTeacherAction(action) {
      const proposal = {
        ...(action && typeof action === 'object' ? action : {}),
        clientId: safeClientId,
      };
      const affectedIds = [...operationObjectIds(proposal.ops ?? [])];
      if (affectedIds.length && typeof lockAuthority?.getConflicts === 'function') {
        const conflicts = await lockAuthority.getConflicts({
          clientId: safeClientId,
          objectIds: affectedIds,
        });
        if (Array.isArray(conflicts) && conflicts.length) {
          return {
            actionId: String(proposal.actionId ?? ''),
            revision: Number(authority.getRevision() ?? 0),
            changed: false,
            duplicate: false,
            needsSync: false,
            appliedOps: [],
            appliedBackground: null,
            rejectedObjectIds: [...new Set(conflicts
              .map((conflict) => String(conflict?.objectId ?? ''))
              .filter(Boolean))],
            skippedConflicts: [],
          };
        }
      }

      const commit = await authority.commitAction(proposal);
      if (!commit?.duplicate) await hub.broadcastCommit(commit);
      return commit;
    },

    requestLock,

    compactSnapshot() {
      return authority.compactSnapshot();
    },

    handleRealtimeSignal(payload) {
      return signaling.handle(payload);
    },

    getPeerCount() {
      return network?.getPeerCount?.() ?? 0;
    },

    close() {
      network?.close?.();
      try { lockAuthority?.release?.({ clientId: safeClientId }); } catch { /* best effort */ }
    },
  };
}
