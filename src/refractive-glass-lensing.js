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
  const thicknessPx = Math.max(1, Math.round(config.thicknessCss * sampleDpr));
  const canvas = ensureContourCanvas(target, config.className);

  if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
  if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
  canvas.style.left = '0px';
  canvas.style.top = '0px';
  canvas.style.width = `${targetRect.width}px`;
  canvas.style.height = `${targetRect.height}px`;

  const context = canvas.getContext('2d', { alpha: true });
  if (!context) return false;
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, pixelWidth, pixelHeight);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';

  const sourceScaleX = source.width / sourceRect.width;
  const sourceScaleY = source.height / sourceRect.height;
  const sourceDepthX = Math.max(1, Math.min(sample.sw, Math.round(config.thicknessCss * 2 * sourceScaleX)));
  const sourceDepthY = Math.max(1, Math.min(sample.sh, Math.round(config.thicknessCss * 2 * sourceScaleY)));

  context.save();
  context.translate(0, thicknessPx);
  context.scale(1, -1);
  context.drawImage(source, sample.sx, sample.sy, sample.sw, sourceDepthY, 0, 0, pixelWidth, thicknessPx);
  context.restore();

  context.save();
  context.translate(0, pixelHeight);
  context.scale(1, -1);
  context.drawImage(
    source,
    sample.sx,
    sample.sy + sample.sh - sourceDepthY,
    sample.sw,
    sourceDepthY,
    0,
    0,
    pixelWidth,
    thicknessPx,
  );
  context.restore();

  context.save();
  context.globalAlpha = 0.92;
  context.translate(thicknessPx, 0);
  context.scale(-1, 1);
  context.drawImage(source, sample.sx, sample.sy, sourceDepthX, sample.sh, 0, 0, thicknessPx, pixelHeight);
  context.restore();

  context.save();
  context.globalAlpha = 0.92;
  context.translate(pixelWidth, 0);
  context.scale(-1, 1);
  context.drawImage(
    source,
    sample.sx + sample.sw - sourceDepthX,
    sample.sy,
    sourceDepthX,
    sample.sh,
    0,
    0,
    thicknessPx,
    pixelHeight,
  );
  context.restore();

  context.save();
  context.globalAlpha = 0.14;
  context.drawImage(
    source,
    sample.sx,
    sample.sy,
    sample.sw,
    sample.sh,
    -thicknessPx * 0.18,
    -thicknessPx * 0.18,
    pixelWidth + thicknessPx * 0.36,
    pixelHeight + thicknessPx * 0.36,
  );
  context.restore();

  const outerRadiusCss = resolveOuterRadiusCss(target, targetRect);
  const outerRadiusPx = outerRadiusCss * sampleDpr;

  context.save();
  context.globalCompositeOperation = 'destination-in';
  context.beginPath();
  traceRoundedRect(context, 0, 0, pixelWidth, pixelHeight, outerRadiusPx);
  context.closePath();
  context.fill();
  context.restore();

  const innerWidth = pixelWidth - thicknessPx * 2;
  const innerHeight = pixelHeight - thicknessPx * 2;
  if (innerWidth > 0 && innerHeight > 0) {
    const innerRadiusCss = computeParallelInsetRadiusCss({
      outerRadiusCss,
      insetCss: config.thicknessCss,
      innerWidthCss: innerWidth / sampleDpr,
      innerHeightCss: innerHeight / sampleDpr,
    });
    const innerRadiusPx = innerRadiusCss * sampleDpr;
    context.save();
    context.globalCompositeOperation = 'destination-out';
    context.beginPath();
    traceRoundedRect(context, thicknessPx, thicknessPx, innerWidth, innerHeight, innerRadiusPx);
    context.closePath();
    context.fill();
    context.restore();
  }

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
