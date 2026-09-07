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

function rgbaFromPreset(preset) {
  const color = String(preset?.color ?? '').toLowerCase();
  if (!/^#[0-9a-f]{6}$/.test(color)) return 'transparent';
  const opacity = Math.max(0.05, Math.min(1, Number(preset?.opacity) || 1));
  const red = Number.parseInt(color.slice(1, 3), 16);
  const green = Number.parseInt(color.slice(3, 5), 16);
  const blue = Number.parseInt(color.slice(5, 7), 16);
  return `rgba(${red}, ${green}, ${blue}, ${opacity})`;
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

function createAccessoryButton(className, label, text) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.setAttribute('aria-label', label);
  button.title = label;
  button.textContent = text;
  return button;
}

function ensureAccessoryShells() {
  let history = document.querySelector('.dock-history-accessories');
  if (!history) {
    history = document.createElement('div');
    history.className = 'dock-history-accessories';
    history.setAttribute('aria-label', 'Отмена и возврат у нижнего меню');

    const undo = createAccessoryButton('dock-history-button dock-history-undo', 'Отменить — Ctrl/Command + Z', '↶');
    undo.dataset.dockHistoryAction = 'undo';
    const redo = createAccessoryButton('dock-history-button dock-history-redo', 'Вернуть — Ctrl/Command + Shift + Z', '↷');
    redo.dataset.dockHistoryAction = 'redo';
    history.append(undo, redo);
    document.body.append(history);
  }

  let right = document.querySelector('.dock-style-right-accessories');
  if (!right) {
    right = document.createElement('div');
    right.className = 'dock-style-right-accessories';
    right.setAttribute('aria-label', 'Пипетка и сохранённые параметры рисования');

    const eyedropper = createAccessoryButton(
      'dock-style-eyedropper-button',
      'Пипетка',
      '⌾',
    );
    eyedropper.dataset.dockStyleAction = 'eyedropper';
    right.append(eyedropper);

    for (let index = 0; index < 3; index += 1) {
      const button = createAccessoryButton(
        'dock-style-preset-button',
        `Пресет ${index + 1}`,
        '',
      );
      button.dataset.presetIndex = String(index);
      const fill = document.createElement('span');
      fill.className = 'dock-style-preset-fill';
      fill.setAttribute('aria-hidden', 'true');
      const empty = document.createElement('span');
      empty.className = 'dock-style-preset-empty';
      empty.setAttribute('aria-hidden', 'true');
      empty.textContent = '+';
      button.append(fill, empty);
      right.append(button);
    }
    document.body.append(right);
  }

  return { history, right };
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
  document.body.classList.toggle('dock-style-board-active', Boolean(dock));
  if (!dock) return false;
  const rect = dock.getBoundingClientRect();
  if (!rect.width || !rect.height) return false;
  const blockSize = window.matchMedia?.('(max-width: 760px)')?.matches ? 40 : 42;
  const root = document.documentElement;
  root.style.setProperty('--dock-style-left', `${rect.left}px`);
  root.style.setProperty('--dock-style-right', `${rect.right}px`);
  root.style.setProperty('--dock-style-top', `${rect.top}px`);
  root.style.setProperty('--dock-style-height', `${rect.height}px`);
  root.style.setProperty('--dock-style-accessory-top', `${rect.top + Math.max(0, (rect.height - blockSize) / 2)}px`);
  return true;
}

function historySourceButtons() {
  const source = document.querySelector('[aria-label="Отмена и возврат"]');
  source?.classList.add('dock-history-source');
  return source ? [...source.querySelectorAll('button')].slice(0, 2) : [];
}

function syncHistoryButtons(shell) {
  const sourceButtons = historySourceButtons();
  const proxies = [...shell.querySelectorAll('.dock-history-button')];
  proxies.forEach((proxy, index) => {
    const source = sourceButtons[index] ?? null;
    proxy.disabled = !source || source.disabled;
    if (source?.title) {
      proxy.title = source.title;
      proxy.setAttribute('aria-label', source.title);
    }
  });
}

function syncSelectionControls(selectionActive) {
  const selectionRoot = document.querySelector('.selected-style-controls');
  if (!selectionRoot) return;
  selectionRoot.classList.toggle('floating-drawing-controls', selectionActive);
  selectionRoot.classList.toggle('selection-floating-controls', selectionActive);
}

function currentEyedropperButton(selectionActive) {
  if (selectionActive) {
    return document.querySelector('.selected-style-controls .eyedropper-button');
  }
  return [...document.querySelectorAll('.floating-drawing-controls')]
    .find((root) => !root.classList.contains('selection-floating-controls'))
    ?.querySelector('.eyedropper-button') ?? null;
}

function clickActiveEyedropper() {
  const selectionActive = document.body.classList.contains('dock-style-selection-active');
  const source = currentEyedropperButton(selectionActive);
  if (source instanceof HTMLButtonElement && !source.disabled) source.click();
}

function sourcePresetButton(index) {
  return [...document.querySelectorAll('.drawing-presets-anchor .drawing-preset-button')][index] ?? null;
}

function syncRightAccessories(shell, accessoriesVisible, selectionActive) {
  const presets = readPresets();
  const eyedropperProxy = shell.querySelector('.dock-style-eyedropper-button');
  const eyedropperSource = currentEyedropperButton(selectionActive);
  if (eyedropperProxy instanceof HTMLButtonElement) {
    eyedropperProxy.disabled = !accessoriesVisible || !(eyedropperSource instanceof HTMLButtonElement) || eyedropperSource.disabled;
    eyedropperProxy.classList.toggle('active', Boolean(eyedropperSource?.classList.contains('active')));
  }

  const proxyButtons = [...shell.querySelectorAll('.dock-style-preset-button')];
  proxyButtons.forEach((button, index) => {
    const preset = presets[index] ?? null;
    const source = sourcePresetButton(index);
    const width = Number(preset?.width);
    const fill = button.querySelector('.dock-style-preset-fill');
    const empty = button.querySelector('.dock-style-preset-empty');

    if (fill) fill.style.backgroundColor = rgbaFromPreset(preset);
    if (empty) empty.hidden = Boolean(preset);
    if (Number.isFinite(width)) button.setAttribute('data-preset-width', String(Math.round(width)));
    else button.removeAttribute('data-preset-width');

    button.classList.toggle('empty', !preset);
    button.classList.toggle('active', !selectionActive && Boolean(source?.classList.contains('active')));
    button.disabled = !accessoriesVisible;
    button.title = preset
      ? `Пресет ${index + 1}: ${Math.round((Number(preset.opacity) || 1) * 100)}%, ${Math.round(width)}px`
      : `Пресет ${index + 1} пуст — нажмите для настройки`;
    button.setAttribute('aria-label', button.title);
  });
}

function syncState() {
  syncFrame = 0;
  const { history, right } = ensureAccessoryShells();
  const boardActive = syncDockMetrics();
  syncHistoryButtons(history);

  const label = activeDockLabel();
  const drawingActive = boardActive && DRAW_TOOL_LABELS.has(label);
  const selectionRoot = document.querySelector('.selected-style-controls');
  const selectionActive = boardActive && label === SELECT_TOOL_LABEL && Boolean(selectionRoot);
  const accessoriesVisible = drawingActive || selectionActive;

  document.body.classList.toggle('dock-style-drawing-active', drawingActive);
  document.body.classList.toggle('dock-style-selection-active', selectionActive);

  syncSelectionControls(selectionActive);
  syncRightAccessories(right, accessoriesVisible, selectionActive);
}

function scheduleSync() {
  if (syncFrame) return;
  syncFrame = requestAnimationFrame(syncState);
}

function handleAccessoryClick(event) {
  const historyButton = event.target?.closest?.('.dock-history-button');
  if (historyButton instanceof HTMLButtonElement) {
    const sourceButtons = historySourceButtons();
    const index = historyButton.dataset.dockHistoryAction === 'redo' ? 1 : 0;
    const source = sourceButtons[index];
    if (source instanceof HTMLButtonElement && !source.disabled) source.click();
    return;
  }

  const eyedropper = event.target?.closest?.('.dock-style-eyedropper-button');
  if (eyedropper instanceof HTMLButtonElement) {
    clickActiveEyedropper();
    scheduleSync();
    return;
  }

  const presetButton = event.target?.closest?.('.dock-style-preset-button');
  if (!(presetButton instanceof HTMLButtonElement)) return;
  const index = Number(presetButton.dataset.presetIndex);
  if (!Number.isInteger(index) || index < 0 || index > 2) return;
  const preset = readPresets()[index] ?? null;

  if (!preset) {
    openPresetEditor(index);
    return;
  }
  if (document.body.classList.contains('dock-style-selection-active')) {
    applyPresetToSelection(index);
  } else if (document.body.classList.contains('dock-style-drawing-active')) {
    const source = sourcePresetButton(index);
    if (source instanceof HTMLButtonElement && !source.disabled) source.click();
  }
  scheduleSync();
}

function handlePresetEditorShortcut(event) {
  const button = event.target?.closest?.('.dock-style-preset-button');
  if (!(button instanceof HTMLButtonElement)) return;
  const index = Number(button.dataset.presetIndex);
  if (!Number.isInteger(index) || index < 0 || index > 2) return;
  event.preventDefault();
  event.stopPropagation();
  openPresetEditor(index);
}

if (typeof document !== 'undefined') {
  ensureAccessoryShells();

  const observer = new MutationObserver(scheduleSync);
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'disabled', 'title', 'aria-pressed'],
  });

  document.addEventListener('click', handleAccessoryClick, true);
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
