const COLOR_INPUT_SELECTOR = '.floating-drawing-controls > .color-control input[type="color"]';
const DRAWING_ROOT_SELECTOR = '.floating-drawing-controls';
const CUSTOM_COLORS_KEY = 'alex-board:ipad-custom-colors:v2';
const EDGE_GAP = 10;
const PALETTE_WIDTH = 390;
const PALETTE_GAP = 14;
const GRID_COLUMNS = 12;
const GRID_ROWS = 10;

const HUE_COLUMNS = [190, 212, 238, 268, 300, 334, 0, 22, 38, 52, 72, 104];
const QUICK_COLORS = ['#000000', '#0a68f5', '#24c25a', '#ffc400', '#ff3b30'];

let activeInput = null;
let activeRoot = null;
let palette = null;
let palettePanel = null;
let activeMode = 'grid';
let currentColor = '#0a68f5';
let customColors = loadCustomColors();
let openAbove = true;

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function normalizeHex(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(raw)) return raw;
  if (/^#[0-9a-f]{3}$/.test(raw)) {
    return `#${raw[1]}${raw[1]}${raw[2]}${raw[2]}${raw[3]}${raw[3]}`;
  }
  return '#0a68f5';
}

function hexToRgb(hex) {
  const safe = normalizeHex(hex);
  return {
    r: Number.parseInt(safe.slice(1, 3), 16),
    g: Number.parseInt(safe.slice(3, 5), 16),
    b: Number.parseInt(safe.slice(5, 7), 16),
  };
}

function rgbToHex(r, g, b) {
  const channel = (value) => clamp(Math.round(Number(value) || 0), 0, 255)
    .toString(16)
    .padStart(2, '0');
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}

function hslToHex(hue, saturation, lightness) {
  const h = ((Number(hue) % 360) + 360) % 360;
  const s = clamp(Number(saturation) / 100, 0, 1);
  const l = clamp(Number(lightness) / 100, 0, 1);
  const chroma = (1 - Math.abs(2 * l - 1)) * s;
  const section = h / 60;
  const x = chroma * (1 - Math.abs((section % 2) - 1));
  let red = 0;
  let green = 0;
  let blue = 0;
  if (section < 1) [red, green, blue] = [chroma, x, 0];
  else if (section < 2) [red, green, blue] = [x, chroma, 0];
  else if (section < 3) [red, green, blue] = [0, chroma, x];
  else if (section < 4) [red, green, blue] = [0, x, chroma];
  else if (section < 5) [red, green, blue] = [x, 0, chroma];
  else [red, green, blue] = [chroma, 0, x];
  const match = l - chroma / 2;
  return rgbToHex((red + match) * 255, (green + match) * 255, (blue + match) * 255);
}

function rgbToHsl(hex) {
  const { r, g, b } = hexToRgb(hex);
  const red = r / 255;
  const green = g / 255;
  const blue = b / 255;
  const maximum = Math.max(red, green, blue);
  const minimum = Math.min(red, green, blue);
  const delta = maximum - minimum;
  let hue = 0;
  if (delta) {
    if (maximum === red) hue = 60 * (((green - blue) / delta) % 6);
    else if (maximum === green) hue = 60 * (((blue - red) / delta) + 2);
    else hue = 60 * (((red - green) / delta) + 4);
  }
  if (hue < 0) hue += 360;
  const lightness = (maximum + minimum) / 2;
  const saturation = delta === 0 ? 0 : delta / (1 - Math.abs(2 * lightness - 1));
  return { hue, saturation: saturation * 100, lightness: lightness * 100 };
}

function buildSystemGridColors() {
  const colors = [];
  for (let column = 0; column < GRID_COLUMNS; column += 1) {
    const lightness = 98 - (96 * column) / (GRID_COLUMNS - 1);
    colors.push(hslToHex(0, 0, lightness));
  }
  for (let row = 1; row < GRID_ROWS; row += 1) {
    const progress = (row - 1) / (GRID_ROWS - 2);
    const lightness = 17 + progress * 76;
    const saturation = 94 - progress * 24;
    HUE_COLUMNS.forEach((hue) => colors.push(hslToHex(hue, saturation, lightness)));
  }
  return colors;
}

const SYSTEM_GRID_COLORS = buildSystemGridColors();

function loadCustomColors() {
  try {
    const stored = JSON.parse(localStorage.getItem(CUSTOM_COLORS_KEY) ?? '[]');
    if (!Array.isArray(stored)) return [];
    return stored.map(normalizeHex).filter((value, index, all) => all.indexOf(value) === index).slice(0, 5);
  } catch {
    return [];
  }
}

function saveCurrentAsCustom() {
  const normalized = normalizeHex(currentColor);
  customColors = [normalized, ...customColors.filter((item) => item !== normalized)].slice(0, 5);
  try {
    localStorage.setItem(CUSTOM_COLORS_KEY, JSON.stringify(customColors));
  } catch {
    // Safari private mode may block storage; the current session still works.
  }
  renderFooterQuickColors();
}

function setControlledInputValue(input, value) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (setter) setter.call(input, value);
  else input.value = value;
}

function dispatchColor(color) {
  if (!activeInput) return;
  currentColor = normalizeHex(color);
  setControlledInputValue(activeInput, currentColor);
  activeInput.dispatchEvent(new Event('input', { bubbles: true }));
  activeInput.dispatchEvent(new Event('change', { bubbles: true }));
  syncPaletteChrome();
}

function syncPaletteChrome() {
  if (!palette) return;
  const preview = palette.querySelector('.ipad-system-preview');
  if (preview) preview.style.backgroundColor = currentColor;
  palette.querySelectorAll('[data-color]').forEach((button) => {
    button.classList.toggle('selected', normalizeHex(button.dataset.color) === currentColor);
  });
  syncSpectrumIndicator();
  syncSliderValues();
}

function positionPalette() {
  if (!palette || !activeInput) return;
  const anchor = activeInput.closest('.color-control') ?? activeInput;
  const rect = anchor.getBoundingClientRect();
  const viewport = window.visualViewport;
  const viewportWidth = Number(viewport?.width ?? window.innerWidth);
  const viewportHeight = Number(viewport?.height ?? window.innerHeight);
  const offsetLeft = Number(viewport?.offsetLeft ?? 0);
  const offsetTop = Number(viewport?.offsetTop ?? 0);
  const width = Math.min(PALETTE_WIDTH, Math.max(300, viewportWidth - EDGE_GAP * 2));
  const center = rect.left + offsetLeft + rect.width / 2;
  const left = clamp(center - width / 2, offsetLeft + EDGE_GAP, offsetLeft + viewportWidth - width - EDGE_GAP);
  const availableAbove = rect.top - EDGE_GAP;
  const availableBelow = viewportHeight - rect.bottom - EDGE_GAP;
  openAbove = availableAbove >= 470 || availableAbove >= availableBelow;
  const top = openAbove ? rect.top + offsetTop - PALETTE_GAP : rect.bottom + offsetTop + PALETTE_GAP;

  palette.style.left = `${left}px`;
  palette.style.top = `${top}px`;
  palette.style.width = `${width}px`;
  palette.style.maxHeight = `${Math.max(300, viewportHeight - EDGE_GAP * 2)}px`;
  palette.style.transform = openAbove ? 'translateY(-100%)' : 'none';
  palette.classList.toggle('open-above', openAbove);
  palette.classList.toggle('open-below', !openAbove);
}

function makeGridCell(color) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'ipad-system-grid-cell';
  button.dataset.color = normalizeHex(color);
  button.style.backgroundColor = normalizeHex(color);
  button.title = normalizeHex(color).toUpperCase();
  button.setAttribute('aria-label', `Цвет ${normalizeHex(color).toUpperCase()}`);
  button.addEventListener('click', () => dispatchColor(color));
  return button;
}

function makeQuickColor(color, custom = false) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `ipad-system-quick-color${custom ? ' custom' : ''}`;
  button.dataset.color = normalizeHex(color);
  button.style.backgroundColor = normalizeHex(color);
  button.title = normalizeHex(color).toUpperCase();
  button.setAttribute('aria-label', `Быстрый цвет ${normalizeHex(color).toUpperCase()}`);
  button.addEventListener('click', () => dispatchColor(color));
  return button;
}

function renderGrid() {
  if (!palettePanel) return;
  const grid = document.createElement('div');
  grid.className = 'ipad-system-grid';
  SYSTEM_GRID_COLORS.forEach((color) => grid.append(makeGridCell(color)));
  palettePanel.replaceChildren(grid);
  syncPaletteChrome();
}

function spectrumColorFromPointer(surface, event) {
  const rect = surface.getBoundingClientRect();
  const x = clamp((event.clientX - rect.left) / Math.max(1, rect.width), 0, 1);
  const y = clamp((event.clientY - rect.top) / Math.max(1, rect.height), 0, 1);
  dispatchColor(hslToHex(x * 360, 100, 96 - y * 92));
}

function syncSpectrumIndicator() {
  const surface = palette?.querySelector('.ipad-system-spectrum');
  const indicator = palette?.querySelector('.ipad-system-spectrum-indicator');
  if (!surface || !indicator) return;
  const { hue, lightness } = rgbToHsl(currentColor);
  indicator.style.left = `${clamp(hue / 360, 0, 1) * 100}%`;
  indicator.style.top = `${clamp((96 - lightness) / 92, 0, 1) * 100}%`;
  indicator.style.backgroundColor = currentColor;
}

function renderSpectrum() {
  if (!palettePanel) return;
  const surface = document.createElement('div');
  surface.className = 'ipad-system-spectrum';
  surface.setAttribute('role', 'slider');
  surface.setAttribute('aria-label', 'Спектр цвета');
  surface.tabIndex = 0;
  const indicator = document.createElement('span');
  indicator.className = 'ipad-system-spectrum-indicator';
  surface.append(indicator);

  surface.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    spectrumColorFromPointer(surface, event);
    try { surface.setPointerCapture(event.pointerId); } catch { /* no-op */ }
  });
  surface.addEventListener('pointermove', (event) => {
    if (surface.hasPointerCapture?.(event.pointerId)) spectrumColorFromPointer(surface, event);
  });
  const finish = (event) => {
    if (!surface.hasPointerCapture?.(event.pointerId)) return;
    spectrumColorFromPointer(surface, event);
    try { surface.releasePointerCapture(event.pointerId); } catch { /* no-op */ }
  };
  surface.addEventListener('pointerup', finish);
  surface.addEventListener('pointercancel', finish);
  palettePanel.replaceChildren(surface);
  syncSpectrumIndicator();
}

function syncSliderValues() {
  if (!palette || activeMode !== 'sliders') return;
  const rgb = hexToRgb(currentColor);
  ['r', 'g', 'b'].forEach((channel) => {
    const range = palette.querySelector(`input[data-channel="${channel}"]`);
    const output = palette.querySelector(`[data-output="${channel}"]`);
    if (range) range.value = String(rgb[channel]);
    if (output) output.textContent = String(rgb[channel]);
  });
  const hexInput = palette.querySelector('.ipad-system-hex-input');
  if (hexInput && document.activeElement !== hexInput) hexInput.value = currentColor.toUpperCase();
}

function renderSliders() {
  if (!palettePanel) return;
  const wrapper = document.createElement('div');
  wrapper.className = 'ipad-system-sliders';
  const rgb = hexToRgb(currentColor);
  [['r', 'Красный'], ['g', 'Зелёный'], ['b', 'Синий']].forEach(([channel, labelText]) => {
    const row = document.createElement('label');
    row.className = `ipad-system-slider-row channel-${channel}`;
    const label = document.createElement('span');
    label.textContent = labelText;
    const range = document.createElement('input');
    range.type = 'range';
    range.min = '0';
    range.max = '255';
    range.step = '1';
    range.value = String(rgb[channel]);
    range.dataset.channel = channel;
    const output = document.createElement('strong');
    output.dataset.output = channel;
    output.textContent = String(rgb[channel]);
    range.addEventListener('input', () => {
      const next = hexToRgb(currentColor);
      next[channel] = Number(range.value);
      dispatchColor(rgbToHex(next.r, next.g, next.b));
    });
    row.append(label, range, output);
    wrapper.append(row);
  });

  const hexRow = document.createElement('label');
  hexRow.className = 'ipad-system-hex-row';
  const hexLabel = document.createElement('span');
  hexLabel.textContent = 'HEX';
  const hexInput = document.createElement('input');
  hexInput.type = 'text';
  hexInput.className = 'ipad-system-hex-input';
  hexInput.value = currentColor.toUpperCase();
  hexInput.maxLength = 7;
  hexInput.spellcheck = false;
  hexInput.addEventListener('input', () => {
    if (/^#[0-9a-fA-F]{6}$/.test(hexInput.value)) dispatchColor(hexInput.value);
  });
  hexRow.append(hexLabel, hexInput);
  wrapper.append(hexRow);
  palettePanel.replaceChildren(wrapper);
  syncSliderValues();
}

function renderPanel() {
  if (activeMode === 'spectrum') renderSpectrum();
  else if (activeMode === 'sliders') renderSliders();
  else renderGrid();
}

function setMode(mode) {
  activeMode = mode;
  palette?.querySelectorAll('.ipad-system-tabs button').forEach((button) => {
    const active = button.dataset.mode === mode;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  renderPanel();
}

function renderFooterQuickColors() {
  const row = palette?.querySelector('.ipad-system-quick-colors');
  if (!row) return;
  row.replaceChildren();
  QUICK_COLORS.forEach((color) => row.append(makeQuickColor(color)));
  customColors.forEach((color) => row.append(makeQuickColor(color, true)));
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'ipad-add-color';
  add.textContent = '+';
  add.title = 'Добавить текущий цвет';
  add.setAttribute('aria-label', 'Добавить текущий цвет');
  add.addEventListener('click', saveCurrentAsCustom);
  row.append(add);
  syncPaletteChrome();
}

function buildPalette() {
  const shell = document.createElement('div');
  shell.className = 'ipad-system-color-palette';
  shell.setAttribute('role', 'dialog');
  shell.setAttribute('aria-label', 'Цвета');

  const header = document.createElement('div');
  header.className = 'ipad-system-header';
  const eyedropper = document.createElement('button');
  eyedropper.type = 'button';
  eyedropper.className = 'ipad-system-eyedropper';
  eyedropper.title = 'Пипетка';
  eyedropper.setAttribute('aria-label', 'Пипетка');
  eyedropper.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14.7 5.3a2.8 2.8 0 1 1 4 4l-2 2-1.6-1.6-6.5 6.5-.5 3.5-3.6.5.5-3.6 6.5-6.5-1.6-1.6 2-2Z"/><path d="m13.6 6.4 4 4"/></svg>';
  eyedropper.addEventListener('click', () => {
    activeRoot?.querySelector(':scope > .eyedropper-button')?.click();
    closePalette();
  });
  const title = document.createElement('strong');
  title.textContent = 'Цвета';
  const headerSpacer = document.createElement('span');
  headerSpacer.className = 'ipad-system-header-spacer';
  header.append(eyedropper, title, headerSpacer);

  const tabs = document.createElement('div');
  tabs.className = 'ipad-system-tabs';
  tabs.setAttribute('role', 'tablist');
  [['grid', 'Сетка'], ['spectrum', 'Спектр'], ['sliders', 'Бегунки']].forEach(([mode, label]) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.mode = mode;
    button.textContent = label;
    button.setAttribute('role', 'tab');
    button.addEventListener('click', () => setMode(mode));
    tabs.append(button);
  });

  palettePanel = document.createElement('div');
  palettePanel.className = 'ipad-system-panel';

  const footer = document.createElement('div');
  footer.className = 'ipad-system-footer';
  const preview = document.createElement('div');
  preview.className = 'ipad-system-preview';
  preview.setAttribute('aria-label', 'Текущий цвет');
  const quick = document.createElement('div');
  quick.className = 'ipad-system-quick-colors';
  footer.append(preview, quick);

  shell.append(header, tabs, palettePanel, footer);
  return shell;
}

function openPalette(input) {
  if (!input) return;
  if (palette && activeInput === input) {
    closePalette();
    return;
  }
  closePalette();
  activeInput = input;
  activeRoot = input.closest(DRAWING_ROOT_SELECTOR);
  currentColor = normalizeHex(input.value);
  customColors = loadCustomColors();
  activeMode = 'grid';
  palette = buildPalette();
  document.body.append(palette);
  activeInput.setAttribute('aria-expanded', 'true');
  activeInput.setAttribute('aria-haspopup', 'dialog');
  setMode('grid');
  renderFooterQuickColors();
  syncPaletteChrome();
  positionPalette();
}

function closePalette() {
  if (activeInput) activeInput.setAttribute('aria-expanded', 'false');
  palette?.remove();
  palette = null;
  palettePanel = null;
  activeInput = null;
  activeRoot = null;
}

function handlePointerDown(event) {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const input = target.closest(COLOR_INPUT_SELECTOR);
  if (input instanceof HTMLInputElement) {
    event.preventDefault();
    openPalette(input);
    return;
  }
  if (palette && !palette.contains(target)) closePalette();
}

function handleClick(event) {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const input = target.closest(COLOR_INPUT_SELECTOR);
  if (input instanceof HTMLInputElement) event.preventDefault();
}

function handleKeyDown(event) {
  if (event.key === 'Escape' && palette) {
    event.preventDefault();
    closePalette();
    return;
  }
  const target = event.target;
  if (!(target instanceof Element)) return;
  const input = target.closest(COLOR_INPUT_SELECTOR);
  if (!(input instanceof HTMLInputElement)) return;
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    openPalette(input);
  }
}

function decorateInputs(root = document) {
  root.querySelectorAll?.(COLOR_INPUT_SELECTOR).forEach((input) => {
    input.setAttribute('aria-haspopup', 'dialog');
    if (!input.hasAttribute('aria-expanded')) input.setAttribute('aria-expanded', 'false');
    input.title = 'Цвет — открыть палитру';
  });
}

if (typeof document !== 'undefined') {
  document.addEventListener('pointerdown', handlePointerDown, true);
  document.addEventListener('click', handleClick, true);
  document.addEventListener('keydown', handleKeyDown, true);

  const reposition = () => positionPalette();
  window.addEventListener('resize', reposition);
  window.addEventListener('orientationchange', reposition);
  window.addEventListener('scroll', reposition, true);
  window.visualViewport?.addEventListener('resize', reposition);
  window.visualViewport?.addEventListener('scroll', reposition);

  const observer = new MutationObserver((records) => {
    if (palette && activeInput && !document.contains(activeInput)) closePalette();
    records.forEach((record) => record.addedNodes.forEach((node) => {
      if (node instanceof Element) decorateInputs(node.matches?.(COLOR_INPUT_SELECTOR) ? node.parentElement ?? node : node);
    }));
    decorateInputs(document);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  queueMicrotask(() => decorateInputs(document));
}
