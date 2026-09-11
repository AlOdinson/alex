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
    try { entry.transport?.close?.(); } catch (error) { onError(error); }
    try { entry.unregister?.(); } catch (error) { onError(error); }
    try { peerHub.removePeer(id); } catch (error) { onError(error); }
    try { entry.connection?.close?.(); } catch (error) { onError(error); }
    return true;
  };

  const attachTransport = (peerId, channel) => {
    const entry = peers.get(peerId);
    if (!entry || entry.transport) return entry?.transport ?? null;
    let transport;
    transport = createTransport({
      channel,
      onMessage: (message) => Promise.resolve(peerHub.handleMessage(peerId, message)).catch(onError),
      onTransfer: () => {},
      onClose: () => {
        if (peers.get(peerId) !== entry || entry.transport !== transport) return;
        try { onPeerState(peerId, 'failed'); } catch { /* observer errors are ignored */ }
        closePeer(peerId, entry);
      },
      onError,
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
    };
    const connection = createConnection({
      initiator: false,
      rtcConfig,
      sendSignal: (signal) => signaling.send(id, signal),
      onChannel: (channel) => attachTransport(id, channel),
      onConnectionState: (state) => {
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
      const entry = ensurePeer(peerId);
      await entry.connection.handleSignal(message.signal);
      return true;
    },

    getPeerCount() {
      return peers.size;
    },

    closePeer,

    close() {
      if (closed) return;
      closed = true;
      [...peers.keys()].forEach(closePeer);
    },
  };
}
