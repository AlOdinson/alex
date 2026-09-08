export const LENS_REFRESH_MS = 120;
const IDLE_REFRESH_MS = 500;
const MAX_CONTOUR_DPR = 2;
const MAX_SURFACE_DPR = 1.5;

const CONTOUR_CONFIGS = [
  {
    targetSelector: '.board-tool-dock',
    className: 'refractive-contour-sample--dock',
    thicknessCss: 9,
  },
  {
    targetSelector: '.dock-history-accessories',
    className: 'refractive-contour-sample--history',
    thicknessCss: 7,
  },
];

const SURFACE_CONFIGS = [
  {
    targetSelector: '.board-tool-dock',
    className: 'refractive-surface-sample--dock',
    insetCss: 9,
  },
  {
    targetSelector: '.dock-history-accessories',
    className: 'refractive-surface-sample--history',
    insetCss: 7,
  },
];

const contourScratchByCanvas = new WeakMap();
const contourMapByCanvas = new WeakMap();

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function computeLensSourceRect({
  sourceRect,
  sourceWidth,
  sourceHeight,
  targetRect,
  insetCss,
  edge,
  lipHeightCss,
  sampleDepthCss,
}) {
  if (!sourceRect || !targetRect || !sourceRect.width || !sourceRect.height) return null;
  if (!sourceWidth || !sourceHeight || !targetRect.width || !targetRect.height) return null;

  const scaleX = sourceWidth / sourceRect.width;
  const scaleY = sourceHeight / sourceRect.height;
  const cssX = targetRect.left + insetCss - sourceRect.left;
  const cssWidth = Math.max(1, targetRect.width - insetCss * 2);
  const cssY = edge === 'bottom'
    ? targetRect.bottom - sampleDepthCss - sourceRect.top
    : targetRect.top - sourceRect.top;

  const rawSx = Math.round(cssX * scaleX);
  const rawSy = Math.round(cssY * scaleY);
  const rawSw = Math.round(cssWidth * scaleX);
  const rawSh = Math.round(Math.max(lipHeightCss, sampleDepthCss) * scaleY);

  const sx = clamp(rawSx, 0, Math.max(0, sourceWidth - 1));
  const sy = clamp(rawSy, 0, Math.max(0, sourceHeight - 1));
  const sw = Math.max(1, Math.min(rawSw, sourceWidth - sx));
  const sh = Math.max(1, Math.min(rawSh, sourceHeight - sy));
  return { sx, sy, sw, sh };
}

export function computeSurfaceSourceRect({
  sourceRect,
  sourceWidth,
  sourceHeight,
  targetRect,
  insetCss = 0,
}) {
  if (!sourceRect || !targetRect || !sourceRect.width || !sourceRect.height) return null;
  if (!sourceWidth || !sourceHeight || !targetRect.width || !targetRect.height) return null;

  const scaleX = sourceWidth / sourceRect.width;
  const scaleY = sourceHeight / sourceRect.height;
  const cssX = targetRect.left + insetCss - sourceRect.left;
  const cssY = targetRect.top + insetCss - sourceRect.top;
  const cssWidth = Math.max(1, targetRect.width - insetCss * 2);
  const cssHeight = Math.max(1, targetRect.height - insetCss * 2);

  const rawSx = Math.round(cssX * scaleX);
  const rawSy = Math.round(cssY * scaleY);
  const rawSw = Math.round(cssWidth * scaleX);
  const rawSh = Math.round(cssHeight * scaleY);

  const sx = clamp(rawSx, 0, Math.max(0, sourceWidth - 1));
  const sy = clamp(rawSy, 0, Math.max(0, sourceHeight - 1));
  const sw = Math.max(1, Math.min(rawSw, sourceWidth - sx));
  const sh = Math.max(1, Math.min(rawSh, sourceHeight - sy));
  return { sx, sy, sw, sh };
}

function findBoardCanvas() {
  if (typeof document === 'undefined') return null;
  const preferred = document.querySelector('.canvas-host .lower-canvas');
  if (preferred instanceof HTMLCanvasElement && preferred.width && preferred.height) return preferred;

  const fallback = [...document.querySelectorAll('.canvas-host canvas')]
    .find((canvas) => canvas instanceof HTMLCanvasElement && canvas.width && canvas.height);
  return fallback ?? null;
}

function isTouchSurfaceDevice() {
  if (typeof window === 'undefined') return false;
  const coarsePointer = window.matchMedia?.('(pointer: coarse)')?.matches === true;
  const anyCoarsePointer = window.matchMedia?.('(any-pointer: coarse)')?.matches === true;
  const touchPoints = typeof navigator !== 'undefined' ? Number(navigator.maxTouchPoints) || 0 : 0;
  return coarsePointer || anyCoarsePointer || touchPoints > 0;
}

function ensureCanvas(target, className, baseClass) {
  let canvas = target.querySelector(`canvas.${className}`);
  if (canvas instanceof HTMLCanvasElement) return canvas;

  canvas = document.createElement('canvas');
  canvas.className = `${baseClass} ${className}`;
  canvas.setAttribute('aria-hidden', 'true');
  canvas.tabIndex = -1;
  target.prepend(canvas);
  return canvas;
}

function ensureContourCanvas(target, className) {
  return ensureCanvas(target, className, 'refractive-contour-sample');
}

function ensureSurfaceCanvas(target, className) {
  return ensureCanvas(target, className, 'refractive-surface-sample');
}

function clearSample(target, className) {
  const canvas = target?.querySelector?.(`canvas.${className}`);
  if (!(canvas instanceof HTMLCanvasElement)) return;
  const context = canvas.getContext('2d');
  context?.clearRect(0, 0, canvas.width, canvas.height);
}

function resolveOuterRadiusCss(target, targetRect) {
  const fallback = Math.min(targetRect.width, targetRect.height) / 2;
  if (typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') return fallback;
  const style = window.getComputedStyle(target);
  const parsed = Number.parseFloat(style.borderTopLeftRadius);
  if (!Number.isFinite(parsed)) return fallback;
  return clamp(parsed, 0, fallback);
}

export function computeParallelInsetRadiusCss({ outerRadiusCss, insetCss, innerWidthCss, innerHeightCss }) {
  if (
    !Number.isFinite(outerRadiusCss)
    || !Number.isFinite(insetCss)
    || !Number.isFinite(innerWidthCss)
    || !Number.isFinite(innerHeightCss)
  ) return 0;
  if (innerWidthCss <= 0 || innerHeightCss <= 0) return 0;

  const parallelRadiusCss = Math.max(0, outerRadiusCss - insetCss);
  return Math.max(0, Math.min(parallelRadiusCss, innerWidthCss / 2, innerHeightCss / 2));
}

function roundedRectSignedDistance(x, y, left, top, width, height, radius) {
  if (width <= 0 || height <= 0) return Number.POSITIVE_INFINITY;
  const safeRadius = clamp(radius, 0, Math.min(width, height) / 2);
  const halfWidth = width / 2;
  const halfHeight = height / 2;
  const centerX = left + halfWidth;
  const centerY = top + halfHeight;
  const qx = Math.abs(x - centerX) - (halfWidth - safeRadius);
  const qy = Math.abs(y - centerY) - (halfHeight - safeRadius);
  const outsideX = Math.max(qx, 0);
  const outsideY = Math.max(qy, 0);
  return Math.hypot(outsideX, outsideY) + Math.min(Math.max(qx, qy), 0) - safeRadius;
}

function projectOutsidePointToRoundedRect(x, y, left, top, width, height, radius) {
  const safeRadius = clamp(radius, 0, Math.min(width, height) / 2);
  const halfWidth = width / 2;
  const halfHeight = height / 2;
  const centerX = left + halfWidth;
  const centerY = top + halfHeight;
  const localX = x - centerX;
  const localY = y - centerY;
  const signX = localX < 0 ? -1 : 1;
  const signY = localY < 0 ? -1 : 1;
  const qx = Math.abs(localX) - (halfWidth - safeRadius);
  const qy = Math.abs(localY) - (halfHeight - safeRadius);
  const outsideX = Math.max(qx, 0);
  const outsideY = Math.max(qy, 0);
  const length = Math.hypot(outsideX, outsideY);

  if (length <= 1e-12) return null;

  const normalX = (outsideX / length) * signX;
  const normalY = (outsideY / length) * signY;
  const distance = Math.max(0, length - safeRadius);
  return { normalX, normalY, distance };
}

// Map one point of the glass lip through a single closed rounded contour.
// The point is reflected across the parallel inner contour along its local normal.
// On straight sections the normal is horizontal/vertical; around a rounded corner
// it rotates continuously with the arc, so there are no four-strip seams.
export function computeContinuousContourSamplePoint({
  x,
  y,
  width,
  height,
  outerRadius,
  thickness,
}) {
  if (![x, y, width, height, outerRadius, thickness].every(Number.isFinite)) return null;
  if (width <= 0 || height <= 0 || thickness <= 0) return null;

  const safeOuterRadius = clamp(outerRadius, 0, Math.min(width, height) / 2);
  if (roundedRectSignedDistance(x, y, 0, 0, width, height, safeOuterRadius) > 0) {
    return { inRing: false };
  }

  const innerWidth = width - thickness * 2;
  const innerHeight = height - thickness * 2;
  if (innerWidth <= 0 || innerHeight <= 0) return { inRing: true, sampleX: x, sampleY: y, normalX: 0, normalY: 0, distance: 0 };

  const innerRadius = computeParallelInsetRadiusCss({
    outerRadiusCss: safeOuterRadius,
    insetCss: thickness,
    innerWidthCss: innerWidth,
    innerHeightCss: innerHeight,
  });
  const innerDistance = roundedRectSignedDistance(
    x,
    y,
    thickness,
    thickness,
    innerWidth,
    innerHeight,
    innerRadius,
  );
  if (innerDistance < 0) return { inRing: false };

  const projection = projectOutsidePointToRoundedRect(
    x,
    y,
    thickness,
    thickness,
    innerWidth,
    innerHeight,
    innerRadius,
  );
  if (!projection) return { inRing: false };

  const { normalX, normalY, distance } = projection;
  const sampleX = clamp(x - normalX * distance * 2, 0, Math.max(0, width - 1e-6));
  const sampleY = clamp(y - normalY * distance * 2, 0, Math.max(0, height - 1e-6));
  return { inRing: true, sampleX, sampleY, normalX, normalY, distance };
}

function traceRoundedRect(context, x, y, width, height, radius) {
  const safeRadius = Math.max(0, Math.min(radius, width / 2, height / 2));
  if (typeof context.roundRect === 'function') {
    context.roundRect(x, y, width, height, safeRadius);
    return;
  }

  context.moveTo(x + safeRadius, y);
  context.lineTo(x + width - safeRadius, y);
  context.quadraticCurveTo(x + width, y, x + width, y + safeRadius);
  context.lineTo(x + width, y + height - safeRadius);
  context.quadraticCurveTo(x + width, y + height, x + width - safeRadius, y + height);
  context.lineTo(x + safeRadius, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - safeRadius);
  context.lineTo(x, y + safeRadius);
  context.quadraticCurveTo(x, y, x + safeRadius, y);
}

function maskRoundedSurface(context, pixelWidth, pixelHeight, innerRadiusPx) {
  context.save();
  context.globalCompositeOperation = 'destination-in';
  context.beginPath();
  traceRoundedRect(context, 0, 0, pixelWidth, pixelHeight, innerRadiusPx);
  context.closePath();
  context.fill();
  context.restore();
}

function ensureContourScratch(canvas, pixelWidth, pixelHeight) {
  let scratch = contourScratchByCanvas.get(canvas);
  if (!(scratch instanceof HTMLCanvasElement)) {
    scratch = document.createElement('canvas');
    contourScratchByCanvas.set(canvas, scratch);
  }
  if (scratch.width !== pixelWidth) scratch.width = pixelWidth;
  if (scratch.height !== pixelHeight) scratch.height = pixelHeight;
  return scratch;
}

function ensureContinuousContourMap(canvas, pixelWidth, pixelHeight, outerRadiusPx, thicknessPx) {
  const key = `${pixelWidth}:${pixelHeight}:${outerRadiusPx.toFixed(3)}:${thicknessPx.toFixed(3)}`;
  const cached = contourMapByCanvas.get(canvas);
  if (cached?.key === key) return cached.map;

  const map = new Int32Array(pixelWidth * pixelHeight);
  map.fill(-1);
  for (let y = 0; y < pixelHeight; y += 1) {
    for (let x = 0; x < pixelWidth; x += 1) {
      const point = computeContinuousContourSamplePoint({
        x: x + 0.5,
        y: y + 0.5,
        width: pixelWidth,
        height: pixelHeight,
        outerRadius: outerRadiusPx,
        thickness: thicknessPx,
      });
      if (!point?.inRing) continue;
      const sampleX = clamp(Math.floor(point.sampleX), 0, pixelWidth - 1);
      const sampleY = clamp(Math.floor(point.sampleY), 0, pixelHeight - 1);
      map[y * pixelWidth + x] = sampleY * pixelWidth + sampleX;
    }
  }
  contourMapByCanvas.set(canvas, { key, map });
  return map;
}

function maskContinuousContour(context, pixelWidth, pixelHeight, outerRadiusPx, thicknessPx) {
  context.save();
  context.globalCompositeOperation = 'destination-in';
  context.beginPath();
  traceRoundedRect(context, 0, 0, pixelWidth, pixelHeight, outerRadiusPx);
  context.closePath();
  context.fill();
  context.restore();

  const innerWidth = pixelWidth - thicknessPx * 2;
  const innerHeight = pixelHeight - thicknessPx * 2;
  if (innerWidth <= 0 || innerHeight <= 0) return;
  const innerRadiusPx = computeParallelInsetRadiusCss({
    outerRadiusCss: outerRadiusPx,
    insetCss: thicknessPx,
    innerWidthCss: innerWidth,
    innerHeightCss: innerHeight,
  });
  context.save();
  context.globalCompositeOperation = 'destination-out';
  context.beginPath();
  traceRoundedRect(context, thicknessPx, thicknessPx, innerWidth, innerHeight, innerRadiusPx);
  context.closePath();
  context.fill();
  context.restore();
}

function renderContourSample(source, target, config) {
  if (!(source instanceof HTMLCanvasElement) || !(target instanceof HTMLElement)) return false;
  if (target.hidden) {
    clearSample(target, config.className);
    return false;
  }

  const sourceRect = source.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  if (!sourceRect.width || !sourceRect.height || !targetRect.width || !targetRect.height) return false;

  const sample = computeSurfaceSourceRect({
    sourceRect,
    sourceWidth: source.width,
    sourceHeight: source.height,
    targetRect,
    insetCss: 0,
  });
  if (!sample) return false;

  const sampleDpr = Math.min(MAX_CONTOUR_DPR, Math.max(1, Number(window.devicePixelRatio) || 1));
  const pixelWidth = Math.max(1, Math.round(targetRect.width * sampleDpr));
  const pixelHeight = Math.max(1, Math.round(targetRect.height * sampleDpr));
  const thicknessPx = Math.max(1, config.thicknessCss * sampleDpr);
  const canvas = ensureContourCanvas(target, config.className);

  if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
  if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
  canvas.style.left = '0px';
  canvas.style.top = '0px';
  canvas.style.width = `${targetRect.width}px`;
  canvas.style.height = `${targetRect.height}px`;

  const context = canvas.getContext('2d', { alpha: true });
  if (!context) return false;
  const scratch = ensureContourScratch(canvas, pixelWidth, pixelHeight);
  const scratchContext = scratch.getContext('2d', { alpha: true, willReadFrequently: true });
  if (!scratchContext) return false;

  scratchContext.setTransform(1, 0, 0, 1, 0, 0);
  scratchContext.clearRect(0, 0, pixelWidth, pixelHeight);
  scratchContext.imageSmoothingEnabled = true;
  scratchContext.imageSmoothingQuality = 'high';
  scratchContext.drawImage(source, sample.sx, sample.sy, sample.sw, sample.sh, 0, 0, pixelWidth, pixelHeight);

  let sampledImage;
  try {
    sampledImage = scratchContext.getImageData(0, 0, pixelWidth, pixelHeight);
  } catch {
    context.clearRect(0, 0, pixelWidth, pixelHeight);
    return false;
  }

  const outerRadiusCss = resolveOuterRadiusCss(target, targetRect);
  const outerRadiusPx = outerRadiusCss * sampleDpr;
  const contourMap = ensureContinuousContourMap(canvas, pixelWidth, pixelHeight, outerRadiusPx, thicknessPx);
  const reflectedImage = context.createImageData(pixelWidth, pixelHeight);
  const sourcePixels = sampledImage.data;
  const reflectedPixels = reflectedImage.data;

  for (let outputIndex = 0; outputIndex < contourMap.length; outputIndex += 1) {
    const sourceIndex = contourMap[outputIndex];
    if (sourceIndex < 0) continue;
    const sourceOffset = sourceIndex * 4;
    const outputOffset = outputIndex * 4;
    reflectedPixels[outputOffset] = sourcePixels[sourceOffset];
    reflectedPixels[outputOffset + 1] = sourcePixels[sourceOffset + 1];
    reflectedPixels[outputOffset + 2] = sourcePixels[sourceOffset + 2];
    reflectedPixels[outputOffset + 3] = sourcePixels[sourceOffset + 3];
  }

  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, pixelWidth, pixelHeight);
  context.putImageData(reflectedImage, 0, 0);
  maskContinuousContour(context, pixelWidth, pixelHeight, outerRadiusPx, thicknessPx);
  return true;
}

function renderSurfaceSample(source, target, config) {
  if (!(source instanceof HTMLCanvasElement) || !(target instanceof HTMLElement)) return false;
  if (target.hidden) {
    clearSample(target, config.className);
    return false;
  }

  const sourceRect = source.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  if (!sourceRect.width || !sourceRect.height || !targetRect.width || !targetRect.height) return false;

  const sample = computeSurfaceSourceRect({
    sourceRect,
    sourceWidth: source.width,
    sourceHeight: source.height,
    targetRect,
    insetCss: config.insetCss,
  });
  if (!sample) return false;

  const cssWidth = Math.max(1, targetRect.width - config.insetCss * 2);
  const cssHeight = Math.max(1, targetRect.height - config.insetCss * 2);
  const sampleDpr = Math.min(MAX_SURFACE_DPR, Math.max(1, Number(window.devicePixelRatio) || 1));
  const pixelWidth = Math.max(1, Math.round(cssWidth * sampleDpr));
  const pixelHeight = Math.max(1, Math.round(cssHeight * sampleDpr));
  const canvas = ensureSurfaceCanvas(target, config.className);
  const outerRadiusCss = resolveOuterRadiusCss(target, targetRect);
  const innerRadiusCss = computeParallelInsetRadiusCss({
    outerRadiusCss,
    insetCss: config.insetCss,
    innerWidthCss: cssWidth,
    innerHeightCss: cssHeight,
  });
  const innerRadiusPx = innerRadiusCss * sampleDpr;

  if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
  if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
  canvas.style.left = `${config.insetCss}px`;
  canvas.style.top = `${config.insetCss}px`;
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${cssHeight}px`;
  canvas.style.borderRadius = `${innerRadiusCss}px`;
  canvas.style.clipPath = `inset(0 round ${innerRadiusCss}px)`;
  canvas.style.webkitClipPath = `inset(0 round ${innerRadiusCss}px)`;

  const context = canvas.getContext('2d', { alpha: true });
  if (!context) return false;
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, pixelWidth, pixelHeight);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(source, sample.sx, sample.sy, sample.sw, sample.sh, 0, 0, pixelWidth, pixelHeight);
  maskRoundedSurface(context, pixelWidth, pixelHeight, innerRadiusPx);
  return true;
}

function renderAllSamples() {
  if (typeof document === 'undefined' || document.hidden) return false;
  const source = findBoardCanvas();
  if (!source) return false;

  let rendered = false;

  if (isTouchSurfaceDevice()) {
    for (const config of SURFACE_CONFIGS) {
      const target = document.querySelector(config.targetSelector);
      if (!(target instanceof HTMLElement)) continue;
      rendered = renderSurfaceSample(source, target, config) || rendered;
    }
  }

  for (const config of CONTOUR_CONFIGS) {
    const target = document.querySelector(config.targetSelector);
    if (!(target instanceof HTMLElement)) continue;
    rendered = renderContourSample(source, target, config) || rendered;
  }
  return rendered;
}

let refreshTimer = 0;
let stopped = false;

function scheduleNext(delay) {
  if (stopped || typeof window === 'undefined') return;
  window.clearTimeout(refreshTimer);
  refreshTimer = window.setTimeout(refreshLoop, delay);
}

function refreshLoop() {
  if (stopped) return;
  const rendered = renderAllSamples();
  scheduleNext(rendered ? LENS_REFRESH_MS : IDLE_REFRESH_MS);
}

function requestImmediateRefresh() {
  if (stopped || typeof window === 'undefined') return;
  scheduleNext(0);
}

export function startRefractiveGlassSampling() {
  if (typeof window === 'undefined' || typeof document === 'undefined' || stopped) return;
  window.addEventListener('resize', requestImmediateRefresh, { passive: true });
  window.addEventListener('orientationchange', requestImmediateRefresh, { passive: true });
  window.visualViewport?.addEventListener?.('resize', requestImmediateRefresh, { passive: true });
  window.visualViewport?.addEventListener?.('scroll', requestImmediateRefresh, { passive: true });
  document.addEventListener('visibilitychange', requestImmediateRefresh, { passive: true });
  scheduleNext(0);
}

export function stopRefractiveGlassSampling() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  stopped = true;
  window.clearTimeout(refreshTimer);
  window.removeEventListener('resize', requestImmediateRefresh);
  window.removeEventListener('orientationchange', requestImmediateRefresh);
  window.visualViewport?.removeEventListener?.('resize', requestImmediateRefresh);
  window.visualViewport?.removeEventListener?.('scroll', requestImmediateRefresh);
  document.removeEventListener('visibilitychange', requestImmediateRefresh);
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startRefractiveGlassSampling, { once: true });
  } else {
    startRefractiveGlassSampling();
  }
}
