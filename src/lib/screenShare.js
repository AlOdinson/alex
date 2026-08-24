export const SCREEN_SHARE_PROTOCOL = 'alex-board-screen-share-v1';
export const MAX_SCREEN_SHARE_VIEWERS = 3;
export const MAX_REMOTE_BROWSER_VIEWERS = 4;
export const REMOTE_BROWSER_DATA_CHANNEL = 'alex-board-remote-browser-v1';
export const REMOTE_BROWSER_AGENT_TTL_MS = 9_000;

export const SCREEN_SHARE_PROFILES = Object.freeze({
  idle: Object.freeze({
    id: 'idle',
    label: 'экономный режим',
    maxFrameRate: 2,
    maxBitrate: 280_000,
  }),
  active: Object.freeze({
    id: 'active',
    label: 'текст и указатель',
    maxFrameRate: 10,
    maxBitrate: 850_000,
  }),
  motion: Object.freeze({
    id: 'motion',
    label: 'прокрутка и движение',
    maxFrameRate: 15,
    maxBitrate: 1_250_000,
  }),
});

const SIGNAL_TYPES = new Set([
  'host-start',
  'host-stop',
  'host-paused',
  'viewer-ready',
  'viewer-leave',
  'viewer-rejected',
  'offer',
  'answer',
  'ice',
  'remote-browser-available',
  'remote-browser-start',
  'remote-browser-stop',
  'remote-browser-unavailable',
]);

export function screenShareCapability(runtimeNavigator = globalThis.navigator) {
  const mediaDevices = runtimeNavigator?.mediaDevices;
  const supported = typeof mediaDevices?.getDisplayMedia === 'function';
  const platform = String(runtimeNavigator?.platform ?? '');
  const userAgent = String(runtimeNavigator?.userAgent ?? '');
  const touchPoints = Number(runtimeNavigator?.maxTouchPoints ?? 0);
  const iosLike = /iPad|iPhone|iPod/i.test(userAgent)
    || (platform === 'MacIntel' && touchPoints > 1);

  return {
    supported,
    iosLike,
    advice: supported
      ? ''
      : (iosLike
        ? 'iPhone и iPad не разрешают веб-странице захватывать другую вкладку. Для показа сайтов запустите Alex Browser Server на Mac.'
        : 'Этот браузер или устройство не поддерживает передачу экрана через веб-страницу.'),
  };
}

export function compareScreenShareSessions(left, right) {
  const leftTime = Number(left?.startedAt ?? Number.MAX_SAFE_INTEGER);
  const rightTime = Number(right?.startedAt ?? Number.MAX_SAFE_INTEGER);
  if (leftTime !== rightTime) return leftTime - rightTime;
  const hostOrder = String(left?.hostId ?? '').localeCompare(String(right?.hostId ?? ''));
  if (hostOrder !== 0) return hostOrder;
  return String(left?.sessionId ?? '').localeCompare(String(right?.sessionId ?? ''));
}

export function preferredScreenShareSession(current, candidate) {
  if (!current) return candidate ?? null;
  if (!candidate) return current;
  return compareScreenShareSessions(current, candidate) <= 0 ? current : candidate;
}

export function screenShareProfileForActivity({
  now,
  lastMotionAt = 0,
  lastInteractionAt = 0,
}) {
  const current = Number(now ?? Date.now());
  if (current - Number(lastMotionAt ?? 0) < 700) return SCREEN_SHARE_PROFILES.motion;
  if (current - Number(lastInteractionAt ?? 0) < 1_600) return SCREEN_SHARE_PROFILES.active;
  return SCREEN_SHARE_PROFILES.idle;
}

export function normalizeScreenShareSignal(payload) {
  if (!payload || payload.protocol !== SCREEN_SHARE_PROTOCOL) return null;
  if (!SIGNAL_TYPES.has(payload.type)) return null;

  const clientId = String(payload.clientId ?? '');
  const sessionId = String(payload.sessionId ?? '');
  if (!clientId || !sessionId) return null;

  return {
    ...payload,
    clientId,
    sessionId,
    targetId: payload.targetId ? String(payload.targetId) : '',
    permission: String(payload.permission ?? 'view'),
    timestamp: Number(payload.timestamp ?? Date.now()),
  };
}

export function normalizeRemoteBrowserState(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const width = Math.max(1, Math.min(3840, Number(payload.width ?? 1280)));
  const height = Math.max(1, Math.min(2160, Number(payload.height ?? 720)));
  return {
    url: String(payload.url ?? ''),
    title: String(payload.title ?? ''),
    loading: Boolean(payload.loading),
    canGoBack: Boolean(payload.canGoBack),
    canGoForward: Boolean(payload.canGoForward),
    controllerId: String(payload.controllerId ?? ''),
    controllerName: String(payload.controllerName ?? ''),
    width,
    height,
    frameRate: Math.max(0, Math.min(30, Number(payload.frameRate ?? 0))),
    quality: Math.max(1, Math.min(100, Number(payload.quality ?? 68))),
  };
}

export function remoteBrowserPointerCoordinates({
  clientX,
  clientY,
  rect,
  viewportWidth = 1280,
  viewportHeight = 720,
}) {
  const boxWidth = Math.max(1, Number(rect?.width ?? 1));
  const boxHeight = Math.max(1, Number(rect?.height ?? 1));
  const sourceWidth = Math.max(1, Number(viewportWidth ?? 1280));
  const sourceHeight = Math.max(1, Number(viewportHeight ?? 720));
  const scale = Math.min(boxWidth / sourceWidth, boxHeight / sourceHeight);
  const renderedWidth = sourceWidth * scale;
  const renderedHeight = sourceHeight * scale;
  const offsetX = Number(rect?.left ?? 0) + (boxWidth - renderedWidth) / 2;
  const offsetY = Number(rect?.top ?? 0) + (boxHeight - renderedHeight) / 2;
  const x = (Number(clientX ?? 0) - offsetX) / scale;
  const y = (Number(clientY ?? 0) - offsetY) / scale;
  return {
    x: Math.max(0, Math.min(sourceWidth, x)),
    y: Math.max(0, Math.min(sourceHeight, y)),
    inside: x >= 0 && y >= 0 && x <= sourceWidth && y <= sourceHeight,
  };
}

export function screenShareNetworkIsDegraded(stats) {
  const loss = Number(stats?.fractionLost ?? 0);
  const roundTripTime = Number(stats?.roundTripTime ?? 0);
  return loss >= 0.08 || roundTripTime >= 0.35;
}

export function rtcConfiguration() {
  const configured = String(import.meta.env?.VITE_SCREEN_SHARE_STUN_URL ?? '').trim();
  return {
    iceServers: [{ urls: configured || 'stun:stun.l.google.com:19302' }],
    bundlePolicy: 'max-bundle',
  };
}
