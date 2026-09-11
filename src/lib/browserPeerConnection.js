export const BOARD_DURABLE_DATA_CHANNEL = 'alex-board-durable-v1';

export const DEFAULT_BROWSER_RTC_CONFIG = Object.freeze({
  iceServers: Object.freeze([
    Object.freeze({ urls: Object.freeze(['stun:stun.cloudflare.com:3478']) }),
  ]),
});

function resolveRtcConfig(rtcConfig) {
  const source = rtcConfig && typeof rtcConfig === 'object' ? rtcConfig : {};
  if (Object.prototype.hasOwnProperty.call(source, 'iceServers')) return source;
  return {
    ...source,
    iceServers: DEFAULT_BROWSER_RTC_CONFIG.iceServers.map((server) => ({
      ...server,
      urls: Array.isArray(server.urls) ? [...server.urls] : server.urls,
    })),
  };
}

export function createBrowserPeerConnection({
  initiator = false,
  rtcConfig = {},
  sendSignal,
  onChannel = () => {},
  onConnectionState = () => {},
  onError = () => {},
  createPeerConnection,
} = {}) {
  if (typeof sendSignal !== 'function') throw new Error('sendSignal is required');
  const factory = createPeerConnection ?? ((config) => new RTCPeerConnection(config));
  const peerConnection = factory(resolveRtcConfig(rtcConfig));
  if (!peerConnection) throw new Error('Could not create RTCPeerConnection');

  let dataChannel = null;
  let started = false;
  let closed = false;
  const pendingIce = [];

  const reportError = (error) => {
    try {
      onError(error);
    } catch {
      // Error observers must not break the peer connection lifecycle.
    }
  };

  const publishSignal = (signal) => Promise.resolve(sendSignal(signal)).catch((error) => {
    reportError(error);
    throw error;
  });

  const attachChannel = (channel) => {
    if (!channel || channel.label !== BOARD_DURABLE_DATA_CHANNEL) return false;
    dataChannel = channel;
    if (channel.readyState === 'open') onChannel(channel);
    else channel.onopen = () => {
      if (!closed && dataChannel === channel) onChannel(channel);
    };
    return true;
  };

  const flushPendingIce = async () => {
    if (!peerConnection.remoteDescription) return;
    while (pendingIce.length) {
      const candidate = pendingIce.shift();
      // eslint-disable-next-line no-await-in-loop
      await peerConnection.addIceCandidate(candidate);
    }
  };

  peerConnection.onicecandidate = (event) => {
    if (closed || !event?.candidate) return;
    publishSignal({ type: 'ice', candidate: event.candidate }).catch(() => undefined);
  };

  peerConnection.ondatachannel = (event) => {
    attachChannel(event?.channel);
  };

  peerConnection.onconnectionstatechange = () => {
    onConnectionState(peerConnection.connectionState ?? 'unknown');
  };

  return {
    async start() {
      if (closed) throw new Error('Peer connection is closed');
      if (started) return;
      started = true;
      if (!initiator) return;

      attachChannel(peerConnection.createDataChannel(BOARD_DURABLE_DATA_CHANNEL, {
        ordered: true,
      }));
      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);
      await publishSignal({
        type: 'offer',
        description: peerConnection.localDescription ?? offer,
      });
    },

    async handleSignal(signal) {
      if (closed || !signal || typeof signal !== 'object') return;
      if (signal.type === 'ice') {
        if (!signal.candidate) return;
        if (!peerConnection.remoteDescription) {
          pendingIce.push(signal.candidate);
          return;
        }
        await peerConnection.addIceCandidate(signal.candidate);
        return;
      }

      if (signal.type === 'offer') {
        if (!signal.description) throw new Error('WebRTC offer has no description');
        await peerConnection.setRemoteDescription(signal.description);
        await flushPendingIce();
        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);
        await publishSignal({
          type: 'answer',
          description: peerConnection.localDescription ?? answer,
        });
        return;
      }

      if (signal.type === 'answer') {
        if (!signal.description) throw new Error('WebRTC answer has no description');
        await peerConnection.setRemoteDescription(signal.description);
        await flushPendingIce();
      }
    },

    getDataChannel() {
      return dataChannel;
    },

    getPeerConnection() {
      return peerConnection;
    },

    close() {
      if (closed) return;
      closed = true;
      pendingIce.length = 0;
      try {
        dataChannel?.close?.();
      } catch (error) {
        reportError(error);
      }
      dataChannel = null;
      try {
        peerConnection.close?.();
      } catch (error) {
        reportError(error);
      }
    },
  };
}
