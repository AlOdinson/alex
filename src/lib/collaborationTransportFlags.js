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


export function isWebrtcLiveV1Enabled({
  environment = import.meta.env ?? {},
  search = globalThis.location?.search ?? '',
} = {}) {
  const envValue = String(environment?.VITE_WEBRTC_LIVE_V1 ?? '').trim().toLowerCase();
  if (envValue === '1' || envValue === 'true') return true;
  const queryValue = new URLSearchParams(String(search ?? '')).get('webrtcLiveV1');
  return queryValue === '1' || String(queryValue ?? '').toLowerCase() === 'true';
}
