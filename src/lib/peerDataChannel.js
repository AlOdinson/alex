import {
  createPeerMessage,
  decodePeerMessage,
  splitPeerTextTransfer,
  createPeerTextAssembler,
} from './peerProtocol.js';

const TRANSFER_TYPES = new Set(['transfer-start', 'transfer-chunk', 'transfer-end']);

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
  onError = () => {},
  highWaterMark = 512_000,
  lowWaterMark = 128_000,
} = {}) {
  if (!channel?.send) throw new Error('RTCDataChannel is required');

  const highWater = Math.max(1, Number(highWaterMark) || 512_000);
  const lowWater = Math.max(0, Math.min(highWater, Number(lowWaterMark) || 128_000));
  const assembler = createPeerTextAssembler();
  let closed = false;
  let sendQueue = Promise.resolve();

  const waitForOpen = () => {
    if (channel.readyState === 'open') return Promise.resolve();
    if (channel.readyState === 'closed' || channel.readyState === 'closing') {
      return Promise.reject(new Error('Peer data channel is closed'));
    }
    return new Promise((resolve, reject) => {
      const cleanupOpen = addListener(channel, 'open', () => {
        cleanup();
        resolve();
      }, { once: true });
      const cleanupClose = addListener(channel, 'close', () => {
        cleanup();
        reject(new Error('Peer data channel closed before opening'));
      }, { once: true });
      const cleanup = () => {
        cleanupOpen();
        cleanupClose();
      };
    });
  };

  const waitForWritable = async () => {
    await waitForOpen();
    if (Number(channel.bufferedAmount ?? 0) <= highWater) return;
    channel.bufferedAmountLowThreshold = lowWater;
    await new Promise((resolve, reject) => {
      const cleanupLow = addListener(channel, 'bufferedamountlow', () => {
        cleanup();
        resolve();
      }, { once: true });
      const cleanupClose = addListener(channel, 'close', () => {
        cleanup();
        reject(new Error('Peer data channel closed while waiting for buffer space'));
      }, { once: true });
      const cleanup = () => {
        cleanupLow();
        cleanupClose();
      };
    });
  };

  const enqueueEncodedFrames = (frames) => {
    const task = sendQueue.then(async () => {
      for (const frame of frames) {
        if (closed) throw new Error('Peer data channel transport is closed');
        // eslint-disable-next-line no-await-in-loop
        await waitForWritable();
        channel.send(frame);
      }
    });
    sendQueue = task.catch(() => undefined);
    return task;
  };

  const handleIncoming = (event) => {
    if (closed || typeof event?.data !== 'string') return;
    try {
      const message = decodePeerMessage(event.data);
      if (TRANSFER_TYPES.has(message.type)) {
        const completed = assembler.accept(message);
        if (completed) onTransfer(completed);
        return;
      }
      onMessage(message);
    } catch (error) {
      onError(error);
    }
  };

  const removeMessageListener = addListener(channel, 'message', handleIncoming);

  return {
    send(type, payload = {}) {
      return enqueueEncodedFrames([createPeerMessage(type, payload)]);
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
      assembler.clear();
      removeMessageListener();
      if (closeChannel) channel.close?.();
    },
  };
}
