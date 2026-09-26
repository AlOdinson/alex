export const BOARD_LIVE_PROTOCOL = 'alex-board-live-v1';
export const MAX_LIVE_FRAME_BYTES = 16_384;
export const LIVE_EVENT_TYPES = new Set([
  'cursor',
  'draw',
  'transform',
  'preview',
  'object-live',
  'delete-preview',
  'selection-transaction',
  'view',
]);

const encoder = new TextEncoder();

function frameBytes(value) {
  return encoder.encode(String(value ?? '')).byteLength;
}

function requiredId(value, name) {
  const id = String(value ?? '').trim();
  if (!id) throw new Error(`${name} is required`);
  if (id.length > 256) throw new Error(`${name} is too long`);
  return id;
}

function nonNegativeInteger(value, name) {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < 0) throw new Error(`Invalid ${name}`);
  return numeric;
}

function finiteNumber(value, name) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) throw new Error(`Invalid ${name}`);
  return numeric;
}

function normalizeEvent(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Live event must be an object');
  }
  const type = String(value.type ?? '');
  if (!LIVE_EVENT_TYPES.has(type)) throw new Error(`Unsupported live event type: ${type}`);
  const payload = value.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Live event payload must be an object');
  }
  return {
    protocol: BOARD_LIVE_PROTOCOL,
    type,
    boardId: requiredId(value.boardId, 'boardId'),
    clientId: requiredId(value.clientId, 'clientId'),
    seq: nonNegativeInteger(value.seq, 'seq'),
    baseRevision: nonNegativeInteger(value.baseRevision, 'revision'),
    timestamp: finiteNumber(value.timestamp, 'timestamp'),
    streamKey: requiredId(value.streamKey, 'streamKey'),
    payload,
  };
}

export function encodeLiveEvent(value) {
  const normalized = normalizeEvent(value);
  const encoded = JSON.stringify(normalized);
  if (frameBytes(encoded) > MAX_LIVE_FRAME_BYTES) throw new Error('Live frame is too large');
  return encoded;
}

export function decodeLiveEvent(value, {
  boardId,
  remoteClientId,
  highestSeqByStream = new Map(),
} = {}) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (frameBytes(text) > MAX_LIVE_FRAME_BYTES) throw new Error('Live frame is too large');
  let parsed;
  try {
    parsed = typeof value === 'string' ? JSON.parse(value) : value;
  } catch (error) {
    throw new Error(`Invalid live JSON: ${error?.message ?? error}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Live event must be an object');
  }
  if (parsed.protocol !== BOARD_LIVE_PROTOCOL) return null;
  if (String(parsed.boardId ?? '').trim() !== String(boardId ?? '').trim()) return null;
  if (String(parsed.clientId ?? '').trim() !== String(remoteClientId ?? '').trim()) return null;

  const normalized = normalizeEvent(parsed);
  const streamId = `${normalized.clientId}:${normalized.type}:${normalized.streamKey}`;
  const previous = Number(highestSeqByStream.get(streamId));
  if (Number.isFinite(previous) && normalized.seq <= previous) return null;
  highestSeqByStream.set(streamId, normalized.seq);
  return normalized;
}
