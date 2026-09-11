export const BOARD_PEER_SIGNAL_PROTOCOL = 'alex-board-peer-signal-v1';
export const BOARD_PEER_SIGNAL_TYPE = 'board-peer-signal';

const SIGNAL_TYPES = new Set(['offer', 'answer', 'ice']);

function safeId(value) {
  return String(value ?? '').trim();
}

function peerSessionId(left, right) {
  return [safeId(left), safeId(right)].sort().join(':');
}

export function normalizeBoardPeerSignal(payload, localClientId = '') {
  if (!payload || typeof payload !== 'object') return null;
  if (payload.protocol !== BOARD_PEER_SIGNAL_PROTOCOL) return null;
  if (payload.type !== BOARD_PEER_SIGNAL_TYPE) return null;

  const sourceId = safeId(payload.sourceId ?? payload.clientId);
  const targetId = safeId(payload.targetId);
  const localId = safeId(localClientId);
  const signal = payload.signal;

  if (!sourceId || !targetId || !signal || typeof signal !== 'object') return null;
  if (!SIGNAL_TYPES.has(String(signal.type ?? ''))) return null;
  if (localId && targetId !== localId) return null;
  if (localId && sourceId === localId) return null;

  return {
    sourceId,
    targetId,
    sessionId: safeId(payload.sessionId) || peerSessionId(sourceId, targetId),
    signal,
    timestamp: Number(payload.timestamp ?? Date.now()),
  };
}

export function createBoardPeerSignalingBridge({
  clientId,
  sendScreenShareSignal,
  onSignal = () => {},
} = {}) {
  const localId = safeId(clientId);
  if (!localId) throw new Error('clientId is required');
  if (typeof sendScreenShareSignal !== 'function') {
    throw new Error('sendScreenShareSignal is required');
  }

  return {
    async send(peerId, signal) {
      const targetId = safeId(peerId);
      if (!targetId) throw new Error('peerId is required');
      if (!signal || typeof signal !== 'object' || !SIGNAL_TYPES.has(String(signal.type ?? ''))) {
        throw new Error('Unsupported WebRTC peer signal');
      }

      return sendScreenShareSignal({
        protocol: BOARD_PEER_SIGNAL_PROTOCOL,
        type: BOARD_PEER_SIGNAL_TYPE,
        sessionId: peerSessionId(localId, targetId),
        sourceId: localId,
        targetId,
        signal,
        timestamp: Date.now(),
      });
    },

    async handle(payload) {
      const normalized = normalizeBoardPeerSignal(payload, localId);
      if (!normalized) return false;
      await onSignal(normalized);
      return true;
    },
  };
}
