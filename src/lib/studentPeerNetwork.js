import { createBrowserPeerConnection } from './browserPeerConnection.js';
import { createPeerDataChannelTransport } from './peerDataChannel.js';
import { createStudentPeerSession } from './studentPeerSession.js';

const TERMINAL_STATES = new Set(['failed', 'closed']);

function normalizeStudentConnectionState(state) {
  const normalized = String(state ?? 'unknown');
  // TeacherPeerNetwork intentionally retires a peer as soon as WebRTC reports
  // `disconnected`. Keeping the student runtime alive in that state creates an
  // asymmetric half-connection: Ably live previews can still move while durable
  // commits/undo have nowhere to go. Enter the existing terminal recovery path
  // immediately so presence refresh creates a fresh DataChannel and resyncs.
  return normalized === 'disconnected' ? 'failed' : normalized;
}

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
  let connection = null;
  let closed = false;
  let ready = false;
  let readinessSettled = false;
  let channelStart = Promise.resolve();
  let resolveReady;
  let rejectReady;
  const readiness = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  const settleReady = () => {
    if (readinessSettled || closed) return;
    readinessSettled = true;
    ready = true;
    resolveReady();
  };

  const rejectReadiness = (error) => {
    if (readinessSettled) return;
    readinessSettled = true;
    rejectReady(error instanceof Error ? error : new Error(String(error)));
  };

  const closeResources = (reason, { reportState = null } = {}) => {
    if (closed) return false;
    closed = true;
    ready = false;
    const error = reason instanceof Error ? reason : new Error(String(reason ?? 'Student peer network closed'));
    rejectReadiness(error);
    try { session?.close?.(error); } catch (caught) { onError(caught); }
    try { transport?.close?.(); } catch (caught) { onError(caught); }
    transport = null;
    session = null;
    try { connection?.close?.(); } catch (caught) { onError(caught); }
    if (reportState) {
      try { onState(reportState); } catch { /* observer errors are ignored */ }
    }
    return true;
  };

  const attachChannel = (channel) => {
    if (closed || transport) return;
    let nextSession;
    transport = createTransport({
      channel,
      onMessage: (message) => Promise.resolve(nextSession?.handleMessage?.(message)).catch(onError),
      onTransfer: (transfer) => Promise.resolve(nextSession?.handleTransfer?.(transfer)).catch(onError),
      onClose: () => {
        if (closed) return;
        const error = new Error('Teacher peer data channel closed');
        closeResources(error, { reportState: 'failed' });
      },
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
    channelStart = Promise.resolve(session.start());
    channelStart.then(settleReady, (error) => {
      try { onError(error); } catch { /* observer errors are ignored */ }
      closeResources(error, { reportState: 'failed' });
    });
  };

  connection = createConnection({
    initiator: true,
    rtcConfig,
    sendSignal: (signal) => signaling.send(targetTeacherId, signal),
    onChannel: attachChannel,
    onConnectionState: (state) => {
      if (closed) return;
      const recoveryState = normalizeStudentConnectionState(state);
      onState(recoveryState);
      if (TERMINAL_STATES.has(recoveryState)) {
        closeResources(new Error(`Student peer connection ${recoveryState}`));
      }
    },
    onError,
  });

  return {
    async start() {
      if (closed) throw new Error('Student peer network is closed');
      try {
        await connection.start();
        await readiness;
      } catch (error) {
        if (!closed) closeResources(error, { reportState: 'failed' });
        throw error;
      }
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

    async proposeActionAndWait(action) {
      if (!session) throw new Error('Teacher peer data channel is not ready');
      await channelStart;
      if (typeof session.proposeActionAndWait !== 'function') {
        throw new Error('Acknowledged durable action API is unavailable');
      }
      return session.proposeActionAndWait(action);
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
      return ready && !closed;
    },

    close() {
      if (closed) return;
      closeResources(new Error('Student peer network is closed'));
    },
  };
}
