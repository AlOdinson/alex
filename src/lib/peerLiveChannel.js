import { decodeLiveEvent, encodeLiveEvent } from './liveEventProtocol.js';

function addListener(target, type, listener) {
  if (typeof target?.addEventListener === 'function') {
    target.addEventListener(type, listener);
    return () => target.removeEventListener?.(type, listener);
  }
  const property = `on${type}`;
  const previous = target?.[property] ?? null;
  if (target) target[property] = listener;
  return () => {
    if (target?.[property] === listener) target[property] = previous;
  };
}

function safeRevision(value) {
  const revision = Number(value ?? 0);
  return Number.isInteger(revision) && revision >= 0 ? revision : 0;
}

export function createPeerLiveChannel({
  channel,
  boardId,
  localClientId,
  remoteClientId,
  getRevision = () => 0,
  onEvent = () => {},
  onState = () => {},
  onError = () => {},
  highWaterMark = 256_000,
  lowWaterMark = 64_000,
  maxPendingStreams = 128,
} = {}) {
  if (!channel?.send) throw new Error('RTCDataChannel is required');
  const highWater = Math.max(1, Number(highWaterMark) || 256_000);
  const lowWater = Math.max(0, Math.min(highWater, Number(lowWaterMark) || 64_000));
  const maxPending = Math.max(1, Math.floor(Number(maxPendingStreams) || 128));
  const highestSeqByStream = new Map();
  const pending = new Map();
  let seq = 0;
  let closed = false;
  let sent = 0;
  let received = 0;
  let coalesced = 0;
  let dropped = 0;

  channel.bufferedAmountLowThreshold = lowWater;

  const stats = () => ({ sent, received, coalesced, dropped, pending: pending.size });

  const reportError = (error) => {
    try { onError(error instanceof Error ? error : new Error(String(error))); } catch { /* observer */ }
  };

  const sendEncoded = (encoded) => {
    if (closed || channel.readyState !== 'open') return false;
    channel.send(encoded);
    sent += 1;
    return true;
  };

  const flush = () => {
    if (closed || channel.readyState !== 'open') return;
    for (const [key, encoded] of [...pending.entries()]) {
      if (Number(channel.bufferedAmount ?? 0) > highWater) break;
      pending.delete(key);
      try {
        if (!sendEncoded(encoded)) {
          pending.set(key, encoded);
          break;
        }
      } catch (error) {
        pending.set(key, encoded);
        reportError(error);
        break;
      }
    }
  };

  const queueLatest = (streamId, encoded) => {
    if (pending.has(streamId)) {
      pending.set(streamId, encoded);
      coalesced += 1;
      return;
    }
    if (pending.size >= maxPending) {
      const oldest = pending.keys().next().value;
      if (oldest !== undefined) {
        pending.delete(oldest);
        dropped += 1;
      }
    }
    pending.set(streamId, encoded);
  };

  const handleMessage = (event) => {
    if (closed || typeof event?.data !== 'string') return;
    try {
      const envelope = decodeLiveEvent(event.data, {
        boardId,
        remoteClientId,
        highestSeqByStream,
      });
      if (!envelope) return;
      received += 1;
      onEvent(envelope.type, envelope.payload, envelope);
    } catch (error) {
      reportError(error);
    }
  };

  const handleClose = () => {
    if (closed) return;
    closed = true;
    pending.clear();
    try { onState('closed'); } catch { /* observer */ }
  };

  const handleError = (event) => {
    if (closed) return;
    reportError(event?.error ?? new Error('Live data channel error'));
    try { onState('error'); } catch { /* observer */ }
  };

  const removeMessage = addListener(channel, 'message', handleMessage);
  const removeLow = addListener(channel, 'bufferedamountlow', flush);
  const removeClose = addListener(channel, 'close', handleClose);
  const removeError = addListener(channel, 'error', handleError);

  if (channel.readyState === 'open') {
    try { onState('open'); } catch { /* observer */ }
  }

  return {
    send(type, payload = {}, { streamKey = type } = {}) {
      if (closed || channel.readyState === 'closed' || channel.readyState === 'closing') return 'closed';
      seq += 1;
      const encoded = encodeLiveEvent({
        type,
        boardId,
        clientId: localClientId,
        seq,
        baseRevision: safeRevision(getRevision()),
        timestamp: Date.now(),
        streamKey,
        payload,
      });
      const streamId = `${type}:${String(streamKey)}`;
      if (channel.readyState === 'open' && Number(channel.bufferedAmount ?? 0) <= highWater && pending.size === 0) {
        try {
          sendEncoded(encoded);
          return 'sent';
        } catch (error) {
          reportError(error);
        }
      }
      queueLatest(streamId, encoded);
      return 'coalesced';
    },

    stats,

    close() {
      if (closed) return;
      closed = true;
      pending.clear();
      removeMessage();
      removeLow();
      removeClose();
      removeError();
      try { channel.close?.(); } catch (error) { reportError(error); }
      try { onState('closed'); } catch { /* observer */ }
    },
  };
}
