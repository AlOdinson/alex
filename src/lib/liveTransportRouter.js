export function createLiveTransportRouter({
  enabled = false,
  sendWebRtcLive = () => 'unavailable',
  publishLegacyAbly = async () => 'ok',
  needsLegacyAbly = () => !enabled,
} = {}) {
  let closed = false;
  const counters = {
    total: 0,
    webrtc: 0,
    mixed: 0,
    ablyLegacy: 0,
    unavailable: 0,
    closed: 0,
  };

  return {
    async send(event, payload, options = {}) {
      counters.total += 1;
      if (closed) {
        counters.closed += 1;
        return { route: 'closed', liveResult: 'closed', legacyResult: null };
      }

      if (!enabled) {
        const legacyResult = await publishLegacyAbly(event, payload, options);
        counters.ablyLegacy += 1;
        return { route: 'ably-legacy', liveResult: null, legacyResult };
      }

      const liveResult = await Promise.resolve(sendWebRtcLive(event, payload, options));
      const legacyNeeded = Boolean(needsLegacyAbly(event, payload, options));
      if (legacyNeeded) {
        const legacyResult = await publishLegacyAbly(event, payload, options);
        counters.mixed += 1;
        counters.ablyLegacy += 1;
        return { route: 'webrtc+ably-legacy', liveResult, legacyResult };
      }

      if (liveResult === 'unavailable' || liveResult === 'closed') {
        counters.unavailable += 1;
        return {
          route: 'webrtc-unavailable',
          liveResult,
          legacyResult: null,
        };
      }

      counters.webrtc += 1;
      return {
        route: 'webrtc',
        liveResult,
        legacyResult: null,
      };
    },

    stats() {
      return { ...counters };
    },

    close() {
      closed = true;
    },
  };
}
