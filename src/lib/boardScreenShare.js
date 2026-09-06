import { FabricImage } from 'fabric';
import { normalizeScreenShareBoardLayout } from './screenShare.js';

const SCREEN_SHARE_SOURCE_WIDTH = 1280;
const SCREEN_SHARE_SOURCE_HEIGHT = 720;
const FALLBACK_FRAME_INTERVAL_MS = 66;
const CLOUD_SCREEN_SHARE_STATE_EVENT = 'alex-screen-share-cloud-state';
const CLOUD_SCREEN_SHARE_STATE_REQUEST_EVENT = 'alex-screen-share-cloud-state-request';
const CLOUD_SCREEN_SHARE_TOGGLE_EVENT = 'alex-screen-share-cloud-toggle';
const CLOUD_BUTTON_WIDTH = 88;
const CLOUD_BUTTON_HEIGHT = 24;
const CLOUD_BUTTON_MARGIN = 8;

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

function cloudControlLabel(state) {
  if (state?.cloudPhase === 'connecting' || state?.cloudPhase === 'disconnecting') return 'Cloud …';
  if (state?.cloudPhase === 'error') return 'Cloud ⚠';
  if (state?.transport === 'cloud' && state?.cloudPhase === 'on') return 'Cloud ☑';
  return 'Cloud ☐';
}

function normalizedCloudControlState(detail, sessionId) {
  if (!detail || String(detail.sessionId ?? '') !== String(sessionId ?? '')) return null;
  return {
    visible: Boolean(detail.visible),
    transport: detail.transport === 'cloud' ? 'cloud' : 'p2p',
    cloudPhase: ['off', 'connecting', 'on', 'disconnecting', 'error'].includes(detail.cloudPhase)
      ? detail.cloudPhase
      : 'off',
    cloudError: String(detail.cloudError ?? ''),
  };
}

function viewportPoint(point, viewportTransform) {
  const [a, b, c, d, e, f] = Array.isArray(viewportTransform)
    ? viewportTransform.map(Number)
    : [1, 0, 0, 1, 0, 0];
  const x = Number(point?.x ?? 0);
  const y = Number(point?.y ?? 0);
  return {
    x: a * x + c * y + e,
    y: b * x + d * y + f,
  };
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
  const safeSessionId = String(sessionId ?? '');
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
    screenShareSessionId: safeSessionId,
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
  let cloudState = {
    visible: false,
    transport: 'p2p',
    cloudPhase: 'off',
    cloudError: '',
  };
  let cloudButton = null;
  let cloudCanvas = null;

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

  const positionCloudButton = () => {
    if (disposed || !cloudButton || !cloudState.visible) return;
    const canvas = object.canvas;
    const upperCanvas = canvas?.upperCanvasEl;
    const host = upperCanvas?.parentElement;
    if (!canvas || !upperCanvas || !host) return;

    const coords = object.getCoords?.();
    const topRight = coords?.[1] ?? object.aCoords?.tr;
    if (!topRight) return;
    const viewport = viewportPoint(topRight, canvas.viewportTransform);
    const canvasRect = upperCanvas.getBoundingClientRect?.();
    const hostRect = host.getBoundingClientRect?.();
    if (!canvasRect || !hostRect) return;

    const logicalWidth = Math.max(1, Number(canvas.getWidth?.() ?? canvasRect.width ?? 1));
    const logicalHeight = Math.max(1, Number(canvas.getHeight?.() ?? canvasRect.height ?? 1));
    const cssScaleX = Number(canvasRect.width ?? logicalWidth) / logicalWidth;
    const cssScaleY = Number(canvasRect.height ?? logicalHeight) / logicalHeight;
    const left = Number(canvasRect.left ?? 0) - Number(hostRect.left ?? 0)
      + viewport.x * cssScaleX - CLOUD_BUTTON_WIDTH - CLOUD_BUTTON_MARGIN;
    const top = Number(canvasRect.top ?? 0) - Number(hostRect.top ?? 0)
      + viewport.y * cssScaleY + CLOUD_BUTTON_MARGIN;

    cloudButton.style.left = `${Math.round(left)}px`;
    cloudButton.style.top = `${Math.round(top)}px`;
  };

  const ensureCloudButton = () => {
    if (disposed || typeof document === 'undefined') return null;
    const canvas = object.canvas;
    const upperCanvas = canvas?.upperCanvasEl;
    const host = upperCanvas?.parentElement;
    if (!canvas || !upperCanvas || !host) return null;

    if (!cloudButton) {
      cloudButton = document.createElement('button');
      cloudButton.type = 'button';
      cloudButton.className = 'screen-share-cloud-toggle';
      cloudButton.style.position = 'absolute';
      cloudButton.style.width = `${CLOUD_BUTTON_WIDTH}px`;
      cloudButton.style.height = `${CLOUD_BUTTON_HEIGHT}px`;
      cloudButton.style.padding = '0 8px';
      cloudButton.style.borderRadius = '7px';
      cloudButton.style.border = '1px solid rgba(255,255,255,0.5)';
      cloudButton.style.background = 'rgba(15,23,42,0.88)';
      cloudButton.style.color = '#fff';
      cloudButton.style.font = '600 11px system-ui, sans-serif';
      cloudButton.style.lineHeight = `${CLOUD_BUTTON_HEIGHT}px`;
      cloudButton.style.textAlign = 'center';
      cloudButton.style.whiteSpace = 'nowrap';
      cloudButton.style.boxSizing = 'border-box';
      cloudButton.style.zIndex = '40';
      cloudButton.style.cursor = 'pointer';
      cloudButton.style.userSelect = 'none';
      cloudButton.style.webkitUserSelect = 'none';
      cloudButton.style.touchAction = 'manipulation';
      cloudButton.setAttribute('aria-label', 'Переключить демонстрацию через Cloudflare');
      cloudButton.addEventListener('pointerdown', (event) => event.stopPropagation());
      cloudButton.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (disposed || !cloudState.visible) return;
        if (cloudState.cloudPhase === 'connecting' || cloudState.cloudPhase === 'disconnecting') return;
        const enabled = !(cloudState.transport === 'cloud' && cloudState.cloudPhase === 'on');
        window.dispatchEvent(new CustomEvent(CLOUD_SCREEN_SHARE_TOGGLE_EVENT, {
          detail: { sessionId: safeSessionId, enabled },
        }));
      });
    }
    if (cloudButton.parentElement !== host) host.appendChild(cloudButton);
    return cloudButton;
  };

  const syncCloudButton = () => {
    if (disposed) return;
    if (!cloudState.visible) {
      if (cloudButton) cloudButton.style.display = 'none';
      return;
    }
    const button = ensureCloudButton();
    if (!button) return;
    const busy = cloudState.cloudPhase === 'connecting' || cloudState.cloudPhase === 'disconnecting';
    button.style.display = 'block';
    button.textContent = cloudControlLabel(cloudState);
    button.disabled = busy;
    button.style.opacity = busy ? '0.72' : '1';
    button.style.cursor = busy ? 'wait' : 'pointer';
    button.style.borderColor = cloudState.cloudPhase === 'error'
      ? 'rgba(248,113,113,0.95)'
      : (cloudState.transport === 'cloud' && cloudState.cloudPhase === 'on'
        ? 'rgba(134,239,172,0.95)'
        : 'rgba(255,255,255,0.5)');
    button.title = cloudState.cloudError || (
      cloudState.transport === 'cloud'
        ? 'Выключить Cloudflare relay и снова использовать P2P'
        : 'Передавать демонстрацию через Cloudflare relay'
    );
    button.setAttribute('aria-pressed', cloudState.transport === 'cloud' ? 'true' : 'false');
    button.dataset.cloudPhase = cloudState.cloudPhase;
    positionCloudButton();
  };

  const handleCloudState = (event) => {
    const nextState = normalizedCloudControlState(event?.detail, safeSessionId);
    if (!nextState) return;
    cloudState = nextState;
    syncCloudButton();
  };

  const requestCloudState = () => {
    if (typeof window === 'undefined' || !safeSessionId) return;
    window.dispatchEvent(new CustomEvent(CLOUD_SCREEN_SHARE_STATE_REQUEST_EVENT, {
      detail: { sessionId: safeSessionId },
    }));
  };

  const attachCloudOverlay = () => {
    if (disposed) return;
    const canvas = object.canvas;
    if (!canvas) return;
    if (cloudCanvas !== canvas) {
      cloudCanvas?.off?.('after:render', positionCloudButton);
      cloudCanvas = canvas;
      cloudCanvas.on?.('after:render', positionCloudButton);
    }
    syncCloudButton();
    requestCloudState();
  };

  const detachCloudOverlay = () => {
    cloudCanvas?.off?.('after:render', positionCloudButton);
    cloudCanvas = null;
    cloudButton?.remove();
  };

  if (typeof window !== 'undefined') {
    window.addEventListener(CLOUD_SCREEN_SHARE_STATE_EVENT, handleCloudState);
    window.addEventListener('resize', positionCloudButton, { passive: true });
  }
  object.on?.('added', attachCloudOverlay);
  object.on?.('removed', detachCloudOverlay);

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
    object.off?.('added', attachCloudOverlay);
    object.off?.('removed', detachCloudOverlay);
    if (typeof window !== 'undefined') {
      window.removeEventListener(CLOUD_SCREEN_SHARE_STATE_EVENT, handleCloudState);
      window.removeEventListener('resize', positionCloudButton);
    }
    detachCloudOverlay();
    cloudButton?.remove();
    cloudButton = null;
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
