import { createBrowserPeerConnection } from './browserPeerConnection.js';
import { createPeerDataChannelTransport } from './peerDataChannel.js';
import { createStudentPeerSession } from './studentPeerSession.js';

const TERMINAL_STATES = new Set(['failed', 'closed']);

export function createStudentPeerNetwork({
  teacherId,
  signaling,
  rtcConfig = {},
  getRevision,
  applyCommit,
  installSnapshot,
  onAck = () => {},
  onState = () => {},
  onError = () => {},
  createConnection = createBrowserPeerConnection,
  createTransport = createPeerDataChannelTransport,
  createSession = createStudentPeerSession,
} = {}) {
  const targetTeacherId = String(teacherId ?? '').trim();
  if (!targetTeacherId) throw new Error('teacherId is required');
  if (!signaling?.send) throw new Error('signaling bridge is required');
  if (typeof getRevision !== 'function') throw new Error('getRevision is required');
  if (typeof applyCommit !== 'function') throw new Error('applyCommit is required');
  if (typeof installSnapshot !== 'function') throw new Error('installSnapshot is required');

  let transport = null;
  let session = null;
  let closed = false;
  let channelStart = Promise.resolve();

  const attachChannel = (channel) => {
    if (closed || transport) return;
    let nextSession;
    transport = createTransport({
      channel,
      onMessage: (message) => Promise.resolve(nextSession?.handleMessage?.(message)).catch(onError),
      onTransfer: (transfer) => Promise.resolve(nextSession?.handleTransfer?.(transfer)).catch(onError),
      onError,
    });
    nextSession = createSession({
      transport,
      getRevision,
      applyCommit,
      installSnapshot,
      onAck,
      onError,
    });
    session = nextSession;
    channelStart = Promise.resolve(session.start()).catch((error) => {
      onError(error);
      throw error;
    });
  };

  const connection = createConnection({
    initiator: true,
    rtcConfig,
    sendSignal: (signal) => signaling.send(targetTeacherId, signal),
    onChannel: attachChannel,
    onConnectionState: (state) => {
      onState(state);
      if (TERMINAL_STATES.has(String(state))) {
        try { transport?.close?.(); } catch (error) { onError(error); }
      }
    },
    onError,
  });

  return {
    start() {
      if (closed) throw new Error('Student peer network is closed');
      return connection.start();
    },

    async handleSignal(message) {
      if (closed) return false;
      if (String(message?.sourceId ?? '') !== targetTeacherId || !message?.signal) return false;
      await connection.handleSignal(message.signal);
      return true;
    },

    async proposeAction(action) {
      if (!session) throw new Error('Teacher peer data channel is not ready');
      await channelStart;
      return session.proposeAction(action);
    },

    async requestLock(operation, payload = {}) {
      if (!session) throw new Error('Teacher peer data channel is not ready');
      await channelStart;
      if (typeof session.requestLock !== 'function') throw new Error('Peer lock API is unavailable');
      return session.requestLock(operation, payload);
    },

    whenIdle() {
      return Promise.all([
        channelStart.catch(() => undefined),
        session?.whenIdle?.() ?? Promise.resolve(),
      ]);
    },

    isReady() {
      return Boolean(session);
    },

    close() {
      if (closed) return;
      closed = true;
      try { transport?.close?.(); } catch (error) { onError(error); }
      transport = null;
      session = null;
      try { connection.close?.(); } catch (error) { onError(error); }
    },
  };
}
