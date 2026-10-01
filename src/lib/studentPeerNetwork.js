import { createDualPathPeerPair } from './dualPathPeerPair.js';
import { createBrowserPeerConnection } from './browserPeerConnection.js';
import { createPeerDataChannelTransport } from './peerDataChannel.js';
import { createStudentPeerSession } from './studentPeerSession.js';
import { createPeerLiveChannel } from './peerLiveChannel.js';
import { reportConnectionProgress } from './connectionProgress.js';

const CONNECT_TIMEOUT_MS = 10_000;
const INITIAL_SYNC_IDLE_TIMEOUT_MS = 90_000;
const DISCONNECT_GRACE_MS = 3_500;
const PRIMARY_PATH_TIMEOUT_MS = 4_000;

function positiveTimeout(value, fallback) {
  const milliseconds = Number(value);
  return Number.isFinite(milliseconds) && milliseconds > 0 ? milliseconds : fallback;
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
  onProgress = () => {},
  onVerificationMode = () => {},
  onBoardControl = () => {},
  connectTimeoutMs = CONNECT_TIMEOUT_MS,
  initialSyncTimeoutMs = INITIAL_SYNC_IDLE_TIMEOUT_MS,
  requestTimeoutMs = 30_000,
  disconnectGraceMs = DISCONNECT_GRACE_MS,
  primaryPathTimeoutMs = PRIMARY_PATH_TIMEOUT_MS,
  createPair = createDualPathPeerPair,
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
  let liveChannel = null;
  const liveSequence = { value: 0 };
  const liveReceived = new Map();
  let liveState = 'idle';
  let session = null;
  let selectedPath = '';
  let closed = false;
  let ready = false;
  let readinessSettled = false;
  let channelStart = Promise.resolve();
  let startPromise = null;
  let recoveryCheck = null;
  let initialSyncTimer = null;
  let initialStep = 4;
  let resolveReady;
  let rejectReady;

  const readiness = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  readiness.catch(() => undefined);

  const rejectReadiness = (error) => {
    if (readinessSettled) return;
    readinessSettled = true;
    rejectReady(error instanceof Error ? error : new Error(String(error)));
  };

  const clearInitialSyncTimer = () => {
    clearTimeout(initialSyncTimer);
    initialSyncTimer = null;
  };

  const recordInitialSyncProgress = () => {
    if (closed || readinessSettled) return;
    clearInitialSyncTimer();
    initialSyncTimer = setTimeout(() => {
      closeResources(new Error('Initial board snapshot timed out'), { reportState: 'failed' });
    }, positiveTimeout(initialSyncTimeoutMs, INITIAL_SYNC_IDLE_TIMEOUT_MS));
    initialSyncTimer?.unref?.();
  };

  const settleReady = () => {
    if (readinessSettled || closed) return;
    clearInitialSyncTimer();
    readinessSettled = true;
    ready = true;
    resolveReady();
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
    return Promise.race([task, timeout]).finally(() => clearTimeout(timer));
  };

  const pair = createPair({
    localRole: 'student',
    peerId: targetTeacherId,
    signaling,
    rtcConfig,
    enableLiveChannel: Boolean(liveEnabled),
    connectTimeoutMs,
    disconnectGraceMs,
    primaryPathTimeoutMs,
    createConnection,
    onProgress,
    onSelectedChannel: (channel, path) => {
      if (closed || transport) {
        if (closed) {
          try { channel?.close?.(); } catch { /* stale */ }
        }
        return;
      }
      selectedPath = path;
      recordInitialSyncProgress();
      let nextSession;
      transport = createTransport({
        channel,
        onMessage: (message) => Promise.resolve().then(() => nextSession?.handleMessage?.(message)).catch(failConnection),
        onTransfer: (transfer) => Promise.resolve().then(() => nextSession?.handleTransfer?.(transfer)).catch(failConnection),
        onProgress: () => {
          recordInitialSyncProgress();
          if (!readinessSettled && initialStep === 5) reportConnectionProgress(onProgress, 5, 'receiving');
        },
        onClose: () => {
          if (!closed) closeResources(new Error('Teacher peer data channel closed'), { reportState: 'failed' });
        },
        onError: failConnection,
      });
      nextSession = createSession({
        boardId,
        onProgress: (event) => {
          initialStep = event.step;
          reportConnectionProgress(onProgress, event.step, event.detail, event);
        },
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
    },
    onSelectedLiveChannel: (channel) => {
      if (!liveEnabled || closed) {
        try { channel?.close?.(); } catch { /* unused */ }
        return;
      }
      if (liveTransport) {
        try { channel?.close?.(); } catch { /* duplicate */ }
        return;
      }
      liveChannel = channel;
      liveTransport = createLiveTransport({
        sequence: liveSequence, highestSeqByStream: liveReceived, allowRelayed: true,
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
          if (closed || liveChannel !== channel) return;
          const channelState = String(state ?? 'unknown');
          liveState = pair.isLiveExpected?.() === false ? 'disabled' : channelState;
          try { onLiveState(liveState); } catch (error) { onError(error); }
          if (channelState === 'closed' || channelState === 'error') {
            const retired = liveTransport; liveTransport = null; liveChannel = null;
            Promise.resolve().then(() => {
              retired?.close?.();
              if (!closed) pair.repairLiveChannel?.();
            }).catch(failConnection);
          }
        },
        onError: (error) => {
          if (!closed) {
            try { onError(error); } catch { /* observer */ }
          }
        },
      });
      liveState = channel?.readyState === 'open' ? 'open' : 'connecting';
    },
    onState: (state) => {
      if (closed) return;
      try { onState(state); } catch { /* observer */ }
    },
    onFatal: (error) => failConnection(error),
    checkHealth: () => transport?.probe?.() ?? false,
    onError,
  });

  function closeResources(reason, { reportState = null } = {}) {
    if (closed) return false;
    closed = true;
    ready = false;
    clearInitialSyncTimer();
    const error = reason instanceof Error ? reason : new Error(String(reason ?? 'Student peer network closed'));
    rejectReadiness(error);
    try { session?.close?.(error); } catch (caught) { onError(caught); }
    try { liveTransport?.close?.(); } catch (caught) { onError(caught); }
    liveTransport = null;
    liveState = 'closed';
    try { transport?.close?.(); } catch (caught) { onError(caught); }
    transport = null;
    session = null;
    try { pair?.close?.(); } catch (caught) { onError(caught); }
    if (reportState) {
      try { onState(reportState); } catch { /* observer */ }
    }
    return true;
  }

  function failConnection(error) {
    if (closed) return;
    try { onError(error); } catch { /* observer */ }
    closeResources(error, { reportState: 'failed' });
  }

  return {
    start() {
      if (closed) return Promise.reject(new Error('Student peer network is closed'));
      if (startPromise) return startPromise;
      startPromise = (async () => {
        try {
          await pair.start();
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
      return pair.handleSignal(message.signal);
    },

    ensureMediaAsset(assetId) {
      if (!session) return Promise.reject(new Error('Teacher peer data channel is not ready'));
      return session.ensureMediaAsset(assetId);
    },
    requestMediaAsset(assetId) {
      if (!session) return Promise.reject(new Error('Teacher peer data channel is not ready'));
      return session.requestMediaAsset(assetId);
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

    recoverConnections() {
      if (closed || !ready || !transport || !pair.canProbe?.()) return Promise.resolve(false);
      if (recoveryCheck) return recoveryCheck;
      recoveryCheck = Promise.resolve(transport.probe?.()).then(healthy => {
        if (closed) return false;
        if (healthy === false) pair.recover?.();
        else if (healthy === true) {
          pair.confirmHealthy?.();
          if (liveEnabled && liveState !== 'open') pair.repairLiveChannel?.();
        }
        return healthy === true;
      }).finally(() => { recoveryCheck = null; });
      return recoveryCheck;
    },
    getConnectionDiagnostics() { return pair.getDiagnostics?.() ?? Promise.resolve({}); },
    getLiveState() { return liveState; },

    getLiveStats() { return liveTransport?.stats?.() ?? null; },

    getSelectedPath() { return selectedPath; },

    getVerificationMode() {
      return session?.getVerificationMode?.() ?? { version: 0, epoch: '' };
    },

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
