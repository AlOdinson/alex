import { FabricImage } from 'fabric';
import { normalizeScreenShareBoardLayout } from './screenShare.js';

const SCREEN_SHARE_SOURCE_WIDTH = 1280;
const SCREEN_SHARE_SOURCE_HEIGHT = 720;
const FALLBACK_FRAME_INTERVAL_MS = 66;

function sourceDimension(value, fallback) {
  const numeric = Math.abs(Number(value));
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

export function isBoardScreenShareObject(object) {
  return Boolean(object?.transientScreenShare);
}

export function applyScreenShareLayoutToFabricObject(object, layout) {
  const normalized = normalizeScreenShareBoardLayout(layout);
  if (!object || !normalized) return false;
  const sourceWidth = sourceDimension(object.width, SCREEN_SHARE_SOURCE_WIDTH);
  const sourceHeight = sourceDimension(object.height, SCREEN_SHARE_SOURCE_HEIGHT);
  object.set?.({
    left: normalized.left + normalized.width / 2,
    top: normalized.top + normalized.height / 2,
    originX: 'center',
    originY: 'center',
    scaleX: normalized.width / sourceWidth,
    scaleY: normalized.height / sourceHeight,
    angle: 0,
    skewX: 0,
    skewY: 0,
    flipX: false,
    flipY: false,
  });
  object.setCoords?.();
  return true;
}

export function screenShareLayoutFromFabricObject(object) {
  if (!object) return null;
  const sourceWidth = sourceDimension(object.width, SCREEN_SHARE_SOURCE_WIDTH);
  const sourceHeight = sourceDimension(object.height, SCREEN_SHARE_SOURCE_HEIGHT);
  const width = sourceWidth * Math.abs(Number(object.scaleX ?? 1) || 1);
  const height = sourceHeight * Math.abs(Number(object.scaleY ?? 1) || 1);
  const centerX = Number(object.left ?? 0);
  const centerY = Number(object.top ?? 0);
  return normalizeScreenShareBoardLayout({
    left: centerX - width / 2,
    top: centerY - height / 2,
    width,
    height,
  });
}

function createPlaceholderCanvas() {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = SCREEN_SHARE_SOURCE_WIDTH;
  canvas.height = SCREEN_SHARE_SOURCE_HEIGHT;
  const context = canvas.getContext?.('2d');
  if (context) {
    context.fillStyle = '#0f172a';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#cbd5e1';
    context.font = '600 34px system-ui, sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText('Демонстрация экрана', canvas.width / 2, canvas.height / 2);
  }
  return canvas;
}

function createVideoElement() {
  if (typeof document === 'undefined') return null;
  const video = document.createElement('video');
  video.autoplay = true;
  video.muted = true;
  video.playsInline = true;
  video.width = SCREEN_SHARE_SOURCE_WIDTH;
  video.height = SCREEN_SHARE_SOURCE_HEIGHT;
  video.setAttribute?.('playsinline', '');
  return video;
}

export function createBoardScreenShareMedia({
  sessionId = '',
  layout = null,
  canEdit = false,
} = {}) {
  const placeholder = createPlaceholderCanvas();
  if (!placeholder) throw new Error('board-screen-share-requires-dom');
  const video = createVideoElement();
  const object = new FabricImage(placeholder, {
    originX: 'center',
    originY: 'center',
    objectKind: 'screen-share',
    transientScreenShare: true,
    screenShareSessionId: String(sessionId ?? ''),
    excludeFromExport: true,
    selectable: Boolean(canEdit),
    evented: Boolean(canEdit),
    hasControls: Boolean(canEdit),
    hasBorders: Boolean(canEdit),
    lockRotation: true,
    lockSkewingX: true,
    lockSkewingY: true,
    lockScalingFlip: true,
    objectCaching: false,
    perPixelTargetFind: false,
  });
  object.setControlsVisibility?.({ mtr: false });
  applyScreenShareLayoutToFabricObject(
    object,
    layout ?? { left: -320, top: -180, width: 640, height: 360 },
  );

  let disposed = false;
  let frameCallbackId = null;
  let frameTimer = null;
  let currentStream = null;

  const requestRender = () => {
    if (disposed) return;
    object.dirty = true;
    object.canvas?.requestRenderAll?.();
  };

  const cancelFrameLoop = () => {
    if (video && frameCallbackId != null && typeof video.cancelVideoFrameCallback === 'function') {
      try { video.cancelVideoFrameCallback(frameCallbackId); } catch { /* Already cancelled. */ }
    }
    frameCallbackId = null;
    if (frameTimer != null) {
      clearInterval(frameTimer);
      frameTimer = null;
    }
  };

  const startFrameLoop = () => {
    cancelFrameLoop();
    if (!video || !currentStream || disposed) return;
    if (typeof video.requestVideoFrameCallback === 'function') {
      const onFrame = () => {
        if (disposed || !currentStream) return;
        requestRender();
        frameCallbackId = video.requestVideoFrameCallback(onFrame);
      };
      frameCallbackId = video.requestVideoFrameCallback(onFrame);
      return;
    }
    frameTimer = setInterval(requestRender, FALLBACK_FRAME_INTERVAL_MS);
  };

  const showVideo = () => {
    if (disposed || !video || !currentStream) return;
    object.setElement?.(video);
    object.dirty = true;
    object.setCoords?.();
    requestRender();
    startFrameLoop();
  };

  const setStream = (stream) => {
    if (disposed || stream === currentStream) return;
    cancelFrameLoop();
    currentStream = stream ?? null;
    if (!video) return;
    video.onloadedmetadata = null;
    video.onplaying = null;
    if (!currentStream) {
      try { video.pause?.(); } catch { /* Ignore media teardown races. */ }
      try { video.srcObject = null; } catch { /* Some test DOMs expose readonly srcObject. */ }
      object.setElement?.(placeholder);
      requestRender();
      return;
    }
    try { video.srcObject = currentStream; } catch { /* Browser will surface playback failure below. */ }
    video.onloadedmetadata = showVideo;
    video.onplaying = showVideo;
    const playResult = video.play?.();
    if (playResult?.catch) playResult.catch(() => undefined);
    if (Number(video.readyState ?? 0) >= 2) showVideo();
  };

  const setInteractive = (editable) => {
    const enabled = Boolean(editable);
    object.set?.({
      selectable: enabled,
      evented: enabled,
      hasControls: enabled,
      hasBorders: enabled,
      lockRotation: true,
      lockSkewingX: true,
      lockSkewingY: true,
      lockScalingFlip: true,
      angle: 0,
      skewX: 0,
      skewY: 0,
      flipX: false,
      flipY: false,
    });
    object.setControlsVisibility?.({ mtr: false });
    object.setCoords?.();
  };

  const setLayout = (nextLayout) => applyScreenShareLayoutToFabricObject(object, nextLayout);
  const getLayout = () => screenShareLayoutFromFabricObject(object);

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    cancelFrameLoop();
    if (video) {
      video.onloadedmetadata = null;
      video.onplaying = null;
      try { video.pause?.(); } catch { /* Ignore teardown races. */ }
      try { video.srcObject = null; } catch { /* Ignore readonly srcObject implementations. */ }
    }
    currentStream = null;
  };

  return {
    object,
    video,
    setStream,
    setLayout,
    getLayout,
    setInteractive,
    dispose,
  };
}
