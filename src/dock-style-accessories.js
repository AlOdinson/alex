const PRESETS_KEY = 'alex-board:drawing-presets:v1';
const DRAW_TOOL_LABELS = new Set(['Карандаш', 'Прямая', 'Фигуры']);
const SELECT_TOOL_LABEL = 'Выделение';
const STROKE_WIDTH_STEPS = [1, 2, 3, 4, 5, 8, 10, 15, 20, 25, 50, 100];

let syncFrame = 0;

function activeDockButton() {
  return document.querySelector('.board-tool-dock .dock-tool-button.active');
}

function activeDockLabel() {
  const button = activeDockButton();
  return String(button?.getAttribute('aria-label') || button?.getAttribute('title') || '').trim();
}

function readPresets() {
  try {
    const value = JSON.parse(localStorage.getItem(PRESETS_KEY) ?? '[]');
    return Array.isArray(value) ? value.slice(0, 3) : [];
  } catch {
    return [];
  }
}

function nearestWidthStep(width) {
  const numeric = Number(width);
  let bestIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  STROKE_WIDTH_STEPS.forEach((candidate, index) => {
    const distance = Math.abs(candidate - numeric);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  });
  return bestIndex + 1;
}

function setReactInputValue(input, value) {
  if (!(input instanceof HTMLInputElement)) return false;
  const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  if (!descriptor?.set) return false;
  descriptor.set.call(input, String(value));
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}

function applyPresetToSelection(index) {
  const preset = readPresets()[index];
  if (!preset) return false;
  const root = document.querySelector('.selection-floating-controls');
  if (!root) return false;

  let changed = false;
  const colorInput = root.querySelector('.color-control input[type="color"]');
  if (colorInput && /^#[0-9a-f]{6}$/i.test(String(preset.color ?? ''))) {
    changed = setReactInputValue(colorInput, String(preset.color).toLowerCase()) || changed;
  }

  const ranges = [...root.querySelectorAll('.compact-slider input[type="range"]')];
  const opacityInput = ranges[0] ?? null;
  const widthInput = ranges[1] ?? null;
  const opacity = Number(preset.opacity);
  const width = Number(preset.width);

  if (opacityInput && Number.isFinite(opacity)) {
    changed = setReactInputValue(opacityInput, Math.max(0.05, Math.min(1, opacity))) || changed;
  }
  if (widthInput && Number.isFinite(width)) {
    changed = setReactInputValue(widthInput, nearestWidthStep(width)) || changed;
  }
  return changed;
}

function openPresetEditor(index) {
  const gear = document.querySelector('.drawing-presets-gear');
  if (!(gear instanceof HTMLButtonElement)) return;
  gear.click();
  window.setTimeout(() => {
    const editorButtons = [...document.querySelectorAll('.drawing-preset-editor-button')];
    editorButtons[index]?.click?.();
  }, 0);
}

function syncDockMetrics() {
  const dock = document.querySelector('.board-tool-dock');
  if (!dock) return;
  const rect = dock.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const root = document.documentElement;
  root.style.setProperty('--dock-style-left', `${rect.left}px`);
  root.style.setProperty('--dock-style-right', `${rect.right}px`);
  root.style.setProperty('--dock-style-top', `${rect.top}px`);
  root.style.setProperty('--dock-style-height', `${rect.height}px`);
  root.style.setProperty('--dock-style-accessory-top', `${rect.top + Math.max(0, (rect.height - 42) / 2)}px`);
}

function syncHistoryButtons() {
  const history = document.querySelector('[aria-label="Отмена и возврат"]');
  history?.classList.add('dock-history-accessories');
}

function syncSelectionControls(selectionActive) {
  const selectionRoot = document.querySelector('.selected-style-controls');
  if (!selectionRoot) return;

  if (selectionActive) {
    selectionRoot.classList.add('floating-drawing-controls', 'selection-floating-controls');
    const eyedropper = selectionRoot.querySelector('.eyedropper-button');
    eyedropper?.classList.add('dock-accessory-eyedropper', 'selection-dock-eyedropper');
  } else {
    selectionRoot.classList.remove('floating-drawing-controls', 'selection-floating-controls');
    const eyedropper = selectionRoot.querySelector('.eyedropper-button');
    eyedropper?.classList.remove('dock-accessory-eyedropper', 'selection-dock-eyedropper');
  }
}

function syncDrawingEyedropper(drawingActive) {
  const drawingRoot = [...document.querySelectorAll('.floating-drawing-controls')]
    .find((root) => !root.classList.contains('selection-floating-controls'));
  const eyedropper = drawingRoot?.querySelector('.eyedropper-button') ?? null;
  if (!eyedropper) return;
  eyedropper.classList.toggle('dock-accessory-eyedropper', drawingActive);
  eyedropper.classList.toggle('drawing-dock-eyedropper', drawingActive);
}

function syncPresetButtons(accessoriesVisible, selectionActive) {
  const presets = readPresets();
  const buttons = [...document.querySelectorAll('.drawing-preset-cells .drawing-preset-button')];
  buttons.slice(0, 3).forEach((button, index) => {
    const preset = presets[index] ?? null;
    const width = Number(preset?.width);
    if (Number.isFinite(width)) button.setAttribute('data-preset-width', String(Math.round(width)));
    else button.removeAttribute('data-preset-width');

    button.classList.toggle('dock-selection-preset', selectionActive);
    if (accessoriesVisible) {
      const shouldDisable = !preset;
      if (button.disabled !== shouldDisable) button.disabled = shouldDisable;
    }
  });
}

function syncState() {
  syncFrame = 0;
  syncDockMetrics();
  syncHistoryButtons();

  const label = activeDockLabel();
  const drawingActive = DRAW_TOOL_LABELS.has(label);
  const selectionRoot = document.querySelector('.selected-style-controls');
  const selectionActive = label === SELECT_TOOL_LABEL && Boolean(selectionRoot);
  const accessoriesVisible = drawingActive || selectionActive;

  document.body.classList.toggle('dock-style-drawing-active', drawingActive);
  document.body.classList.toggle('dock-style-selection-active', selectionActive);

  syncSelectionControls(selectionActive);
  syncDrawingEyedropper(drawingActive);
  syncPresetButtons(accessoriesVisible, selectionActive);
}

function scheduleSync() {
  if (syncFrame) return;
  syncFrame = requestAnimationFrame(syncState);
}

function presetIndexFromButton(button) {
  const cells = button?.closest?.('.drawing-preset-cells');
  if (!cells) return -1;
  return [...cells.querySelectorAll('.drawing-preset-button')].indexOf(button);
}

function handlePresetClick(event) {
  const button = event.target?.closest?.('.drawing-preset-button');
  if (!(button instanceof HTMLButtonElement)) return;
  const index = presetIndexFromButton(button);
  if (index < 0 || index > 2) return;

  const preset = readPresets()[index] ?? null;
  if (!preset) {
    event.preventDefault();
    event.stopImmediatePropagation();
    openPresetEditor(index);
    return;
  }

  if (document.body.classList.contains('dock-style-selection-active')) {
    event.preventDefault();
    event.stopImmediatePropagation();
    applyPresetToSelection(index);
    scheduleSync();
  }
}

function handlePresetEditorShortcut(event) {
  const button = event.target?.closest?.('.drawing-preset-button');
  if (!(button instanceof HTMLButtonElement)) return;
  const index = presetIndexFromButton(button);
  if (index < 0 || index > 2) return;
  event.preventDefault();
  event.stopPropagation();
  openPresetEditor(index);
}

if (typeof document !== 'undefined') {
  const observer = new MutationObserver(scheduleSync);
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'disabled', 'title', 'aria-pressed'],
  });

  document.addEventListener('click', handlePresetClick, true);
  document.addEventListener('contextmenu', handlePresetEditorShortcut, true);
  document.addEventListener('dblclick', handlePresetEditorShortcut, true);
  window.addEventListener('storage', scheduleSync);
  window.addEventListener('resize', scheduleSync);
  window.addEventListener('orientationchange', scheduleSync);
  window.addEventListener('scroll', scheduleSync, true);
  window.visualViewport?.addEventListener('resize', scheduleSync);
  window.visualViewport?.addEventListener('scroll', scheduleSync);

  queueMicrotask(scheduleSync);
}
