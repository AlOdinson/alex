import {
  DOCK_LAYOUT_CHANGE_EVENT,
  advanceDockLayoutMode,
  getDockLayoutMode,
} from './dock-layout-controller.js';

const BUTTON_CLASS = 'dock-layout-mode-button';
const BUTTON_ACTION = 'cycle';
let syncFrame = 0;
let suppressClickUntil = 0;

function currentDock() {
  return document.querySelector('.board-tool-dock');
}

function ensureLayoutButton() {
  let button = document.querySelector(`.${BUTTON_CLASS}`);
  if (button instanceof HTMLButtonElement) return button;

  button = document.createElement('button');
  button.type = 'button';
  button.className = BUTTON_CLASS;
  button.setAttribute('data-dock-layout-action', BUTTON_ACTION);
  button.setAttribute('aria-label', 'Изменить положение панели инструментов');
  button.title = 'Изменить положение панели инструментов';
  button.textContent = getDockLayoutMode(document);
  document.body.append(button);
  return button;
}

function syncDockMetrics() {
  const button = ensureLayoutButton();
  const dock = currentDock();
  if (!dock) {
    button.hidden = true;
    return false;
  }

  const rect = dock.getBoundingClientRect();
  if (!rect.width || !rect.height) {
    button.hidden = true;
    return false;
  }

  const root = document.documentElement;
  root.style.setProperty('--dock-style-left', `${rect.left}px`);
  root.style.setProperty('--dock-style-right', `${rect.right}px`);
  root.style.setProperty('--dock-style-top', `${rect.top}px`);
  root.style.setProperty('--dock-style-bottom', `${rect.bottom}px`);
  root.style.setProperty('--dock-style-width', `${rect.width}px`);
  root.style.setProperty('--dock-style-height', `${rect.height}px`);
  root.style.setProperty('--dock-style-center-x', `${rect.left + rect.width / 2}px`);
  root.style.setProperty('--dock-style-center-y', `${rect.top + rect.height / 2}px`);
  root.style.setProperty('--dock-style-accessory-top', `${rect.top + Math.max(0, (rect.height - 56) / 2)}px`);

  button.hidden = false;
  const mode = getDockLayoutMode(document);
  button.textContent = mode;
  button.setAttribute('aria-label', `Положение панели ${mode}. Переключить`);
  return true;
}

function scheduleSync() {
  if (syncFrame) return;
  syncFrame = requestAnimationFrame(() => {
    syncFrame = 0;
    syncDockMetrics();
  });
}

function cycleLayout() {
  advanceDockLayoutMode();
  scheduleSync();
}

function handleClick(event) {
  const button = event.target?.closest?.(`.${BUTTON_CLASS}`);
  if (!(button instanceof HTMLButtonElement)) return;
  if (performance.now() < suppressClickUntil) {
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  cycleLayout();
  button.blur();
}

function handleTouchEnd(event) {
  const button = event.target?.closest?.(`.${BUTTON_CLASS}`);
  if (!(button instanceof HTMLButtonElement)) return;
  const stylus = [...Array.from(event?.changedTouches ?? []), ...Array.from(event?.touches ?? [])]
    .find((touch) => String(touch?.touchType ?? '').toLowerCase() === 'stylus');
  if (!stylus) return;
  if (event.cancelable) event.preventDefault();
  event.stopPropagation();
  suppressClickUntil = performance.now() + 900;
  cycleLayout();
  button.blur();
}

if (typeof document !== 'undefined') {
  ensureLayoutButton();
  const observer = new MutationObserver(scheduleSync);
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class'],
  });
  document.addEventListener(DOCK_LAYOUT_CHANGE_EVENT, scheduleSync);
  document.addEventListener('click', handleClick, true);
  document.addEventListener('touchend', handleTouchEnd, { passive: false, capture: true });
  window.addEventListener('resize', scheduleSync);
  window.addEventListener('orientationchange', scheduleSync);
  window.addEventListener('scroll', scheduleSync, true);
  window.visualViewport?.addEventListener('resize', scheduleSync);
  window.visualViewport?.addEventListener('scroll', scheduleSync);
  queueMicrotask(scheduleSync);
}
