// Board live/control traffic is WebRTC-only. Ably is deliberately excluded here:
// it remains the presence/discovery + WebRTC signaling plane, never a board-event fallback.
export function createLiveTransportRouter({
  enabled = false,
  sendWebRtcLive = () => 'unavailable',
} = {}) {
  let closed = false;
  const counters = {
    total: 0,
    webrtc: 0,
    // Retained as zero-valued diagnostics for compatibility with existing tooling.
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
        counters.unavailable += 1;
        return { route: 'webrtc-disabled', liveResult: 'disabled', legacyResult: null };
      }

      const liveResult = await Promise.resolve(sendWebRtcLive(event, payload, options));
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
