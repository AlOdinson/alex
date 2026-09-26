export function createLiveTransportRouter({
  enabled = false,
  sendWebRtcLive = () => 'unavailable',
  publishLegacyAbly = async () => 'ok',
  needsLegacyAbly = () => !enabled,
} = {}) {
  let closed = false;

  return {
    async send(event, payload, options = {}) {
      if (closed) return { route: 'closed', liveResult: 'closed', legacyResult: null };

      if (!enabled) {
        const legacyResult = await publishLegacyAbly(event, payload, options);
        return { route: 'ably-legacy', liveResult: null, legacyResult };
      }

      const liveResult = await Promise.resolve(sendWebRtcLive(event, payload, options));
      const legacyNeeded = Boolean(needsLegacyAbly(event, payload, options));
      if (legacyNeeded) {
        const legacyResult = await publishLegacyAbly(event, payload, options);
        return { route: 'webrtc+ably-legacy', liveResult, legacyResult };
      }

      return {
        route: liveResult === 'unavailable' || liveResult === 'closed'
          ? 'webrtc-unavailable'
          : 'webrtc',
        liveResult,
        legacyResult: null,
      };
    },

    close() {
      closed = true;
    },
  };
}
