import { createBoardPeerSignalingBridge } from './boardPeerSignaling.js';
import { createStudentPeerNetwork } from './studentPeerNetwork.js';

export function createStudentBoardRuntime({
  clientId,
  teacherId,
  sendScreenShareSignal,
  getRevision,
  applyCommit,
  installSnapshot,
  rtcConfig = {},
  onAck = () => {},
  onState = () => {},
  onError = () => {},
  createSignaling = createBoardPeerSignalingBridge,
  createNetwork = createStudentPeerNetwork,
} = {}) {
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
    teacherId: safeTeacherId,
    signaling,
    rtcConfig,
    getRevision,
    applyCommit,
    installSnapshot,
    onAck,
    onState,
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
