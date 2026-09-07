const PRESETS_KEY = 'alex-board:drawing-presets:v1';
const STROKE_WIDTH_STEPS = [1, 2, 3, 4, 5, 8, 10, 15, 20, 25, 50, 100];

let syncFrame = 0;
let suppressAccessoryClickUntil = 0;

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

function createAccessoryButton(className, label, text) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.setAttribute('aria-label', label);
  button.title = label;
  button.textContent = text;
  return button;
}

function createProxySlider(kind, min, max, step, initialValue, initialLabel) {
  const label = document.createElement('label');
  label.className = 'compact-slider';
  label.dataset.selectionProxyKind = kind;

  const text = document.createElement('span');
  text.textContent = kind === 'opacity' ? 'Прозр.' : 'Толщ.';

  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(initialValue);
  input.dataset.selectionProxyInput = kind;

  const strong = document.createElement('strong');
  strong.textContent = initialLabel;

  label.append(text, input, strong);
  return label;
}

function ensureSelectionFloatingProxy() {
  let proxy = document.querySelector('.selection-floating-proxy');
  if (proxy) return proxy;

  proxy = document.createElement('div');
  proxy.className = 'tool-group drawing-controls floating-drawing-controls selection-floating-proxy';
  proxy.setAttribute('aria-label', 'Параметры выделения');
  proxy.hidden = true;

  const colorLabel = document.createElement('label');
  colorLabel.className = 'color-control';
  colorLabel.title = 'Цвет выбранного';
  const colorSr = document.createElement('span');
  colorSr.className = 'sr-only';
  colorSr.textContent = 'Цвет выбранного';
  const colorInput = document.createElement('input');
  colorInput.type = 'color';
  colorInput.value = '#111827';
  colorInput.dataset.selectionProxyInput = 'color';
  colorLabel.append(colorSr, colorInput);

  // Structural placeholder: the approved three-dot stylesheet expects the
  // eyedropper between color and opacity. The visible eyedropper lives in the 2x2 block.
  const eyedropperPlaceholder = createAccessoryButton(
    'tool-button eyedropper-button selection-proxy-eyedropper-placeholder',
    'Пипетка',
    '⌾',
  );
  eyedropperPlaceholder.tabIndex = -1;

  const opacityLabel = createProxySlider('opacity', 0.05, 1, 0.05, 1, '100%');
  const widthLabel = createProxySlider('width', 1, STROKE_WIDTH_STEPS.length, 1, 3, '3px');

  proxy.append(colorLabel, eyedropperPlaceholder, opacityLabel, widthLabel);
  document.body.append(proxy);
  return proxy;
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
    right.hidden = true;

    const eyedropper = createAccessoryButton('dock-style-eyedropper-button', 'Пипетка', '⌾');
    eyedropper.dataset.dockStyleAction = 'eyedropper';
    right.append(eyedropper);

    for (let index = 0; index < 3; index += 1) {
      const button = createAccessoryButton('dock-style-preset-button', `Пресет ${index + 1}`, '');
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

  const selectionProxy = ensureSelectionFloatingProxy();
  return { history, right, selectionProxy };
}

function drawingSourceRoot() {
  return document.querySelector('.floating-drawing-controls[aria-label="Параметры рисования"]');
}

function selectionSourceRoot() {
  return document.querySelector('.selected-style-controls');
}

function selectionSourceInputs(root = selectionSourceRoot()) {
  if (!root) return { color: null, opacity: null, width: null };
  const ranges = [...root.querySelectorAll('.compact-slider input[type="range"]')];
  return {
    color: root.querySelector('.color-control input[type="color"]'),
    opacity: ranges[0] ?? null,
    width: ranges[1] ?? null,
  };
}

function applyPresetToSelection(index) {
  const preset = readPresets()[index];
  if (!preset) return false;
  const inputs = selectionSourceInputs();
  let changed = false;

  if (inputs.color && /^#[0-9a-f]{6}$/i.test(String(preset.color ?? ''))) {
    changed = setReactInputValue(inputs.color, String(preset.color).toLowerCase()) || changed;
  }

  const opacity = Number(preset.opacity);
  if (inputs.opacity && Number.isFinite(opacity)) {
    changed = setReactInputValue(inputs.opacity, Math.max(0.05, Math.min(1, opacity))) || changed;
  }

  const width = Number(preset.width);
  if (inputs.width && Number.isFinite(width)) {
    changed = setReactInputValue(inputs.width, nearestWidthStep(width)) || changed;
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

function dispatchHistoryShortcut(redo = false) {
  const event = new KeyboardEvent('keydown', {
    key: 'z',
    code: 'KeyZ',
    metaKey: true,
    ctrlKey: true,
    shiftKey: Boolean(redo),
    bubbles: true,
    cancelable: true,
  });
  window.dispatchEvent(event);
}

function currentEyedropperButton(selectionRoot, drawingRoot) {
  if (selectionRoot) return selectionRoot.querySelector('.eyedropper-button');
  return drawingRoot?.querySelector('.eyedropper-button') ?? null;
}

function sourcePresetButton(index) {
  return [...document.querySelectorAll('.drawing-presets-anchor .drawing-preset-button')][index] ?? null;
}

function syncSelectionFloatingProxy(proxy, source) {
  const visible = Boolean(source);
  if (proxy.hidden === visible) proxy.hidden = !visible;
  if (!visible) return;

  source.classList.add('dock-selection-source');
  const sourceInputs = selectionSourceInputs(source);
  const proxyColor = proxy.querySelector('input[data-selection-proxy-input="color"]');
  const proxyOpacity = proxy.querySelector('input[data-selection-proxy-input="opacity"]');
  const proxyWidth = proxy.querySelector('input[data-selection-proxy-input="width"]');

  if (proxyColor instanceof HTMLInputElement) {
    const nextColor = sourceInputs.color?.value || '#111827';
    if (proxyColor.value !== nextColor) proxyColor.value = nextColor;
    proxyColor.disabled = !(sourceInputs.color instanceof HTMLInputElement) || sourceInputs.color.disabled;
  }

  if (proxyOpacity instanceof HTMLInputElement) {
    const nextOpacity = sourceInputs.opacity?.value ?? '1';
    if (proxyOpacity.value !== String(nextOpacity)) proxyOpacity.value = String(nextOpacity);
    proxyOpacity.disabled = !(sourceInputs.opacity instanceof HTMLInputElement) || sourceInputs.opacity.disabled;
    const label = proxyOpacity.closest('.compact-slider');
    const strong = label?.querySelector('strong');
    const percent = Math.round(Number(proxyOpacity.value || 1) * 100);
    if (strong) strong.textContent = `${percent}%`;
    proxy.style.setProperty('--opacity-stop', `${percent}%`);
  }

  if (proxyWidth instanceof HTMLInputElement) {
    const nextWidthStep = sourceInputs.width?.value ?? '1';
    if (proxyWidth.value !== String(nextWidthStep)) proxyWidth.value = String(nextWidthStep);
    proxyWidth.disabled = !(sourceInputs.width instanceof HTMLInputElement) || sourceInputs.width.disabled;
    const label = proxyWidth.closest('.compact-slider');
    const strong = label?.querySelector('strong');
    const widthIndex = Math.max(0, Math.min(STROKE_WIDTH_STEPS.length - 1, Math.round(Number(proxyWidth.value || 1)) - 1));
    if (strong) strong.textContent = `${STROKE_WIDTH_STEPS[widthIndex]}px`;
  }
}

function syncRightAccessories(shell, accessoriesVisible, selectionRoot, drawingRoot) {
  if (shell.hidden === accessoriesVisible) shell.hidden = !accessoriesVisible;
  if (!accessoriesVisible) return;

  const presets = readPresets();
  const eyedropperProxy = shell.querySelector('.dock-style-eyedropper-button');
  const eyedropperSource = currentEyedropperButton(selectionRoot, drawingRoot);
  if (eyedropperProxy instanceof HTMLButtonElement) {
    const nextDisabled = !(eyedropperSource instanceof HTMLButtonElement) || eyedropperSource.disabled;
    if (eyedropperProxy.disabled !== nextDisabled) eyedropperProxy.disabled = nextDisabled;
    eyedropperProxy.classList.toggle('active', Boolean(eyedropperSource?.classList.contains('active')));
  }

  const proxyButtons = [...shell.querySelectorAll('.dock-style-preset-button')];
  proxyButtons.forEach((button, index) => {
    const preset = presets[index] ?? null;
    const source = sourcePresetButton(index);
    const width = Number(preset?.width);
    const fill = button.querySelector('.dock-style-preset-fill');
    const empty = button.querySelector('.dock-style-preset-empty');

    const nextBackground = rgbaFromPreset(preset);
    if (fill && fill.style.backgroundColor !== nextBackground) fill.style.backgroundColor = nextBackground;
    if (empty) empty.hidden = Boolean(preset);
    if (Number.isFinite(width)) button.setAttribute('data-preset-width', String(Math.round(width)));
    else button.removeAttribute('data-preset-width');

    button.classList.toggle('empty', !preset);
    button.classList.toggle('active', !selectionRoot && Boolean(source?.classList.contains('active')));
    if (button.disabled) button.disabled = false;
    const nextTitle = preset
      ? `Пресет ${index + 1}: ${Math.round((Number(preset.opacity) || 1) * 100)}%, ${Math.round(width)}px`
      : `Пресет ${index + 1} пуст — нажмите для настройки`;
    if (button.title !== nextTitle) {
      button.title = nextTitle;
      button.setAttribute('aria-label', nextTitle);
    }
  });
}

function syncState() {
  syncFrame = 0;
  const { history, right, selectionProxy } = ensureAccessoryShells();
  const boardActive = syncDockMetrics();
  if (history.hidden === boardActive) history.hidden = !boardActive;
  if (!boardActive) {
    right.hidden = true;
    selectionProxy.hidden = true;
    return;
  }

  const drawingRoot = drawingSourceRoot();
  const selectionRoot = selectionSourceRoot();
  const shapeActive = Boolean(document.querySelector('.dock-shape-anchor .dock-tool-button.active'));
  const accessoriesVisible = Boolean(drawingRoot || selectionRoot || shapeActive);

  syncSelectionFloatingProxy(selectionProxy, selectionRoot);
  syncRightAccessories(right, accessoriesVisible, selectionRoot, drawingRoot);
}

function scheduleSync() {
  if (syncFrame) return;
  syncFrame = requestAnimationFrame(syncState);
}

function accessoryTarget(target) {
  return target?.closest?.('.dock-history-button, .dock-style-eyedropper-button, .dock-style-preset-button') ?? null;
}

function activateAccessoryTarget(target) {
  if (!(target instanceof HTMLButtonElement) || target.disabled) return;

  if (target.classList.contains('dock-history-button')) {
    dispatchHistoryShortcut(target.dataset.dockHistoryAction === 'redo');
    return;
  }

  const selectionRoot = selectionSourceRoot();
  const drawingRoot = drawingSourceRoot();

  if (target.classList.contains('dock-style-eyedropper-button')) {
    const source = currentEyedropperButton(selectionRoot, drawingRoot);
    if (source instanceof HTMLButtonElement && !source.disabled) source.click();
    scheduleSync();
    return;
  }

  if (!target.classList.contains('dock-style-preset-button')) return;
  const index = Number(target.dataset.presetIndex);
  if (!Number.isInteger(index) || index < 0 || index > 2) return;
  const preset = readPresets()[index] ?? null;

  if (!preset) {
    openPresetEditor(index);
    return;
  }
  if (selectionRoot) {
    applyPresetToSelection(index);
  } else {
    const source = sourcePresetButton(index);
    if (source instanceof HTMLButtonElement && !source.disabled) source.click();
  }
  scheduleSync();
}

function handleAccessoryClick(event) {
  const target = accessoryTarget(event.target);
  if (!target) return;
  if (performance.now() < suppressAccessoryClickUntil) {
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  activateAccessoryTarget(target);
}

function handleAccessoryTouchEnd(event) {
  const stylus = [...Array.from(event?.changedTouches ?? []), ...Array.from(event?.touches ?? [])]
    .find((touch) => String(touch?.touchType ?? '').toLowerCase() === 'stylus');
  if (!stylus) return;
  const target = accessoryTarget(event.target);
  if (!target) return;
  if (event.cancelable) event.preventDefault();
  event.stopPropagation();
  suppressAccessoryClickUntil = performance.now() + 900;
  activateAccessoryTarget(target);
  target.blur();
}

function handleSelectionProxyInput(event) {
  const input = event.target;
  if (!(input instanceof HTMLInputElement) || !input.closest('.selection-floating-proxy')) return;
  const sourceInputs = selectionSourceInputs();
  const kind = input.dataset.selectionProxyInput;
  const source = kind === 'color'
    ? sourceInputs.color
    : (kind === 'opacity' ? sourceInputs.opacity : (kind === 'width' ? sourceInputs.width : null));
  if (!(source instanceof HTMLInputElement) || source.disabled) return;
  setReactInputValue(source, input.value);
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
    attributeFilter: ['class', 'disabled', 'aria-pressed'],
  });

  document.addEventListener('click', handleAccessoryClick, true);
  document.addEventListener('touchend', handleAccessoryTouchEnd, { passive: false, capture: true });
  document.addEventListener('input', handleSelectionProxyInput, true);
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
