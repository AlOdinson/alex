import {
  enterNativeFullscreen,
  exitNativeFullscreen,
  getFullscreenElement,
} from './board-fullscreen-controller.js';

const ROOT_ID = 'alex-board-fullscreen-root';
const FALLBACK_CLASS = 'alex-board-immersive-fallback';
const BUTTON_GAP = 8;
const BUTTON_SIZE = 42;
const FULLSCREEN_ICON_VARIANT = 'corner-brackets-1';

let fallbackActive = false;
let busy = false;
let root = null;
let button = null;
let mutationObserver = null;

function brandButton() {
  return document.querySelector('.toolbar-primary-row .brand-button');
}

function isActive() {
  return Boolean(getFullscreenElement(document) || fallbackActive);
}

function fullscreenIcon(active) {
  return active
    ? `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" data-icon-variant="${FULLSCREEN_ICON_VARIANT}">
        <path d="M5 10h5V5M19 10h-5V5M5 14h5v5M19 14h-5v5" />
      </svg>`
    : `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" data-icon-variant="${FULLSCREEN_ICON_VARIANT}">
        <path d="M10 5H5V10M14 5h5v5M10 19H5v-5M14 19h5v-5" />
      </svg>`;
}

function renderButton() {
  if (!button) return;
  const active = isActive();
  const label = active ? 'Выйти из полного экрана' : 'Полный экран';
  button.classList.toggle('is-active', active);
  button.setAttribute('aria-pressed', String(active));
  button.setAttribute('aria-label', label);
  button.title = label;
  button.innerHTML = fullscreenIcon(active);
  button.disabled = busy;
}

function positionButton() {
  if (!root) return;
  const brand = brandButton();
  if (!brand) {
    root.hidden = true;
    return;
  }
  const brandRect = brand.getBoundingClientRect();
  if (!brandRect.width || !brandRect.height) {
    root.hidden = true;
    return;
  }
  root.hidden = false;
  root.style.left = `${Math.round(brandRect.right + BUTTON_GAP)}px`;
  root.style.top = `${Math.round(brandRect.top + (brandRect.height / 2) - (BUTTON_SIZE / 2) + 1)}px`;
}

function setFallback(active) {
  fallbackActive = Boolean(active);
  document.documentElement.classList.toggle(FALLBACK_CLASS, fallbackActive);
  document.body?.classList.toggle(FALLBACK_CLASS, fallbackActive);
  if (fallbackActive) {
    window.scrollTo?.(0, 0);
  }
}

async function toggleFullscreen() {
  if (busy) return;
  busy = true;
  renderButton();
  try {
    if (getFullscreenElement(document)) {
      await exitNativeFullscreen(document);
      setFallback(false);
      return;
    }
    if (fallbackActive) {
      setFallback(false);
      return;
    }

    const entered = await enterNativeFullscreen(document, document.documentElement);
    if (!entered) setFallback(true);
  } finally {
    busy = false;
    renderButton();
    window.requestAnimationFrame?.(positionButton);
  }
}

function createButton() {
  root = document.getElementById(ROOT_ID);
  if (!root) {
    root = document.createElement('div');
    root.id = ROOT_ID;
    document.body.appendChild(root);
  }

  button = root.querySelector('.alex-board-fullscreen-button');
  if (!button) {
    button = document.createElement('button');
    button.type = 'button';
    button.className = 'alex-board-fullscreen-button';
    button.addEventListener('click', toggleFullscreen);
    root.appendChild(button);
  }
  renderButton();
  positionButton();
}

function handleNativeFullscreenChange() {
  if (getFullscreenElement(document)) setFallback(false);
  renderButton();
  window.requestAnimationFrame?.(positionButton);
}

function ensureButton() {
  if (brandButton()) {
    if (!root || !document.body.contains(root)) createButton();
    else positionButton();
  } else if (root) {
    root.hidden = true;
  }
}

for (const eventName of [
  'fullscreenchange',
  'webkitfullscreenchange',
  'mozfullscreenchange',
  'MSFullscreenChange',
]) {
  document.addEventListener(eventName, handleNativeFullscreenChange);
}

document.addEventListener('fullscreenerror', () => {
  if (!getFullscreenElement(document) && !fallbackActive) setFallback(true);
  renderButton();
});

window.addEventListener('resize', positionButton, { passive: true });
window.addEventListener('orientationchange', positionButton, { passive: true });
window.visualViewport?.addEventListener('resize', positionButton, { passive: true });
window.visualViewport?.addEventListener('scroll', positionButton, { passive: true });

mutationObserver = new MutationObserver(ensureButton);
mutationObserver.observe(document.documentElement, { childList: true, subtree: true });

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', ensureButton, { once: true });
} else {
  ensureButton();
}
