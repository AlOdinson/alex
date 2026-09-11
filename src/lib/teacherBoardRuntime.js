import { openBrowserBoardAuthority } from './browserBoardAuthority.js';
import { createTeacherPeerHub } from './teacherPeerHub.js';
import { createBoardPeerSignalingBridge } from './boardPeerSignaling.js';
import { createTeacherPeerNetwork } from './teacherPeerNetwork.js';

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
} = {}) {
  const safeBoardId = String(boardId ?? '').trim();
  const safeClientId = String(clientId ?? '').trim();
  if (!safeBoardId) throw new Error('boardId is required');
  if (!safeClientId) throw new Error('clientId is required');
  if (typeof sendScreenShareSignal !== 'function') {
    throw new Error('sendScreenShareSignal is required');
  }

  const authority = await openAuthority({ boardId: safeBoardId });
  const hub = createHub({
    authority,
    getSnapshot: async () => ({
      snapshot: authority.getSnapshot(),
      revision: authority.getRevision(),
    }),
    getCommitsAfter: (revision, limit) => authority.getCommitsAfter(revision, limit),
    onCommit: onRemoteCommit,
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
      const commit = await authority.commitAction({
        ...(action && typeof action === 'object' ? action : {}),
        clientId: String(action?.clientId ?? safeClientId),
      });
      if (!commit?.duplicate) await hub.broadcastCommit(commit);
      return commit;
    },

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
    },
  };
}
