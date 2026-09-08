import { computeParallelInsetRadiusCss, computeSurfaceSourceRect } from './refractive-glass-lensing.js';

const DESKTOP_SURFACE_REFRESH_MS = 120;
const DESKTOP_SURFACE_IDLE_MS = 500;
const MAX_DESKTOP_SURFACE_DPR = 2;

const DESKTOP_SURFACE_CONFIGS = [
  { targetSelector: '.board-tool-dock', className: 'refractive-surface-sample--dock', insetCss: 9 },
  { targetSelector: '.dock-history-accessories', className: 'refractive-surface-sample--history', insetCss: 7 },
];

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function isTouchSurfaceDevice() {
  if (typeof window === 'undefined') return false;
  const coarsePointer = window.matchMedia?.('(pointer: coarse)')?.matches === true;
  const anyCoarsePointer = window.matchMedia?.('(any-pointer: coarse)')?.matches === true;
  const touchPoints = typeof navigator !== 'undefined' ? Number(navigator.maxTouchPoints) || 0 : 0;
  return coarsePointer || anyCoarsePointer || touchPoints > 0;
}

function findBoardCanvas() {
  if (typeof document === 'undefined') return null;
  const preferred = document.querySelector('.canvas-host .lower-canvas');
  if (preferred instanceof HTMLCanvasElement && preferred.width && preferred.height) return preferred;
  const fallback = [...document.querySelectorAll('.canvas-host canvas')]
    .find((canvas) => canvas instanceof HTMLCanvasElement && canvas.width && canvas.height);
  return fallback ?? null;
}

function ensureSurfaceCanvas(target, className) {
  let canvas = target.querySelector(`canvas.${className}`);
  if (canvas instanceof HTMLCanvasElement) return canvas;
  canvas = document.createElement('canvas');
  canvas.className = `refractive-surface-sample ${className}`;
  canvas.setAttribute('aria-hidden', 'true');
  canvas.tabIndex = -1;
  target.prepend(canvas);
  return canvas;
}

function resolveOuterRadiusCss(target, targetRect) {
  const fallback = Math.min(targetRect.width, targetRect.height) / 2;
  const parsed = Number.parseFloat(window.getComputedStyle(target).borderTopLeftRadius);
  return Number.isFinite(parsed) ? clamp(parsed, 0, fallback) : fallback;
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

function renderDesktopSurfaceSample(source, target, config) {
  if (!(source instanceof HTMLCanvasElement) || !(target instanceof HTMLElement) || target.hidden) return false;
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
  const sampleDpr = Math.min(MAX_DESKTOP_SURFACE_DPR, Math.max(1, Number(window.devicePixelRatio) || 1));
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

function renderDesktopSurfaces() {
  if (typeof document === 'undefined' || document.hidden || isTouchSurfaceDevice()) return false;
  const source = findBoardCanvas();
  if (!source) return false;
  let rendered = false;
  for (const config of DESKTOP_SURFACE_CONFIGS) {
    const target = document.querySelector(config.targetSelector);
    if (!(target instanceof HTMLElement)) continue;
    rendered = renderDesktopSurfaceSample(source, target, config) || rendered;
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
  const rendered = renderDesktopSurfaces();
  scheduleNext(rendered ? DESKTOP_SURFACE_REFRESH_MS : DESKTOP_SURFACE_IDLE_MS);
}

function requestImmediateRefresh() {
  if (stopped || typeof window === 'undefined') return;
  scheduleNext(0);
}

export function startDesktopGlassSurfaceSampling() {
  if (typeof window === 'undefined' || typeof document === 'undefined' || stopped || isTouchSurfaceDevice()) return;
  window.addEventListener('resize', requestImmediateRefresh, { passive: true });
  window.visualViewport?.addEventListener?.('resize', requestImmediateRefresh, { passive: true });
  window.visualViewport?.addEventListener?.('scroll', requestImmediateRefresh, { passive: true });
  document.addEventListener('visibilitychange', requestImmediateRefresh, { passive: true });
  scheduleNext(0);
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startDesktopGlassSurfaceSampling, { once: true });
  } else {
    startDesktopGlassSurfaceSampling();
  }
}
