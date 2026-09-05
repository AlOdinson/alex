import { FabricImage } from 'fabric';
import { normalizeScreenShareBoardLayout } from './screenShare.js';

const SCREEN_SHARE_SOURCE_WIDTH = 1280;
const SCREEN_SHARE_SOURCE_HEIGHT = 720;
const FALLBACK_FRAME_INTERVAL_MS = 66;

function sourceDimension(value, fallback) {
  const numeric = Math.abs(Number(value));
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

function setDiagonalResizeControls(object) {
  object?.setControlsVisibility?.({
    mt: false,
    mb: false,
    ml: false,
    mr: false,
    mtr: false,
    tl: true,
    tr: true,
    bl: true,
    br: true,
  });
}

export function isBoardScreenShareObject(object) {
  return Boolean(object?.transientScreenShare);
}

export function applyScreenShareLayoutToFabricObject(object, layout) {
  const normalized = normalizeScreenShareBoardLayout(layout);
  if (!object || !normalized) return false;
  const sourceWidth = sourceDimension(object.width, SCREEN_SHARE_SOURCE_WIDTH);
  const uniformScale = normalized.width / sourceWidth;
  object.set?.({
    left: normalized.left + normalized.width / 2,
    top: normalized.top + normalized.height / 2,
    originX: 'center',
    originY: 'center',
    scaleX: uniformScale,
    scaleY: uniformScale,
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
  const uniformScale = sourceDimension(object.scaleX, 1);
  const width = sourceWidth * uniformScale;
  const height = sourceHeight * uniformScale;
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

function createFrameCanvas() {
  if (typeof document === 'undefined') return null;
  const frameCanvas = document.createElement('canvas');
  frameCanvas.width = SCREEN_SHARE_SOURCE_WIDTH;
  frameCanvas.height = SCREEN_SHARE_SOURCE_HEIGHT;
  return frameCanvas;
}

function createVideoElement() {
  if (typeof document === 'undefined') return null;
  const video = document.createElement('video');
  video.autoplay = true;
  video.muted = true;
  video.playsInline = true;
  video.setAttribute?.('playsinline', '');
  return video;
}

export function createBoardScreenShareMedia({
  sessionId = '',
  layout = null,
  canEdit = false,
} = {}) {
  const placeholder = createPlaceholderCanvas();
  const frameCanvas = createFrameCanvas();
  if (!placeholder || !frameCanvas) throw new Error('board-screen-share-requires-dom');
  const frameContext = frameCanvas.getContext?.('2d');
  frameContext?.drawImage?.(placeholder, 0, 0, frameCanvas.width, frameCanvas.height);
  const video = createVideoElement();
  const object = new FabricImage(frameCanvas, {
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
    cropX: 0,
    cropY: 0,
    objectCaching: false,
    perPixelTargetFind: false,
  });
  object.setElement?.(frameCanvas);
  setDiagonalResizeControls(object);
  applyScreenShareLayoutToFabricObject(
    object,
    layout ?? { left: -320, top: -180, width: 640, height: 360 },
  );

  let disposed = false;
  let frameCallbackId = null;
  let frameTimer = null;
  let currentStream = null;
  let lastUniformScale = sourceDimension(object.scaleX, 1);

  const rememberUniformScale = () => {
    lastUniformScale = sourceDimension(object.scaleX, lastUniformScale || 1);
  };

  const enforceUniformScale = () => {
    if (disposed) return;
    const scaleX = sourceDimension(object.scaleX, lastUniformScale || 1);
    const scaleY = sourceDimension(object.scaleY, lastUniformScale || 1);
    if (Math.abs(scaleX - scaleY) < 1e-6) {
      lastUniformScale = scaleX;
      return;
    }
    const midpoint = (scaleX + scaleY) / 2;
    const growing = midpoint >= lastUniformScale;
    const uniformScale = growing
      ? Math.max(scaleX, scaleY)
      : Math.min(scaleX, scaleY);
    object.set?.({ scaleX: uniformScale, scaleY: uniformScale });
    lastUniformScale = uniformScale;
    object.setCoords?.();
  };
  object.on?.('scaling', enforceUniformScale);

  const requestRender = () => {
    if (disposed) return;
    object.dirty = true;
    object.canvas?.requestRenderAll?.();
  };

  const fitFrameCanvasToVideo = () => {
    if (!video || !frameCanvas || disposed) return false;
    const sourceWidth = sourceDimension(video.videoWidth, 0);
    const sourceHeight = sourceDimension(video.videoHeight, 0);
    if (!sourceWidth || !sourceHeight) return false;
    if (frameCanvas.width === sourceWidth && frameCanvas.height === sourceHeight) return true;

    const previousLayout = screenShareLayoutFromFabricObject(object)
      ?? normalizeScreenShareBoardLayout(layout)
      ?? { left: -320, top: -180, width: 640, height: 360 };
    frameCanvas.width = sourceWidth;
    frameCanvas.height = sourceHeight;
    object.set?.({
      width: sourceWidth,
      height: sourceHeight,
      cropX: 0,
      cropY: 0,
    });
    applyScreenShareLayoutToFabricObject(object, previousLayout);
    rememberUniformScale();
    return true;
  };

  const drawVideoFrame = () => {
    if (disposed || !video || !currentStream || !frameContext) return false;
    if (!fitFrameCanvasToVideo()) return false;
    const sourceWidth = frameCanvas.width;
    const sourceHeight = frameCanvas.height;
    try {
      frameContext.clearRect(0, 0, sourceWidth, sourceHeight);
      frameContext.drawImage(video, 0, 0, sourceWidth, sourceHeight);
    } catch {
      return false;
    }
    object.dirty = true;
    object.setCoords?.();
    requestRender();
    return true;
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
        drawVideoFrame();
        frameCallbackId = video.requestVideoFrameCallback(onFrame);
      };
      frameCallbackId = video.requestVideoFrameCallback(onFrame);
      return;
    }
    frameTimer = setInterval(drawVideoFrame, FALLBACK_FRAME_INTERVAL_MS);
  };

  const showVideo = () => {
    if (disposed || !video || !currentStream) return;
    drawVideoFrame();
    startFrameLoop();
  };

  const showPlaceholder = () => {
    const previousLayout = screenShareLayoutFromFabricObject(object)
      ?? normalizeScreenShareBoardLayout(layout)
      ?? { left: -320, top: -180, width: 640, height: 360 };
    frameCanvas.width = SCREEN_SHARE_SOURCE_WIDTH;
    frameCanvas.height = SCREEN_SHARE_SOURCE_HEIGHT;
    const context = frameCanvas.getContext?.('2d');
    context?.clearRect?.(0, 0, frameCanvas.width, frameCanvas.height);
    context?.drawImage?.(placeholder, 0, 0, frameCanvas.width, frameCanvas.height);
    object.set?.({
      width: SCREEN_SHARE_SOURCE_WIDTH,
      height: SCREEN_SHARE_SOURCE_HEIGHT,
      cropX: 0,
      cropY: 0,
    });
    applyScreenShareLayoutToFabricObject(object, previousLayout);
    rememberUniformScale();
    requestRender();
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
      showPlaceholder();
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
    setDiagonalResizeControls(object);
    object.setCoords?.();
  };

  const setLayout = (nextLayout) => {
    const applied = applyScreenShareLayoutToFabricObject(object, nextLayout);
    if (applied) rememberUniformScale();
    return applied;
  };
  const getLayout = () => screenShareLayoutFromFabricObject(object);

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    object.off?.('scaling', enforceUniformScale);
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
    frameCanvas,
    setStream,
    setLayout,
    getLayout,
    setInteractive,
    dispose,
  };
}
