import {
  DOCK_LAYOUT_CHANGE_EVENT,
  contextualDirectionForMode,
  getDockLayoutMode,
} from './dock-layout-controller.js';

const ROOT_SELECTOR = '.floating-drawing-controls';
const ACTIVE_DOCK_SELECTOR = '.board-tool-dock .dock-tool-button.active';
const OPACITY_LABEL_SELECTOR = ':scope > .eyedropper-button + .compact-slider';
const WIDTH_LABEL_SELECTOR = ':scope > .compact-slider + .compact-slider';

function clampPercent(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 100;
  return Math.max(0, Math.min(100, numeric * 100));
}

function syncOpacityVisual(root) {
  const label = root.querySelector(OPACITY_LABEL_SELECTOR);
  const input = label?.querySelector('input[type="range"]');
  if (!input) return;
  root.style.setProperty('--opacity-stop', `${clampPercent(input.value)}%`);
}

function syncPosition(root) {
  const activeButton = document.querySelector(ACTIVE_DOCK_SELECTOR);
  if (!activeButton) return;
  const rect = activeButton.getBoundingClientRect();
  if (!rect.width || !rect.height) return;

  const direction = contextualDirectionForMode(getDockLayoutMode(document));
  root.dataset.contextDirection = direction;

  if (direction === 'below') {
    root.style.setProperty('--drawing-controls-x', `${rect.left + rect.width / 2}px`);
    root.style.setProperty('--drawing-controls-y', `${rect.bottom + 10}px`);
    return;
  }

  if (direction === 'right') {
    root.style.setProperty('--drawing-controls-x', `${rect.right + 10}px`);
    root.style.setProperty('--drawing-controls-y', `${rect.top + rect.height / 2}px`);
    return;
  }

  root.style.setProperty('--drawing-controls-x', `${rect.left + rect.width / 2}px`);
  root.style.setProperty('--drawing-controls-y', `${rect.top - 10}px`);
}

function syncRoot(root) {
  syncOpacityVisual(root);
  syncPosition(root);
}

function syncAll(root = document) {
  const roots = root.querySelectorAll?.(ROOT_SELECTOR) ?? [];
  roots.forEach(syncRoot);
}

function closeScales(root) {
  root?.classList.remove('opacity-open', 'width-open');
}

function sideRangeKind(target) {
  if (!(target instanceof HTMLInputElement) || target.type !== 'range') return null;
  const root = target.closest(ROOT_SELECTOR);
  if (!root) return null;
  const opacityLabel = root.querySelector(OPACITY_LABEL_SELECTOR);
  const widthLabel = root.querySelector(WIDTH_LABEL_SELECTOR);
  if (opacityLabel?.contains(target)) return { root, kind: 'opacity' };
  if (widthLabel?.contains(target)) return { root, kind: 'width' };
  return null;
}

function handlePointerDown(event) {
  const target = event.target;
  const root = target?.closest?.(ROOT_SELECTOR) ?? null;

  if (!root) {
    document.querySelectorAll(ROOT_SELECTOR).forEach(closeScales);
    return;
  }

  if (target?.closest?.('.color-control')) {
    closeScales(root);
    return;
  }

  const rangeInfo = sideRangeKind(target);
  if (!rangeInfo) return;

  const openClass = rangeInfo.kind === 'opacity' ? 'opacity-open' : 'width-open';
  const otherClass = rangeInfo.kind === 'opacity' ? 'width-open' : 'opacity-open';

  if (!rangeInfo.root.classList.contains(openClass)) {
    // First press only reveals the scale. A second press/drag adjusts the value,
    // preventing the collapsed range from jumping to an accidental value.
    event.preventDefault();
    rangeInfo.root.classList.remove(otherClass);
    rangeInfo.root.classList.add(openClass);
    requestAnimationFrame(() => {
      try {
        target.focus({ preventScroll: true });
      } catch {
        target.focus();
      }
    });
  }
}

function handleInput(event) {
  const input = event.target;
  if (!(input instanceof HTMLInputElement) || input.type !== 'range') return;
  const root = input.closest(ROOT_SELECTOR);
  if (root) syncOpacityVisual(root);
}

function handleKeyDown(event) {
  if (event.key !== 'Escape') return;
  document.querySelectorAll(ROOT_SELECTOR).forEach(closeScales);
}

if (typeof document !== 'undefined') {
  const observer = new MutationObserver(() => syncAll(document));
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class'],
  });

  document.addEventListener('pointerdown', handlePointerDown, true);
  document.addEventListener('input', handleInput, true);
  document.addEventListener('change', handleInput, true);
  document.addEventListener('keydown', handleKeyDown, true);

  const resync = () => syncAll(document);
  document.addEventListener(DOCK_LAYOUT_CHANGE_EVENT, resync);
  window.addEventListener('resize', resync);
  window.addEventListener('orientationchange', resync);
  window.addEventListener('scroll', resync, true);
  window.visualViewport?.addEventListener('resize', resync);
  window.visualViewport?.addEventListener('scroll', resync);

  queueMicrotask(() => syncAll(document));
}
