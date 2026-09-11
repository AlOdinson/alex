export const BOARD_PEER_PROTOCOL_VERSION = 1;

const MESSAGE_TYPES = new Set([
  'hello',
  'head-request',
  'head',
  'snapshot-request',
  'sync-request',
  'action-proposal',
  'commit',
  'ack',
  'lock-request',
  'lock-result',
  'transfer-start',
  'transfer-chunk',
  'transfer-end',
]);

function assertMessageType(type) {
  if (!MESSAGE_TYPES.has(type)) throw new Error(`Unsupported peer message type: ${type}`);
}

function normalizeEnvelope(value) {
  if (!value || typeof value !== 'object') throw new Error('Peer message must be an object');
  if (Number(value.v) !== BOARD_PEER_PROTOCOL_VERSION) {
    throw new Error(`Unsupported peer protocol version: ${value.v}`);
  }
  assertMessageType(value.type);
  return {
    v: BOARD_PEER_PROTOCOL_VERSION,
    type: value.type,
    payload: value.payload && typeof value.payload === 'object' ? value.payload : {},
  };
}

export function createPeerMessage(type, payload = {}) {
  assertMessageType(type);
  return JSON.stringify({
    v: BOARD_PEER_PROTOCOL_VERSION,
    type,
    payload: payload && typeof payload === 'object' ? payload : {},
  });
}

export function decodePeerMessage(value) {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  return normalizeEnvelope(parsed);
}

export function splitPeerTextTransfer(kind, text, { chunkChars = 16_384, transferId } = {}) {
  const safeTransferId = String(transferId ?? '').trim();
  if (!safeTransferId) throw new Error('transferId is required');
  const safeKind = String(kind ?? '').trim();
  if (!safeKind) throw new Error('transfer kind is required');
  const source = String(text ?? '');
  const safeChunkChars = Math.max(1, Math.floor(Number(chunkChars) || 16_384));
  const chunks = [];
  for (let offset = 0; offset < source.length; offset += safeChunkChars) {
    chunks.push(source.slice(offset, offset + safeChunkChars));
  }
  if (!chunks.length) chunks.push('');

  return [
    {
      v: BOARD_PEER_PROTOCOL_VERSION,
      type: 'transfer-start',
      payload: {
        transferId: safeTransferId,
        kind: safeKind,
        totalChunks: chunks.length,
        totalChars: source.length,
      },
    },
    ...chunks.map((chunk, index) => ({
      v: BOARD_PEER_PROTOCOL_VERSION,
      type: 'transfer-chunk',
      payload: { transferId: safeTransferId, index, chunk },
    })),
    {
      v: BOARD_PEER_PROTOCOL_VERSION,
      type: 'transfer-end',
      payload: { transferId: safeTransferId },
    },
  ];
}

export function createPeerTextAssembler() {
  const transfers = new Map();

  const maybeComplete = (transferId) => {
    const state = transfers.get(transferId);
    if (!state?.ended || state.chunks.size !== state.totalChunks) return null;
    const ordered = [];
    for (let index = 0; index < state.totalChunks; index += 1) {
      if (!state.chunks.has(index)) return null;
      ordered.push(state.chunks.get(index));
    }
    const text = ordered.join('');
    if (text.length !== state.totalChars) throw new Error('Peer transfer length mismatch');
    transfers.delete(transferId);
    return { transferId, kind: state.kind, text };
  };

  return {
    accept(input) {
      const frame = normalizeEnvelope(typeof input === 'string' ? JSON.parse(input) : input);
      const payload = frame.payload ?? {};
      const transferId = String(payload.transferId ?? '').trim();
      if (!transferId) return null;

      if (frame.type === 'transfer-start') {
        const totalChunks = Number(payload.totalChunks);
        const totalChars = Number(payload.totalChars);
        if (!Number.isInteger(totalChunks) || totalChunks < 1) throw new Error('Invalid peer transfer chunk count');
        if (!Number.isInteger(totalChars) || totalChars < 0) throw new Error('Invalid peer transfer length');
        transfers.set(transferId, {
          kind: String(payload.kind ?? ''),
          totalChunks,
          totalChars,
          chunks: new Map(),
          ended: false,
        });
        return null;
      }

      const state = transfers.get(transferId);
      if (!state) return null;

      if (frame.type === 'transfer-chunk') {
        const index = Number(payload.index);
        if (!Number.isInteger(index) || index < 0 || index >= state.totalChunks) {
          throw new Error('Invalid peer transfer chunk index');
        }
        state.chunks.set(index, String(payload.chunk ?? ''));
        return maybeComplete(transferId);
      }

      if (frame.type === 'transfer-end') {
        state.ended = true;
        return maybeComplete(transferId);
      }

      return null;
    },
    cancel(transferId) {
      transfers.delete(String(transferId ?? ''));
    },
    clear() {
      transfers.clear();
    },
  };
}
