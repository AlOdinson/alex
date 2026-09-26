import { createBrowserPeerConnection } from './browserPeerConnection.js';
import { createPeerDataChannelTransport } from './peerDataChannel.js';
import { createStudentPeerSession } from './studentPeerSession.js';
import { createPeerLiveChannel } from './peerLiveChannel.js';

const TERMINAL_STATES = new Set(['failed', 'closed']);
const CONNECT_TIMEOUT_MS = 15_000;
const INITIAL_SYNC_IDLE_TIMEOUT_MS = 90_000;

function positiveTimeout(value, fallback) {
  const milliseconds = Number(value);
  return Number.isFinite(milliseconds) && milliseconds > 0 ? milliseconds : fallback;
}

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
  boardId = '',
  clientId = '',
  teacherId,
  liveEnabled = true,
  signaling,
  rtcConfig = {},
  getRevision,
  applyCommit,
  installSnapshot,
  onAck = () => {},
  onState = () => {},
  onError = () => {},
  onVerificationMode = () => {},
  onBoardControl = () => {},
  connectTimeoutMs = CONNECT_TIMEOUT_MS,
  initialSyncTimeoutMs = INITIAL_SYNC_IDLE_TIMEOUT_MS,
  requestTimeoutMs = 30_000,
  createConnection = createBrowserPeerConnection,
  createTransport = createPeerDataChannelTransport,
  createLiveTransport = createPeerLiveChannel,
  createSession = createStudentPeerSession,
  onLiveEvent = () => {},
  onLiveState = () => {},
} = {}) {
  const targetTeacherId = String(teacherId ?? '').trim();
  if (!targetTeacherId) throw new Error('teacherId is required');
  if (!signaling?.send) throw new Error('signaling bridge is required');
  if (typeof getRevision !== 'function') throw new Error('getRevision is required');
  if (typeof applyCommit !== 'function') throw new Error('applyCommit is required');
  if (typeof installSnapshot !== 'function') throw new Error('installSnapshot is required');

  let transport = null;
  let liveTransport = null;
  let liveState = 'idle';
  let session = null;
  let connection = null;
  let closed = false;
  let ready = false;
  let readinessSettled = false;
  let channelStart = Promise.resolve();
  let startPromise = null;
  let connectTimer = null;
  let initialSyncTimer = null;
  let resolveReady;
  let rejectReady;
  const readiness = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  // Resource closure may precede start(), or signaling itself may never resolve.
  // Keep the original promise rejected for its callers without an orphan rejection.
  readiness.catch(() => undefined);

  const clearStartupTimers = () => {
    clearTimeout(connectTimer);
    clearTimeout(initialSyncTimer);
    connectTimer = null;
    initialSyncTimer = null;
  };

  const settleReady = () => {
    if (readinessSettled || closed) return;
    clearStartupTimers();
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
    clearStartupTimers();
    const error = reason instanceof Error ? reason : new Error(String(reason ?? 'Student peer network closed'));
    rejectReadiness(error);
    try { session?.close?.(error); } catch (caught) { onError(caught); }
    try { liveTransport?.close?.(); } catch (caught) { onError(caught); }
    liveTransport = null;
    liveState = 'closed';
    try { transport?.close?.(); } catch (caught) { onError(caught); }
    transport = null;
    session = null;
    try { connection?.close?.(); } catch (caught) { onError(caught); }
    if (reportState) {
      try { onState(reportState); } catch { /* observer errors are ignored */ }
    }
    return true;
  };

  const failConnection = (error) => {
    if (closed) return;
    try { onError(error); } catch { /* observer errors are ignored */ }
    closeResources(error, { reportState: 'failed' });
  };

  const recordInitialSyncProgress = () => {
    if (closed || readinessSettled) return;
    clearTimeout(initialSyncTimer);
    // This is an inactivity deadline, not a total transfer-duration limit. Large
    // snapshots can keep receiving chunks for as long as they make progress.
    initialSyncTimer = setTimeout(() => {
      closeResources(new Error('Initial board snapshot timed out'), { reportState: 'failed' });
    }, positiveTimeout(initialSyncTimeoutMs, INITIAL_SYNC_IDLE_TIMEOUT_MS));
  };

  const awaitAcknowledgement = (task) => {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error('Board action acknowledgement timed out');
        closeResources(error, { reportState: 'failed' });
        reject(error);
      }, positiveTimeout(requestTimeoutMs, 30_000));
    });
    // A timeout is an unknown outcome, not permission to commit a second action.
    // The caller retains its actionId and obtains the durable outcome on retry.
    return Promise.race([task, timeout]).finally(() => clearTimeout(timer));
  };

  const attachChannel = (channel) => {
    if (closed || transport) return;
    clearTimeout(connectTimer);
    connectTimer = null;
    recordInitialSyncProgress();
    let nextSession;
    transport = createTransport({
      channel,
      onMessage: (message) => Promise.resolve().then(() => nextSession?.handleMessage?.(message)).catch(failConnection),
      onTransfer: (transfer) => Promise.resolve().then(() => nextSession?.handleTransfer?.(transfer)).catch(failConnection),
      onProgress: recordInitialSyncProgress,
      onClose: () => {
        if (closed) return;
        const error = new Error('Teacher peer data channel closed');
        closeResources(error, { reportState: 'failed' });
      },
      onError: failConnection,
    });
    nextSession = createSession({
      onVerificationMode,
      transport,
      getRevision,
      applyCommit,
      installSnapshot,
      onAck,
      onError,
      onBoardControl,
    });
    session = nextSession;
    channelStart = Promise.resolve(session.start());
    channelStart.then(settleReady, failConnection);
  };

  const attachLiveChannel = (channel) => {
    if (!liveEnabled) {
      try { channel?.close?.(); } catch { /* legacy mode ignores live channel */ }
      return;
    }
    if (closed) {
      try { channel?.close?.(); } catch { /* stale channel */ }
      return;
    }
    if (liveTransport) {
      try { channel?.close?.(); } catch { /* duplicate live channel */ }
      return;
    }
    liveTransport = createLiveTransport({
      channel,
      boardId: String(boardId ?? ''),
      localClientId: String(clientId ?? ''),
      remoteClientId: targetTeacherId,
      getRevision,
      onEvent: (type, payload, envelope) => {
        if (closed) return;
        try { onLiveEvent(type, payload, envelope); } catch (error) { onError(error); }
      },
      onState: (state) => {
        if (closed) return;
        liveState = String(state ?? 'unknown');
        try { onLiveState(liveState); } catch (error) { onError(error); }
      },
      onError: (error) => {
        if (closed) return;
        try { onError(error); } catch { /* observer errors are ignored */ }
      },
    });
    if (liveState === 'idle') liveState = channel?.readyState === 'open' ? 'open' : 'connecting';
  };

  connection = createConnection({
    initiator: true,
    enableLiveChannel: Boolean(liveEnabled),
    assistSignaling: true,
    rtcConfig,
    sendSignal: (signal) => signaling.send(targetTeacherId, signal),
    onChannel: attachChannel,
    onLiveChannel: attachLiveChannel,
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
    start() {
      if (closed) return Promise.reject(new Error('Student peer network is closed'));
      if (startPromise) return startPromise;
      if (!transport && !readinessSettled) {
        connectTimer = setTimeout(() => {
          closeResources(new Error('Teacher peer connection timed out'), { reportState: 'failed' });
        }, positiveTimeout(connectTimeoutMs, CONNECT_TIMEOUT_MS));
      }
      startPromise = (async () => {
        try {
          // Observe signaling failure, but let actual channel + snapshot readiness
          // complete startup. A lost signaling receipt must neither block a board
          // already received over P2P nor tear down that healthy channel later.
          Promise.resolve(connection.start()).catch((error) => {
            if (closed) return;
            try { onError(error); } catch { /* observer errors are ignored */ }
            if (!ready) closeResources(error, { reportState: 'failed' });
          });
          await readiness;
        } catch (error) {
          if (!closed) closeResources(error, { reportState: 'failed' });
          throw error;
        }
      })();
      return startPromise;
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
      return awaitAcknowledgement(session.proposeActionAndWait(action));
    },

    async sendBoardControl(event, payload = {}) {
      if (!session) throw new Error('Teacher peer data channel is not ready');
      await channelStart;
      if (typeof session.sendBoardControl !== 'function') throw new Error('Peer board-control API is unavailable');
      return session.sendBoardControl(event, payload);
    },

    async requestLock(operation, payload = {}) {
      if (!session) throw new Error('Teacher peer data channel is not ready');
      await channelStart;
      if (typeof session.requestLock !== 'function') throw new Error('Peer lock API is unavailable');
      return awaitAcknowledgement(session.requestLock(operation, payload));
    },

    sendLive(type, payload, options = {}) {
      if (!liveTransport?.send) return 'unavailable';
      return liveTransport.send(type, payload, options);
    },

    getLiveState() { return liveState; },

    getLiveStats() { return liveTransport?.stats?.() ?? null; },

    getVerificationMode() { return session?.getVerificationMode?.() ?? { version: 0, epoch: '' }; },
    verifyObjects(request) {
      return session?.verifyObjects?.(request) ?? Promise.reject(new Error('Verification session is unavailable'));
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
