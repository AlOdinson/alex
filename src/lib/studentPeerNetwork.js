import { createBrowserPeerConnection } from './browserPeerConnection.js';
import { createPeerDataChannelTransport } from './peerDataChannel.js';
import { createStudentPeerSession } from './studentPeerSession.js';
import { createPeerLiveChannel } from './peerLiveChannel.js';

const TERMINAL_STATES = new Set(['failed', 'closed']);
const CONNECT_TIMEOUT_MS = 10_000;
const INITIAL_SYNC_IDLE_TIMEOUT_MS = 90_000;
const DISCONNECT_GRACE_MS = 3_500;
const ROLE_SWITCH_DELAY_MS = 5_000;
const ROLE_SWITCH_REPLAY_DELAY_MS = 2_500;

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
  onVerificationMode = () => {},
  onBoardControl = () => {},
  connectTimeoutMs = CONNECT_TIMEOUT_MS,
  initialSyncTimeoutMs = INITIAL_SYNC_IDLE_TIMEOUT_MS,
  requestTimeoutMs = 30_000,
  disconnectGraceMs = DISCONNECT_GRACE_MS,
  roleSwitchDelayMs = ROLE_SWITCH_DELAY_MS,
  roleSwitchReplayDelayMs = ROLE_SWITCH_REPLAY_DELAY_MS,
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
  let connectionGeneration = 0;
  let currentInitiator = true;
  let roleSwitched = false;
  let closed = false;
  let ready = false;
  let readinessSettled = false;
  let channelStart = Promise.resolve();
  let startPromise = null;
  let connectTimer = null;
  let initialSyncTimer = null;
  let disconnectTimer = null;
  let roleSwitchTimer = null;
  let roleSwitchReplayTimer = null;
  let resolveReady;
  let rejectReady;
  const readiness = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  readiness.catch(() => undefined);

  const clearDisconnectTimer = () => {
    clearTimeout(disconnectTimer);
    disconnectTimer = null;
  };

  const clearRoleSwitchTimers = () => {
    clearTimeout(roleSwitchTimer);
    clearTimeout(roleSwitchReplayTimer);
    roleSwitchTimer = null;
    roleSwitchReplayTimer = null;
  };

  const clearStartupTimers = () => {
    clearTimeout(connectTimer);
    clearTimeout(initialSyncTimer);
    connectTimer = null;
    initialSyncTimer = null;
    clearDisconnectTimer();
    clearRoleSwitchTimers();
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
    const previousConnection = connection;
    connection = null;
    connectionGeneration += 1;
    try { previousConnection?.close?.(); } catch (caught) { onError(caught); }
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
    return Promise.race([task, timeout]).finally(() => clearTimeout(timer));
  };

  const attachChannel = (channel, generation) => {
    if (generation !== connectionGeneration || closed || transport) {
      if (generation !== connectionGeneration || closed) {
        try { channel?.close?.(); } catch { /* stale channel */ }
      }
      return;
    }
    clearTimeout(connectTimer);
    connectTimer = null;
    clearRoleSwitchTimers();
    clearDisconnectTimer();
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

  const attachLiveChannel = (channel, generation) => {
    if (generation !== connectionGeneration || !liveEnabled || closed) {
      try { channel?.close?.(); } catch { /* stale or legacy live channel */ }
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

  const createActiveConnection = (initiator) => {
    const generation = ++connectionGeneration;
    currentInitiator = Boolean(initiator);
    const nextConnection = createConnection({
      initiator: currentInitiator,
      enableLiveChannel: Boolean(liveEnabled),
      assistSignaling: true,
      rtcConfig,
      sendSignal: (signal) => signaling.send(targetTeacherId, signal),
      onChannel: (channel) => attachChannel(channel, generation),
      onLiveChannel: (channel) => attachLiveChannel(channel, generation),
      onConnectionState: (state) => {
        if (closed || generation !== connectionGeneration) return;
        const normalized = String(state ?? 'unknown');
        try { onState(normalized); } catch { /* observer errors are ignored */ }
        if (normalized === 'disconnected') {
          if (!disconnectTimer) {
            disconnectTimer = setTimeout(() => {
              disconnectTimer = null;
              if (closed || generation !== connectionGeneration) return;
              closeResources(new Error('Student peer connection remained disconnected'), { reportState: 'failed' });
            }, positiveTimeout(disconnectGraceMs, DISCONNECT_GRACE_MS));
            disconnectTimer?.unref?.();
          }
          return;
        }
        clearDisconnectTimer();
        if (TERMINAL_STATES.has(normalized)) {
          closeResources(new Error('Student peer connection ' + normalized));
        }
      },
      onError,
    });
    connection = nextConnection;
    return nextConnection;
  };

  const publishRoleSwitch = () => Promise.resolve(
    signaling.send(targetTeacherId, { type: 'role-switch' }),
  ).catch((error) => {
    if (closed) return;
    try { onError(error); } catch { /* observer errors are ignored */ }
  });

  const switchToResponder = async ({ notifyTeacher = true } = {}) => {
    if (closed || transport || roleSwitched) return false;
    roleSwitched = true;
    clearRoleSwitchTimers();
    clearDisconnectTimer();

    const previousConnection = connection;
    connection = null;
    connectionGeneration += 1;
    try { previousConnection?.close?.(); } catch (error) { onError(error); }

    try { liveTransport?.close?.(); } catch (error) { onError(error); }
    liveTransport = null;
    liveState = 'idle';

    const responder = createActiveConnection(false);
    await responder.start();
    if (closed || transport) return true;

    if (notifyTeacher) {
      void publishRoleSwitch();
      roleSwitchReplayTimer = setTimeout(() => {
        roleSwitchReplayTimer = null;
        if (!closed && !transport) void publishRoleSwitch();
      }, positiveTimeout(roleSwitchReplayDelayMs, ROLE_SWITCH_REPLAY_DELAY_MS));
      roleSwitchReplayTimer?.unref?.();
    }
    return true;
  };

  createActiveConnection(true);

  return {
    start() {
      if (closed) return Promise.reject(new Error('Student peer network is closed'));
      if (startPromise) return startPromise;
      if (!transport && !readinessSettled) {
        connectTimer = setTimeout(() => {
          closeResources(new Error('Teacher peer connection timed out'), { reportState: 'failed' });
        }, positiveTimeout(connectTimeoutMs, CONNECT_TIMEOUT_MS));
        roleSwitchTimer = setTimeout(() => {
          roleSwitchTimer = null;
          if (closed || transport || roleSwitched) return;
          switchToResponder().catch(failConnection);
        }, positiveTimeout(roleSwitchDelayMs, ROLE_SWITCH_DELAY_MS));
        roleSwitchTimer?.unref?.();
      }
      const initialConnection = connection;
      startPromise = (async () => {
        try {
          Promise.resolve(initialConnection.start()).catch((error) => {
            if (closed || initialConnection !== connection) return;
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
      if (message.signal.type === 'role-switch') return false;
      if (message.signal.type === 'offer' && currentInitiator && !transport) {
        await switchToResponder({ notifyTeacher: false });
      }
      await connection?.handleSignal?.(message.signal);
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
