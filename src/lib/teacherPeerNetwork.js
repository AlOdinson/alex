import { createDualPathPeerPair } from './dualPathPeerPair.js';
import { createBrowserPeerConnection } from './browserPeerConnection.js';
import { createPeerDataChannelTransport } from './peerDataChannel.js';
import { createPeerLiveChannel } from './peerLiveChannel.js';

const CONNECT_TIMEOUT_MS = 10_000;
const DISCONNECT_GRACE_MS = 3_500;
const OWNER_PREFERENCE_GRACE_MS = 1_500;

export function createTeacherPeerNetwork({
  boardId = '',
  clientId = '',
  getRevision = () => 0,
  signaling,
  peerHub,
  rtcConfig = {},
  connectTimeoutMs = CONNECT_TIMEOUT_MS,
  disconnectGraceMs = DISCONNECT_GRACE_MS,
  ownerPreferenceGraceMs = OWNER_PREFERENCE_GRACE_MS,
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
  let closed = false;

  const closePeer = (peerId, expectedEntry = null) => {
    const id = String(peerId ?? '').trim();
    const entry = peers.get(id);
    if (!entry) return false;
    if (expectedEntry && entry !== expectedEntry) return false;
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
      unregister: null,
      selectedPath: '',
      closed: false,
    };

    const pair = createPair({
      localRole: 'owner',
      peerId: id,
      signaling,
      rtcConfig,
      enableLiveChannel: true,
      connectTimeoutMs,
      disconnectGraceMs,
      ownerPreferenceGraceMs,
      createConnection,
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
      const entry = ensurePeer(peerId);
      Promise.resolve(entry.pair.start()).catch((error) => failPeer(peerId, entry, error));
      return entry.pair.handleSignal(signal);
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
    },
  };
}
