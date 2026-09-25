import { signalingNegotiationId } from './peerSignalingAssistance.js';
import { createBrowserPeerConnection } from './browserPeerConnection.js';
import { createPeerDataChannelTransport } from './peerDataChannel.js';

const TERMINAL_STATES = new Set(['failed', 'closed', 'disconnected']);

export function createTeacherPeerNetwork({
  signaling,
  peerHub,
  rtcConfig = {},
  createConnection = createBrowserPeerConnection,
  createTransport = createPeerDataChannelTransport,
  onPeerState = () => {},
  onError = () => {},
} = {}) {
  if (!signaling?.send) throw new Error('signaling bridge is required');
  if (!peerHub?.addPeer || !peerHub?.removePeer || !peerHub?.handleMessage) {
    throw new Error('teacher peer hub is required');
  }

  const peers = new Map();
  // Bounded tombstones for signaling attempts, not board data. Retransmission of
  // a retired offer must never replace the current connection for a stable peer.
  const retiredOffers = new Set();
  const offerKey = (peerId, fingerprint) => JSON.stringify([peerId, fingerprint]);
  let closed = false;

  const closePeer = (peerId, expectedEntry = null) => {
    const id = String(peerId ?? '');
    const entry = peers.get(id);
    if (!entry) return false;
    // Connection-state callbacks can arrive after a reconnect has already replaced
    // the entry for the same stable peer id. A stale callback must never tear down
    // that newer connection.
    if (expectedEntry && entry !== expectedEntry) return false;
    peers.delete(id);
    if (entry.offerFingerprint) {
      if (retiredOffers.size >= 128) retiredOffers.delete(retiredOffers.values().next().value);
      retiredOffers.add(offerKey(id, entry.offerFingerprint));
    }
    try { entry.transport?.close?.(); } catch (error) { onError(error); }
    try { entry.unregister?.(); } catch (error) { onError(error); }
    try { peerHub.removePeer(id); } catch (error) { onError(error); }
    try { entry.connection?.close?.(); } catch (error) { onError(error); }
    return true;
  };

  const failPeer = (peerId, entry, error) => {
    if (peers.get(peerId) !== entry) return;
    try { onError(error); } catch { /* observer errors are ignored */ }
    try { onPeerState(peerId, 'failed'); } catch { /* observer errors are ignored */ }
    closePeer(peerId, entry);
  };

  const attachTransport = (peerId, channel, expectedEntry) => {
    const entry = peers.get(peerId);
    if (!entry || entry !== expectedEntry) {
      try { channel?.close?.(); } catch { /* stale channel is already retired */ }
      return null;
    }
    if (entry.transport) return entry.transport;
    let transport;
    transport = createTransport({
      channel,
      onMessage: (message) => Promise.resolve().then(() => {
        if (peers.get(peerId) !== entry || entry.transport !== transport) return;
        return peerHub.handleMessage(peerId, message);
      })
        .catch((error) => failPeer(peerId, entry, error)),
      onTransfer: () => {},
      onClose: () => {
        if (peers.get(peerId) !== entry || entry.transport !== transport) return;
        try { onPeerState(peerId, 'failed'); } catch { /* observer errors are ignored */ }
        closePeer(peerId, entry);
      },
      onError: (error) => failPeer(peerId, entry, error),
    });
    entry.transport = transport;
    entry.unregister = peerHub.addPeer(peerId, transport);
    return transport;
  };

  const ensurePeer = (peerId) => {
    const id = String(peerId ?? '').trim();
    if (!id) throw new Error('peerId is required');
    const existing = peers.get(id);
    if (existing) return existing;

    const entry = {
      connection: null,
      transport: null,
      unregister: null,
      offerFingerprint: null,
      negotiationId: '',
    };
    const connection = createConnection({
      initiator: false,
      assistSignaling: true,
      rtcConfig,
      sendSignal: (signal) => signaling.send(id, signal),
      onChannel: (channel) => attachTransport(id, channel, entry),
      onConnectionState: (state) => {
        if (peers.get(id) !== entry) return;
        onPeerState(id, state);
        if (TERMINAL_STATES.has(String(state))) closePeer(id, entry);
      },
      onError,
    });
    entry.connection = connection;
    peers.set(id, entry);
    Promise.resolve(connection.start?.()).catch(onError);
    return entry;
  };

  return {
    async handleSignal(message) {
      if (closed) return false;
      const peerId = String(message?.sourceId ?? '').trim();
      if (!peerId || !message?.signal) return false;
      const fingerprint = message.signal.type === 'offer' ? JSON.stringify(message.signal) : null;
      const previous = peers.get(peerId);
      const negotiationId = signalingNegotiationId(message.signal);
      if (fingerprint && retiredOffers.has(offerKey(peerId, fingerprint))) return false;
      if (!fingerprint && negotiationId && previous?.negotiationId
        && negotiationId !== previous.negotiationId) return false;
      // A student may time out/retry before the remote browser declares its old
      // connection failed. Do not renegotiate the obsolete SCTP association.
      if (fingerprint && previous && (
        (previous.offerFingerprint && previous.offerFingerprint !== fingerprint)
        || (previous.negotiationId && negotiationId && previous.negotiationId !== negotiationId)
      )) {
        closePeer(peerId, previous);
      }
      const entry = ensurePeer(peerId);
      if (fingerprint && entry.offerFingerprint === fingerprint) {
        // Receipt by Ably is not receipt by this browser. Re-send the cached
        // answer/candidates; never setRemoteDescription or recreate SCTP here.
        entry.connection.resendSignaling?.();
        return true;
      }
      if (negotiationId && !entry.negotiationId) entry.negotiationId = negotiationId;
      if (fingerprint) entry.offerFingerprint = fingerprint;
      try {
        await entry.connection.handleSignal(message.signal);
      } catch (error) {
        failPeer(peerId, entry, error);
        throw error;
      }
      return true;
    },

    getPeerCount() {
      return peers.size;
    },

    closePeer,

    close() {
      if (closed) return;
      closed = true;
      [...peers.keys()].forEach((peerId) => closePeer(peerId));
      retiredOffers.clear();
    },
  };
}
