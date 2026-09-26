import { createBoardPeerSignalingBridge } from './boardPeerSignaling.js';
import { createStudentPeerNetwork } from './studentPeerNetwork.js';

export function createStudentBoardRuntime({
  boardId = '',
  clientId,
  teacherId,
  sendScreenShareSignal,
  getRevision,
  applyCommit,
  installSnapshot,
  rtcConfig = {},
  onAck = () => {},
  onState = () => {},
  onLiveEvent = () => {},
  onLiveState = () => {},
  onError = () => {},
  onVerificationMode = () => {},
  createSignaling = createBoardPeerSignalingBridge,
  createNetwork = createStudentPeerNetwork,
} = {}) {
  const safeBoardId = String(boardId ?? '').trim();
  const safeClientId = String(clientId ?? '').trim();
  const safeTeacherId = String(teacherId ?? '').trim();
  if (!safeClientId) throw new Error('clientId is required');
  if (!safeTeacherId) throw new Error('teacherId is required');
  if (typeof sendScreenShareSignal !== 'function') {
    throw new Error('sendScreenShareSignal is required');
  }

  let network = null;
  const signaling = createSignaling({
    clientId: safeClientId,
    sendScreenShareSignal,
    onSignal: (message) => network?.handleSignal(message),
  });

  network = createNetwork({
    onVerificationMode,
    boardId: safeBoardId,
    clientId: safeClientId,
    teacherId: safeTeacherId,
    signaling,
    rtcConfig,
    getRevision,
    applyCommit,
    installSnapshot,
    onAck,
    onState,
    onLiveEvent,
    onLiveState,
    onError,
  });

  return {
    start() {
      return network.start();
    },

    handleRealtimeSignal(payload) {
      return signaling.handle(payload);
    },

    proposeAction(action) {
      return network.proposeAction(action);
    },

    proposeActionAndWait(action) {
      return network.proposeActionAndWait(action);
    },

    requestLock(operation, payload = {}) {
      return network.requestLock(operation, payload);
    },

    sendLive(type, payload, options = {}) {
      return network?.sendLive?.(type, payload, options) ?? 'unavailable';
    },

    getLiveState() {
      return network?.getLiveState?.() ?? 'unavailable';
    },

    getLiveStats() {
      return network?.getLiveStats?.() ?? null;
    },

    getVerificationMode() { return network?.getVerificationMode?.() ?? { version: 0, epoch: '' }; },
    verifyObjects(request) {
      return network?.verifyObjects?.(request) ?? Promise.reject(new Error('Verification session is unavailable'));
    },

    whenIdle() {
      return network.whenIdle();
    },

    isReady() {
      return network.isReady();
    },

    close() {
      network.close();
    },
  };
}
