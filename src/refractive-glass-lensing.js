export const LENS_REFRESH_MS = 120;
const IDLE_REFRESH_MS = 500;
const MAX_SAMPLE_DPR = 2;

const LENS_CONFIGS = [
  {
    targetSelector: '.board-tool-dock',
    className: 'refractive-lens-sample--dock-top',
    edge: 'top',
    insetCss: 12,
    lipHeightCss: 7,
    sampleDepthCss: 14,
  },
  {
    targetSelector: '.board-tool-dock',
    className: 'refractive-lens-sample--dock-bottom',
    edge: 'bottom',
    insetCss: 16,
    lipHeightCss: 5,
    sampleDepthCss: 12,
  },
  {
    targetSelector: '.dock-history-accessories',
    className: 'refractive-lens-sample--history-top',
    edge: 'top',
    insetCss: 7,
    lipHeightCss: 5,
    sampleDepthCss: 11,
  },
  {
    targetSelector: '.dock-history-accessories',
    className: 'refractive-lens-sample--history-bottom',
    edge: 'bottom',
    insetCss: 9,
    lipHeightCss: 4,
    sampleDepthCss: 9,
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

function findBoardCanvas() {
  if (typeof document === 'undefined') return null;
  const preferred = document.querySelector('.canvas-host .lower-canvas');
  if (preferred instanceof HTMLCanvasElement && preferred.width && preferred.height) return preferred;

  const fallback = [...document.querySelectorAll('.canvas-host canvas')]
    .find((canvas) => canvas instanceof HTMLCanvasElement && canvas.width && canvas.height);
  return fallback ?? null;
}

function ensureSampleCanvas(target, className) {
  let canvas = target.querySelector(`canvas.${className}`);
  if (canvas instanceof HTMLCanvasElement) return canvas;

  canvas = document.createElement('canvas');
  canvas.className = `refractive-lens-sample ${className}`;
  canvas.setAttribute('aria-hidden', 'true');
  canvas.tabIndex = -1;
  target.prepend(canvas);
  return canvas;
}

function clearSample(target, className) {
  const canvas = target?.querySelector?.(`canvas.${className}`);
  if (!(canvas instanceof HTMLCanvasElement)) return;
  const context = canvas.getContext('2d');
  context?.clearRect(0, 0, canvas.width, canvas.height);
}

function renderSample(source, target, config) {
  if (!(source instanceof HTMLCanvasElement) || !(target instanceof HTMLElement)) return false;
  if (target.hidden) {
    clearSample(target, config.className);
    return false;
  }

  const sourceRect = source.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  if (!sourceRect.width || !sourceRect.height || !targetRect.width || !targetRect.height) return false;

  const sample = computeLensSourceRect({
    sourceRect,
    sourceWidth: source.width,
    sourceHeight: source.height,
    targetRect,
    insetCss: config.insetCss,
    edge: config.edge,
    lipHeightCss: config.lipHeightCss,
    sampleDepthCss: config.sampleDepthCss,
  });
  if (!sample) return false;

  const cssWidth = Math.max(1, targetRect.width - config.insetCss * 2);
  const cssHeight = config.lipHeightCss;
  const sampleDpr = Math.min(MAX_SAMPLE_DPR, Math.max(1, Number(window.devicePixelRatio) || 1));
  const pixelWidth = Math.max(1, Math.round(cssWidth * sampleDpr));
  const pixelHeight = Math.max(1, Math.round(cssHeight * sampleDpr));
  const canvas = ensureSampleCanvas(target, config.className);

  if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
  if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
  canvas.style.left = `${config.insetCss}px`;
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${cssHeight}px`;
  canvas.style.top = config.edge === 'top' ? '0px' : 'auto';
  canvas.style.bottom = config.edge === 'bottom' ? '0px' : 'auto';

  const context = canvas.getContext('2d', { alpha: true });
  if (!context) return false;
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, pixelWidth, pixelHeight);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';

  context.save();
  context.translate(0, pixelHeight);
  context.scale(1, -1);
  context.drawImage(
    source,
    sample.sx,
    sample.sy,
    sample.sw,
    sample.sh,
    0,
    0,
    pixelWidth,
    pixelHeight,
  );
  context.restore();

  // A very light second optical pass creates the compressed/reflected edge cue
  // without turning the strip into a duplicated panel.
  context.save();
  context.globalAlpha = 0.18;
  context.translate(0, pixelHeight - Math.max(1, Math.round(sampleDpr)));
  context.scale(1, -1);
  context.drawImage(
    source,
    sample.sx,
    sample.sy,
    sample.sw,
    sample.sh,
    0,
    0,
    pixelWidth,
    pixelHeight,
  );
  context.restore();
  return true;
}

function renderAllSamples() {
  if (typeof document === 'undefined' || document.hidden) return false;
  const source = findBoardCanvas();
  if (!source) return false;

  let rendered = false;
  for (const config of LENS_CONFIGS) {
    const target = document.querySelector(config.targetSelector);
    if (!(target instanceof HTMLElement)) continue;
    rendered = renderSample(source, target, config) || rendered;
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
