import {
  createPeerMessage,
  decodePeerMessage,
  splitPeerTextTransfer,
  createPeerTextAssembler,
  MAX_PEER_FRAME_BYTES,
  peerFrameByteLength,
} from './peerProtocol.js';

const TRANSFER_TYPES = new Set(['transfer-start', 'transfer-chunk', 'transfer-end']);
const INTERNAL_MESSAGE_TRANSFER_KIND = 'peer-message';

function defaultTransferId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `message-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function addListener(target, type, listener, options) {
  if (typeof target?.addEventListener === 'function') {
    target.addEventListener(type, listener, options);
    return () => target.removeEventListener?.(type, listener);
  }
  const property = `on${type}`;
  const previous = target?.[property] ?? null;
  if (target) target[property] = listener;
  return () => {
    if (target?.[property] === listener) target[property] = previous;
  };
}

export function createPeerDataChannelTransport({
  channel,
  onMessage = () => {},
  onTransfer = () => {},
  onClose = () => {},
  onError = () => {},
  onProgress = () => {},
  highWaterMark = 512_000,
  lowWaterMark = 128_000,
  maxInlineMessageChars = 48_000,
  messageChunkChars = 16_384,
  createTransferId = defaultTransferId,
  writeTimeoutMs = 30_000,
} = {}) {
  if (!channel?.send) throw new Error('RTCDataChannel is required');

  const highWater = Math.max(1, Number(highWaterMark) || 512_000);
  const lowWater = Math.max(0, Math.min(highWater, Number(lowWaterMark) || 128_000));
  const inlineLimit = Math.max(1, Math.floor(Number(maxInlineMessageChars) || 48_000));
  const chunkChars = Math.max(1, Math.floor(Number(messageChunkChars) || 16_384));
  const assembler = createPeerTextAssembler();
  let closed = false;
  let closeReported = false;
  let sendQueue = Promise.resolve();
  const pendingWaits = new Set();

  const cancelWaits = () => {
    for (const cancel of [...pendingWaits]) cancel();
  };

  const waitFor = (event, isSatisfied, message) => {
    if (closed || channel.readyState === 'closed' || channel.readyState === 'closing') {
      return Promise.reject(new Error('Peer data channel is closed'));
    }
    if (isSatisfied()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let removeEvent = () => {};
      let removeClose = () => {};
      let timeout = null;
      const cleanup = () => {
        removeEvent();
        removeClose();
        clearTimeout(timeout);
        pendingWaits.delete(cancel);
      };
      const finish = () => { cleanup(); resolve(); };
      const cancel = () => { cleanup(); reject(new Error(message)); };
      const delay = Number(writeTimeoutMs);
      timeout = setTimeout(() => {
        cleanup();
        reject(new Error('Peer data channel write timed out'));
      }, Number.isFinite(delay) && delay > 0 ? delay : 30_000);
      pendingWaits.add(cancel);
      removeEvent = addListener(channel, event, finish, { once: true });
      removeClose = addListener(channel, 'close', cancel, { once: true });
      // Do not lose a state transition while installing the listeners.
      if (closed || channel.readyState === 'closed' || channel.readyState === 'closing') cancel();
      else if (isSatisfied()) finish();
    });
  };

  const waitForWritable = async () => {
    await waitFor('open', () => channel.readyState === 'open', 'Peer data channel closed before opening');
    if (Number(channel.bufferedAmount ?? 0) <= highWater) return;
    channel.bufferedAmountLowThreshold = lowWater;
    await waitFor(
      'bufferedamountlow',
      () => Number(channel.bufferedAmount ?? 0) <= lowWater,
      'Peer data channel closed while waiting for buffer space',
    );
  };

  const enqueueEncodedFrames = (frames) => {
    const task = sendQueue.then(async () => {
      for (const frame of frames) {
        if (closed) throw new Error('Peer data channel transport is closed');
        // eslint-disable-next-line no-await-in-loop
        await waitForWritable();
        if (closed) throw new Error('Peer data channel transport is closed');
        if (peerFrameByteLength(frame) > MAX_PEER_FRAME_BYTES) throw new Error('Peer frame exceeds byte limit');
        channel.send(frame);
      }
    });
    sendQueue = task.catch(() => undefined);
    return task;
  };

  const reportProgress = () => {
    try { onProgress(); } catch { /* watchdog/observer errors must not drop data */ }
  };

  const handleIncoming = (event) => {
    if (closed || typeof event?.data !== 'string') return;
    try {
      const message = decodePeerMessage(event.data);
      if (TRANSFER_TYPES.has(message.type)) {
        const completed = assembler.accept(message);
        reportProgress();
        if (!completed) return;
        if (completed.kind === INTERNAL_MESSAGE_TRANSFER_KIND) {
          onMessage(decodePeerMessage(completed.text));
        } else {
          onTransfer(completed);
        }
        return;
      }
      reportProgress();
      onMessage(message);
    } catch (error) {
      onError(error);
    }
  };

  const handleChannelClose = () => {
    if (closed || closeReported) return;
    closeReported = true;
    cancelWaits();
    assembler.clear();
    try { onClose(); } catch (error) { onError(error); }
  };

  const handleChannelError = (event) => {
    if (closed) return;
    const error = event?.error instanceof Error
      ? event.error
      : new Error('Peer data channel error');
    try { onError(error); } catch { /* observer errors are ignored */ }
  };

  const removeMessageListener = addListener(channel, 'message', handleIncoming);
  const removeCloseListener = addListener(channel, 'close', handleChannelClose);
  const removeErrorListener = addListener(channel, 'error', handleChannelError);

  return {
    send(type, payload = {}) {
      const encoded = createPeerMessage(type, payload);
      if (encoded.length <= inlineLimit && peerFrameByteLength(encoded) <= MAX_PEER_FRAME_BYTES) {
        return enqueueEncodedFrames([encoded]);
      }
      const transferId = String(createTransferId?.() ?? '').trim();
      if (!transferId) return Promise.reject(new Error('Peer message transfer id is required'));
      const frames = splitPeerTextTransfer(INTERNAL_MESSAGE_TRANSFER_KIND, encoded, {
        transferId,
        chunkChars,
      }).map((frame) => JSON.stringify(frame));
      return enqueueEncodedFrames(frames);
    },

    sendTextTransfer(kind, text, options = {}) {
      const frames = splitPeerTextTransfer(kind, text, options)
        .map((frame) => JSON.stringify(frame));
      return enqueueEncodedFrames(frames);
    },

    whenDrained() {
      return sendQueue;
    },

    close({ closeChannel = false } = {}) {
      if (closed) return;
      closed = true;
      cancelWaits();
      assembler.clear();
      removeMessageListener();
      removeCloseListener();
      removeErrorListener();
      if (closeChannel) channel.close?.();
    },
  };
}
