export const COLLABORATION_LIVE_CAPABILITIES = Object.freeze({
  webrtcLiveV1: true,
});

export function normalizeCollaborationCapabilities(value) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    webrtcLiveV1: source.webrtcLiveV1 === true,
  };
}

export function resolveCollaborationMode({
  enabled = false,
  localCapabilities = null,
  remoteCapabilities = null,
} = {}) {
  if (!enabled) return 'legacy';
  const local = normalizeCollaborationCapabilities(localCapabilities);
  const remote = normalizeCollaborationCapabilities(remoteCapabilities);
  return local.webrtcLiveV1 && remote.webrtcLiveV1 ? 'webrtc-live-v1' : 'legacy';
}
