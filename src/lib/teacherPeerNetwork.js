import { signalingNegotiationId } from './peerSignalingAssistance.js';
import { createBrowserPeerConnection } from './browserPeerConnection.js';
import { createPeerDataChannelTransport } from './peerDataChannel.js';
import { createPeerLiveChannel } from './peerLiveChannel.js';

const TERMINAL_STATES = new Set(['failed', 'closed']);
const DISCONNECT_GRACE_MS = 3_500;
const OWNER_INITIATOR_FALLBACK_MS = 4_000;

export function createTeacherPeerNetwork({
  boardId = '',
  clientId = '',
  getRevision = () => 0,
  signaling,
  peerHub,
  rtcConfig = {},
  disconnectGraceMs = DISCONNECT_GRACE_MS,
  ownerInitiatorFallbackMs = OWNER_INITIATOR_FALLBACK_MS,
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
  const retiredOffers = new Set();
  const observedPeers = new Set();
  const fallbackTimers = new Map();
  const offerKey = (peerId, fingerprint) => JSON.stringify([peerId, fingerprint]);
  let closed = false;

  const cancelOwnerFallback = (peerId) => {
    const id = String(peerId ?? '').trim();
    const timer = fallbackTimers.get(id);
    if (timer) clearTimeout(timer);
    fallbackTimers.delete(id);
  };

  const clearDisconnectTimer = (entry) => {
    if (!entry?.disconnectTimer) return;
    clearTimeout(entry.disconnectTimer);
    entry.disconnectTimer = null;
  };

  const closePeer = (peerId, expectedEntry = null, { retireOffer = true } = {}) => {
    const id = String(peerId ?? '');
    const entry = peers.get(id);
    if (!entry) return false;
    if (expectedEntry && entry !== expectedEntry) return false;
    peers.delete(id);
    cancelOwnerFallback(id);
    clearDisconnectTimer(entry);
    if (retireOffer && entry.offerFingerprint) {
      if (retiredOffers.size >= 128) retiredOffers.delete(retiredOffers.values().next().value);
      retiredOffers.add(offerKey(id, entry.offerFingerprint));
    }
    try { entry.liveTransport?.close?.(); } catch (error) { onError(error); }
    try { entry.transport?.close?.(); } catch (error) { onError(error); }
    try { entry.unregister?.(); } catch (error) { onError(error); }
    try { peerHub.removePeer(id); } catch (error) { onError(error); }
    try { entry.connection?.close?.(); } catch (error) { onError(error); }
    return true;
  };

  const attachTransport = (peerId, channel, expectedEntry) => {
    const entry = peers.get(peerId);
    if (!entry || entry !== expectedEntry) {
      try { channel?.close?.(); } catch { /* stale channel is already retired */ }
      return null;
    }
    if (entry.transport) return entry.transport;
    cancelOwnerFallback(peerId);
    clearDisconnectTimer(entry);
    let transport;
    transport = createTransport({
      channel,
      onMessage: (message) => Promise.resolve().then(() => {
        if (peers.get(peerId) !== entry || entry.transport !== transport) return;
        return peerHub.handleMessage(peerId, message);
      }).catch((error) => {
        try { onError(error); } catch { /* observer errors are ignored */ }
        try { onPeerState(peerId, 'failed'); } catch { /* observer errors are ignored */ }
        closePeer(peerId, entry);
      }),
      onTransfer: () => {},
      onClose: () => {
        if (peers.get(peerId) !== entry || entry.transport !== transport) return;
        try { onPeerState(peerId, 'failed'); } catch { /* observer errors are ignored */ }
        closePeer(peerId, entry);
      },
      onError: (error) => {
        if (peers.get(peerId) !== entry) return;
        try { onError(error); } catch { /* observer errors are ignored */ }
        try { onPeerState(peerId, 'failed'); } catch { /* observer errors are ignored */ }
        closePeer(peerId, entry);
      },
    });
    entry.transport = transport;
    entry.unregister = peerHub.addPeer(peerId, transport);
    return transport;
  };

  const attachLiveTransport = (peerId, channel, expectedEntry) => {
    const entry = peers.get(peerId);
    if (!entry || entry !== expectedEntry) {
      try { channel?.close?.(); } catch { /* stale channel is already retired */ }
      return null;
    }
    if (entry.liveTransport) return entry.liveTransport;
    const liveTransport = createLiveTransport({
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
        if (peers.get(peerId) !== entry) return;
        entry.liveState = String(state ?? 'unknown');
        try { onLiveState(peerId, entry.liveState); } catch (error) { onError(error); }
      },
      onError: (error) => {
        if (peers.get(peerId) !== entry) return;
        try { onError(error); } catch { /* observer errors are ignored */ }
      },
    });
    entry.liveTransport = liveTransport;
    if (entry.liveState === 'idle') entry.liveState = channel?.readyState === 'open' ? 'open' : 'connecting';
    return liveTransport;
  };

  function ensurePeer(peerId, { initiator = false } = {}) {
    const id = String(peerId ?? '').trim();
    if (!id) throw new Error('peerId is required');
    const existing = peers.get(id);
    if (existing) return existing;

    const entry = {
      connection: null,
      transport: null,
      liveTransport: null,
      liveState: 'idle',
      unregister: null,
      offerFingerprint: null,
      negotiationId: '',
      initiator: Boolean(initiator),
      disconnectTimer: null,
    };
    const connection = createConnection({
      initiator: entry.initiator,
      enableLiveChannel: entry.initiator,
      assistSignaling: true,
      rtcConfig,
      sendSignal: (signal) => signaling.send(id, signal),
      onChannel: (channel) => attachTransport(id, channel, entry),
      onLiveChannel: (channel) => attachLiveTransport(id, channel, entry),
      onConnectionState: (state) => {
        if (peers.get(id) !== entry) return;
        const normalized = String(state ?? 'unknown');
        try { onPeerState(id, normalized); } catch { /* observer errors are ignored */ }

        if (normalized === 'disconnected') {
          if (!entry.disconnectTimer) {
            entry.disconnectTimer = setTimeout(() => {
              entry.disconnectTimer = null;
              if (peers.get(id) !== entry) return;
              if (!entry.transport && !entry.initiator) {
                promotePeerToInitiator(id, entry);
                return;
              }
              try { onPeerState(id, 'failed'); } catch { /* observer errors are ignored */ }
              closePeer(id, entry, { retireOffer: Boolean(entry.transport) });
            }, Math.max(1, Number(disconnectGraceMs) || DISCONNECT_GRACE_MS));
            entry.disconnectTimer?.unref?.();
          }
          return;
        }

        clearDisconnectTimer(entry);

        if (normalized === 'failed' && !entry.transport && !entry.initiator) {
          promotePeerToInitiator(id, entry);
          return;
        }

        if (TERMINAL_STATES.has(normalized)) {
          closePeer(id, entry, { retireOffer: Boolean(entry.transport) });
        }
      },
      onError,
    });
    entry.connection = connection;
    peers.set(id, entry);
    Promise.resolve(connection.start?.()).catch((error) => {
      if (peers.get(id) !== entry) return;
      try { onError(error); } catch { /* observer errors are ignored */ }
      if (!entry.transport && !entry.initiator) {
        promotePeerToInitiator(id, entry);
        return;
      }
      try { onPeerState(id, 'failed'); } catch { /* observer errors are ignored */ }
      closePeer(id, entry, { retireOffer: Boolean(entry.transport) });
    });
    return entry;
  }

  function promotePeerToInitiator(peerId, expectedEntry = null) {
    const id = String(peerId ?? '').trim();
    if (!id || closed) return false;
    const entry = peers.get(id);
    if (expectedEntry && entry !== expectedEntry) return false;
    cancelOwnerFallback(id);
    if (entry?.transport) return false;
    if (entry?.initiator) {
      entry.connection.resendSignaling?.();
      return true;
    }
    if (entry) closePeer(id, entry, { retireOffer: false });
    observedPeers.add(id);
    ensurePeer(id, { initiator: true });
    return true;
  }

  const scheduleOwnerFallback = (peerId) => {
    const id = String(peerId ?? '').trim();
    if (!id || closed || !observedPeers.has(id) || fallbackTimers.has(id)) return false;
    const entry = peers.get(id);
    if (entry?.transport || entry?.initiator) return false;
    const timer = setTimeout(() => {
      fallbackTimers.delete(id);
      if (closed || !observedPeers.has(id)) return;
      const current = peers.get(id);
      if (current?.transport || current?.initiator) return;
      promotePeerToInitiator(id, current ?? null);
    }, Math.max(1, Number(ownerInitiatorFallbackMs) || OWNER_INITIATOR_FALLBACK_MS));
    timer?.unref?.();
    fallbackTimers.set(id, timer);
    return true;
  };

  const failPeer = (peerId, entry, error) => {
    if (peers.get(peerId) !== entry) return;
    try { onError(error); } catch { /* observer errors are ignored */ }
    try { onPeerState(peerId, 'failed'); } catch { /* observer errors are ignored */ }
    if (!entry.transport && !entry.initiator) {
      promotePeerToInitiator(peerId, entry);
      return;
    }
    closePeer(peerId, entry, { retireOffer: Boolean(entry.transport) });
  };

  return {
    updateParticipants(peerIds = []) {
      const next = new Set((Array.isArray(peerIds) ? peerIds : [])
        .map((value) => String(value ?? '').trim())
        .filter((value) => value && value !== String(clientId ?? '').trim()));

      for (const id of observedPeers) {
        if (!next.has(id)) cancelOwnerFallback(id);
      }
      observedPeers.clear();
      for (const id of next) {
        observedPeers.add(id);
        scheduleOwnerFallback(id);
      }
      return observedPeers.size;
    },

    async handleSignal(message) {
      if (closed) return false;
      const peerId = String(message?.sourceId ?? '').trim();
      const signal = message?.signal;
      if (!peerId || !signal) return false;

      observedPeers.add(peerId);

      const previous = peers.get(peerId);
      if (signal.type === 'role-switch') {
        promotePeerToInitiator(peerId, previous ?? null);
        return true;
      }

      if (previous?.initiator) {
        if (signal.type === 'offer') {
          previous.connection.resendSignaling?.();
          return true;
        }
        try {
          await previous.connection.handleSignal(signal);
        } catch (error) {
          failPeer(peerId, previous, error);
          throw error;
        }
        return true;
      }

      const fingerprint = signal.type === 'offer' ? JSON.stringify(signal) : null;
      const negotiationId = signalingNegotiationId(signal);
      if (fingerprint && retiredOffers.has(offerKey(peerId, fingerprint))) return false;
      if (!fingerprint && negotiationId && previous?.negotiationId
        && negotiationId !== previous.negotiationId) return false;

      if (fingerprint && previous && (
        (previous.offerFingerprint && previous.offerFingerprint !== fingerprint)
        || (previous.negotiationId && negotiationId && previous.negotiationId !== negotiationId)
      )) {
        closePeer(peerId, previous);
      }

      const entry = ensurePeer(peerId, { initiator: false });
      scheduleOwnerFallback(peerId);

      if (fingerprint && entry.offerFingerprint === fingerprint) {
        entry.connection.resendSignaling?.();
        return true;
      }
      if (negotiationId && !entry.negotiationId) entry.negotiationId = negotiationId;
      if (fingerprint) entry.offerFingerprint = fingerprint;
      try {
        await entry.connection.handleSignal(signal);
      } catch (error) {
        failPeer(peerId, entry, error);
        throw error;
      }
      return true;
    },

    getPeerCount() {
      return peers.size;
    },

    sendLive(peerId, type, payload, options = {}) {
      const entry = peers.get(String(peerId ?? '').trim());
      if (!entry?.liveTransport?.send) return 'unavailable';
      return entry.liveTransport.send(type, payload, options);
    },

    broadcastLive(type, payload, options = {}) {
      const results = [];
      for (const [peerId, entry] of peers.entries()) {
        if (!entry?.liveTransport?.send) {
          results.push({ peerId, result: 'unavailable' });
          continue;
        }
        results.push({ peerId, result: entry.liveTransport.send(type, payload, options) });
      }
      return results;
    },

    getLiveState(peerId) {
      return peers.get(String(peerId ?? '').trim())?.liveState ?? 'unavailable';
    },

    getLiveStats(peerId) {
      return peers.get(String(peerId ?? '').trim())?.liveTransport?.stats?.() ?? null;
    },

    closePeer,

    close() {
      if (closed) return;
      closed = true;
      for (const timer of fallbackTimers.values()) clearTimeout(timer);
      fallbackTimers.clear();
      observedPeers.clear();
      [...peers.keys()].forEach((peerId) => closePeer(peerId));
      retiredOffers.clear();
    },
  };
}
