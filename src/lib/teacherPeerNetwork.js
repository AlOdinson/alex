import { createDualPathPeerPair, OWNER_INITIATED_PATH, STUDENT_INITIATED_PATH } from './dualPathPeerPair.js';
import { signalingNegotiationId } from './peerSignalingAssistance.js';
import { createBrowserPeerConnection } from './browserPeerConnection.js';
import { createPeerDataChannelTransport } from './peerDataChannel.js';
import { createPeerLiveChannel } from './peerLiveChannel.js';

const CONNECT_TIMEOUT_MS = 10_000;
const DISCONNECT_GRACE_MS = 3_500;
const PRIMARY_PATH_TIMEOUT_MS = 4_000;

export function createTeacherPeerNetwork({
  boardId = '',
  clientId = '',
  getRevision = () => 0,
  signaling,
  peerHub,
  rtcConfig = {},
  connectTimeoutMs = CONNECT_TIMEOUT_MS,
  disconnectGraceMs = DISCONNECT_GRACE_MS,
  primaryPathTimeoutMs = PRIMARY_PATH_TIMEOUT_MS,
  createPair = createDualPathPeerPair,
  createConnection = createBrowserPeerConnection,
  createTransport = createPeerDataChannelTransport,
  createLiveTransport = createPeerLiveChannel,
  onPeerState = () => {},
  onLiveEvent = () => {},
  onLiveState = () => {},
  onError = () => {},
} = {}) {
  if (!signaling?.send) throw new Error('signaling bridge is required');
  if (!peerHub?.addPeer || !peerHub?.removePeer || !peerHub?.handleMessage) {
    throw new Error('teacher peer hub is required');
  }

  const peers = new Map();
  // Remember retired generations across pair replacement: delayed Ably offers
  // must not evict the student's newer connection. Both dimensions are bounded.
  const retiredNegotiations = new Map();
  const retire = (peerId, negotiationId) => {
    if (!negotiationId) return;
    if (!retiredNegotiations.has(peerId)) {
      if (retiredNegotiations.size >= 128) retiredNegotiations.delete(retiredNegotiations.keys().next().value);
      retiredNegotiations.set(peerId, new Set());
    }
    const ids = retiredNegotiations.get(peerId);
    if (ids.size >= 64) ids.delete(ids.values().next().value);
    ids.add(negotiationId);
  };
  let closed = false;

  const closePeer = (peerId, expectedEntry = null) => {
    const id = String(peerId ?? '').trim();
    const entry = peers.get(id);
    if (!entry) return false;
    if (expectedEntry && entry !== expectedEntry) return false;
    for (const negotiationId of entry.offerIds) retire(id, negotiationId);
    for (const path of [OWNER_INITIATED_PATH, STUDENT_INITIATED_PATH]) {
      retire(id, entry.pair?.getCandidateState?.(path)?.negotiationId);
    }
    peers.delete(id);
    entry.closed = true;
    try { entry.liveTransport?.close?.(); } catch (error) { onError(error); }
    try { entry.transport?.close?.(); } catch (error) { onError(error); }
    try { entry.unregister?.(); } catch (error) { onError(error); }
    try { peerHub.removePeer(id); } catch (error) { onError(error); }
    try { entry.pair?.close?.(); } catch (error) { onError(error); }
    return true;
  };

  const failPeer = (peerId, entry, error) => {
    if (peers.get(peerId) !== entry) return;
    try { onError(error); } catch { /* observer */ }
    try { onPeerState(peerId, 'failed'); } catch { /* observer */ }
    closePeer(peerId, entry);
  };

  const attachTransport = (peerId, entry, channel) => {
    if (peers.get(peerId) !== entry || entry.closed) {
      try { channel?.close?.(); } catch { /* stale */ }
      return null;
    }
    if (entry.transport) return entry.transport;

    let transport;
    transport = createTransport({
      channel,
      onMessage: (message) => Promise.resolve().then(() => {
        if (peers.get(peerId) !== entry || entry.transport !== transport) return;
        return peerHub.handleMessage(peerId, message);
      }).catch((error) => failPeer(peerId, entry, error)),
      onTransfer: () => {},
      onClose: () => {
        if (peers.get(peerId) === entry && entry.transport === transport) {
          failPeer(peerId, entry, new Error('Teacher peer data channel closed'));
        }
      },
      onError: (error) => failPeer(peerId, entry, error),
    });
    entry.transport = transport;
    entry.unregister = peerHub.addPeer(peerId, transport);
    return transport;
  };

  const attachLiveTransport = (peerId, entry, channel) => {
    if (peers.get(peerId) !== entry || entry.closed) {
      try { channel?.close?.(); } catch { /* stale */ }
      return null;
    }
    if (entry.liveTransport) return entry.liveTransport;

    entry.liveChannel = channel;
    const liveTransport = createLiveTransport({
      sequence: entry.liveSequence, highestSeqByStream: entry.liveReceived,
      channel,
      boardId: String(boardId ?? ''),
      localClientId: String(clientId ?? ''),
      remoteClientId: peerId,
      getRevision,
      onEvent: (type, payload, envelope) => {
        if (peers.get(peerId) !== entry) return;
        try { onLiveEvent(peerId, type, payload, envelope); } catch (error) { onError(error); }
      },
      onState: (state) => {
        if (peers.get(peerId) !== entry || entry.liveChannel !== channel) return;
        const channelState = String(state ?? 'unknown');
        entry.liveState = entry.pair?.isLiveExpected?.() === false ? 'disabled' : channelState;
        try { onLiveState(peerId, entry.liveState); } catch (error) { onError(error); }
        if (channelState === 'closed' || channelState === 'error') {
          const retired = entry.liveTransport; entry.liveTransport = null; entry.liveChannel = null;
          Promise.resolve().then(() => {
            retired?.close?.();
            if (peers.get(peerId) === entry) entry.pair.repairLiveChannel?.();
          }).catch(error => failPeer(peerId, entry, error));
        }
      },
      onError: (error) => {
        if (peers.get(peerId) === entry) {
          try { onError(error); } catch { /* observer */ }
        }
      },
    });
    entry.liveTransport = liveTransport;
    entry.liveState = channel?.readyState === 'open' ? 'open' : 'connecting';
    return liveTransport;
  };

  const ensurePeer = (peerId) => {
    const id = String(peerId ?? '').trim();
    if (!id) throw new Error('peerId is required');
    const existing = peers.get(id);
    if (existing) return existing;

    const entry = {
      pair: null,
      transport: null,
      liveTransport: null,
      liveState: 'idle',
      liveSequence: { value: 0 },
      liveReceived: new Map(),
      liveChannel: null,
      unregister: null,
      selectedPath: '',
      closed: false,
      offerIds: new Set(),
    };

    const pair = createPair({
      localRole: 'owner',
      peerId: id,
      signaling,
      rtcConfig,
      enableLiveChannel: true,
      connectTimeoutMs,
      disconnectGraceMs,
      primaryPathTimeoutMs,
      createConnection,
      checkHealth: () => entry.transport?.probe?.() ?? false,
      onSelectedChannel: (channel, path) => {
        if (peers.get(id) !== entry) return;
        entry.selectedPath = path;
        attachTransport(id, entry, channel);
      },
      onSelectedLiveChannel: (channel) => attachLiveTransport(id, entry, channel),
      onState: (state) => {
        if (peers.get(id) !== entry) return;
        try { onPeerState(id, state); } catch { /* observer */ }
      },
      onFatal: (error) => failPeer(id, entry, error),
      onError,
    });
    entry.pair = pair;
    peers.set(id, entry);
    return entry;
  };

  return {
    updateParticipants(peerIds = []) {
      if (closed) return 0;
      const ids = [...new Set((Array.isArray(peerIds) ? peerIds : [])
        .map((value) => String(value ?? '').trim())
        .filter((value) => value && value !== String(clientId ?? '').trim()))];
      for (const id of ids) {
        const entry = ensurePeer(id);
        Promise.resolve(entry.pair.start()).catch((error) => failPeer(id, entry, error));
      }
      return ids.length;
    },

    async handleSignal(message) {
      if (closed) return false;
      const peerId = String(message?.sourceId ?? '').trim();
      const signal = message?.signal;
      if (!peerId || !signal) return false;
      const negotiationId = signalingNegotiationId(signal);
      if (negotiationId && retiredNegotiations.get(peerId)?.has(negotiationId)) return false;
      let entry = ensurePeer(peerId);
      // Validate before retiring a network entry: pair-level validation happens
      // too late once its healthy transport and hub registration were removed.
      if (signal.attemptId != null && (typeof signal.attemptId !== 'string'
        || !signal.attemptId || signal.attemptId.length > 128
        || (entry.pair?.getAttemptId?.() && signal.attemptId !== entry.pair.getAttemptId()))) return false;
      const selectedPath = entry.pair?.getSelectedPath?.();
      const freshOffer = signal.type === 'offer' && signal.description && negotiationId
        && (!signal.path || signal.path === STUDENT_INITIATED_PATH)
        && (!signal.attemptId || signal.pathSequence === 1);
      const failedPrimary = signal.type === 'path-select-request'
        && signal.path === STUDENT_INITIATED_PATH && signal.abandoned === true
        && selectedPath && negotiationId
        && (!signal.attemptId || signal.pathSequence === (selectedPath === STUDENT_INITIATED_PATH ? 1 : 0))
        && entry.pair?.getCandidateState?.(selectedPath)?.negotiationId === negotiationId;
      if (failedPrimary || (freshOffer && selectedPath
        && entry.pair?.getCandidateState?.(selectedPath)?.negotiationId !== negotiationId
        && !entry.offerIds.has(negotiationId))) {
        // The remote application has started a new generation even if our native
        // channel has not yet noticed its closure. Release transport/hub/locks too.
        closePeer(peerId, entry);
        entry = ensurePeer(peerId);
      }
      if (freshOffer) {
        if (entry.offerIds.size >= 64) {
          const oldest = entry.offerIds.values().next().value;
          retire(peerId, oldest);
          entry.offerIds.delete(oldest);
        }
        entry.offerIds.add(negotiationId);
      }
      Promise.resolve(entry.pair.start()).catch((error) => failPeer(peerId, entry, error));
      return entry.pair.handleSignal(signal);
    },

    recoverConnections() {
      return Promise.allSettled([...peers.values()].map(entry => {
        if (!entry.transport || !entry.pair.canProbe?.()) return false;
        if (entry.recoveryCheck) return entry.recoveryCheck;
        entry.recoveryCheck = Promise.resolve(entry.transport.probe?.()).then(healthy => {
          if (entry.closed) return false;
          if (healthy === false) entry.pair.recover?.();
          else if (healthy === true) {
            entry.pair.confirmHealthy?.();
            if (entry.liveState !== 'open') entry.pair.repairLiveChannel?.();
          }
          return healthy === true;
        }).finally(() => { entry.recoveryCheck = null; });
        return entry.recoveryCheck;
      }));
    },
    getConnectionDiagnostics() {
      return Promise.all([...peers.values()].map(entry => entry.pair.getDiagnostics?.() ?? {}));
    },
    getPeerCount() {
      return peers.size;
    },

    sendLive(peerId, type, payload, options = {}) {
      const entry = peers.get(String(peerId ?? '').trim());
      if (!entry?.liveTransport?.send) return 'unavailable';
      return entry.liveTransport.send(type, payload, options);
    },

    relayLive(sourceId, envelope) {
      if (closed || envelope?.clientId !== sourceId || !peers.has(sourceId)) return [];
      const results = [];
      for (const [peerId, entry] of peers) {
        if (peerId === sourceId) continue;
        results.push({ peerId, result: entry.liveTransport?.relay?.(envelope) ?? 'unavailable' });
      }
      return results;
    },

    broadcastLive(type, payload, options = {}) {
      const results = [];
      for (const [peerId, entry] of peers.entries()) {
        results.push({
          peerId,
          result: entry?.liveTransport?.send
            ? entry.liveTransport.send(type, payload, options)
            : 'unavailable',
        });
      }
      return results;
    },

    getLiveState(peerId) {
      return peers.get(String(peerId ?? '').trim())?.liveState ?? 'unavailable';
    },

    getLiveStats(peerId) {
      return peers.get(String(peerId ?? '').trim())?.liveTransport?.stats?.() ?? null;
    },

    getSelectedPath(peerId) {
      return peers.get(String(peerId ?? '').trim())?.selectedPath ?? '';
    },

    closePeer,

    close() {
      if (closed) return;
      closed = true;
      for (const peerId of [...peers.keys()]) closePeer(peerId);
      retiredNegotiations.clear();
    },
  };
}
