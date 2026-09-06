const COLOR_INPUT_SELECTOR = '.floating-drawing-controls > .color-control input[type="color"]';
const DRAWING_ROOT_SELECTOR = '.floating-drawing-controls';
const RECENT_COLORS_KEY = 'alex-board:recent-colors:v1';
const EDGE_GAP = 8;
const PALETTE_WIDTH = 318;
const PALETTE_GAP = 12;

const PRESET_COLORS = [
  '#000000', '#1f2937', '#475569', '#64748b', '#94a3b8', '#cbd5e1', '#e2e8f0', '#ffffff',
  '#7f1d1d', '#b91c1c', '#ef4444', '#fb7185', '#fca5a5', '#fecaca', '#fff1f2', '#fef2f2',
  '#7c2d12', '#c2410c', '#f97316', '#fb923c', '#fdba74', '#fed7aa', '#fff7ed', '#fffbeb',
  '#713f12', '#a16207', '#eab308', '#facc15', '#fde047', '#fef08a', '#fef9c3', '#fefce8',
  '#14532d', '#15803d', '#22c55e', '#4ade80', '#86efac', '#bbf7d0', '#dcfce7', '#f0fdf4',
  '#164e63', '#0891b2', '#06b6d4', '#22d3ee', '#67e8f9', '#a5f3fc', '#cffafe', '#ecfeff',
  '#1e3a8a', '#1d4ed8', '#2563eb', '#3b82f6', '#60a5fa', '#93c5fd', '#bfdbfe', '#eff6ff',
  '#4c1d95', '#6d28d9', '#7c3aed', '#8b5cf6', '#a78bfa', '#c4b5fd', '#ddd6fe', '#f5f3ff',
  '#831843', '#be185d', '#ec4899', '#f472b6', '#f9a8d4', '#fbcfe8', '#fce7f3', '#fdf2f8',
];

let activeInput = null;
let activeRoot = null;
let palette = null;
let palettePanel = null;
let activeMode = 'grid';
let currentColor = '#111827';
let recentColors = loadRecentColors();
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
  return '#111827';
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

function loadRecentColors() {
  try {
    const stored = JSON.parse(localStorage.getItem(RECENT_COLORS_KEY) ?? '[]');
    if (!Array.isArray(stored)) return [];
    return stored
      .map(normalizeHex)
      .filter((value, index, array) => array.indexOf(value) === index)
      .slice(0, 8);
  } catch {
    return [];
  }
}

function rememberRecentColor(color) {
  const normalized = normalizeHex(color);
  recentColors = [normalized, ...recentColors.filter((item) => item !== normalized)].slice(0, 8);
  try {
    localStorage.setItem(RECENT_COLORS_KEY, JSON.stringify(recentColors));
  } catch {
    // The palette still works when Safari temporarily blocks localStorage.
  }
}

function setControlledInputValue(input, value) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (setter) setter.call(input, value);
  else input.value = value;
}

function dispatchColor(color, remember = false) {
  if (!activeInput) return;
  const normalized = normalizeHex(color);
  currentColor = normalized;
  setControlledInputValue(activeInput, normalized);
  activeInput.dispatchEvent(new Event('input', { bubbles: true }));
  activeInput.dispatchEvent(new Event('change', { bubbles: true }));
  if (remember) rememberRecentColor(normalized);
  syncPaletteChrome();
}

function syncPaletteChrome() {
  if (!palette) return;
  const preview = palette.querySelector('.ipad-color-preview');
  const code = palette.querySelector('.ipad-color-code');
  if (preview) preview.style.backgroundColor = currentColor;
  if (code) code.textContent = currentColor.toUpperCase();
  palette.querySelectorAll('.ipad-color-swatch').forEach((button) => {
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
  const width = Math.min(PALETTE_WIDTH, Math.max(276, viewportWidth - EDGE_GAP * 2));
  const center = rect.left + offsetLeft + rect.width / 2;
  const left = clamp(
    center - width / 2,
    offsetLeft + EDGE_GAP,
    offsetLeft + viewportWidth - width - EDGE_GAP,
  );
  const availableAbove = rect.top - EDGE_GAP;
  const availableBelow = viewportHeight - rect.bottom - EDGE_GAP;
  openAbove = availableAbove >= 270 || availableAbove >= availableBelow;
  const top = openAbove
    ? rect.top + offsetTop - PALETTE_GAP
    : rect.bottom + offsetTop + PALETTE_GAP;

  palette.style.left = `${left}px`;
  palette.style.top = `${top}px`;
  palette.style.width = `${width}px`;
  palette.style.maxHeight = `${Math.max(220, viewportHeight - EDGE_GAP * 2)}px`;
  palette.style.transform = openAbove ? 'translateY(-100%)' : 'none';
  palette.classList.toggle('open-above', openAbove);
  palette.classList.toggle('open-below', !openAbove);
}

function makeSwatch(color, compact = false) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `ipad-color-swatch${compact ? ' compact' : ''}`;
  button.dataset.color = normalizeHex(color);
  button.title = normalizeHex(color).toUpperCase();
  button.setAttribute('aria-label', `Цвет ${normalizeHex(color).toUpperCase()}`);
  button.style.backgroundColor = normalizeHex(color);
  button.addEventListener('click', () => {
    dispatchColor(color, true);
    closePalette();
  });
  return button;
}

function renderGrid() {
  if (!palettePanel) return;
  palettePanel.replaceChildren();

  const recentBlock = document.createElement('div');
  recentBlock.className = 'ipad-recent-block';
  const recentTitle = document.createElement('div');
  recentTitle.className = 'ipad-section-label';
  recentTitle.textContent = 'Недавние';
  const recentRow = document.createElement('div');
  recentRow.className = 'ipad-recent-colors';
  const recentSource = recentColors.length ? recentColors : [currentColor];
  recentSource.forEach((color) => recentRow.append(makeSwatch(color, true)));
  recentBlock.append(recentTitle, recentRow);

  const gridTitle = document.createElement('div');
  gridTitle.className = 'ipad-section-label';
  gridTitle.textContent = 'Цвета';
  const grid = document.createElement('div');
  grid.className = 'ipad-color-grid';
  PRESET_COLORS.forEach((color) => grid.append(makeSwatch(color)));

  palettePanel.append(recentBlock, gridTitle, grid);
  syncPaletteChrome();
}

function spectrumColorFromPointer(surface, event) {
  const rect = surface.getBoundingClientRect();
  const x = clamp((event.clientX - rect.left) / Math.max(1, rect.width), 0, 1);
  const y = clamp((event.clientY - rect.top) / Math.max(1, rect.height), 0, 1);
  const hue = x * 360;
  const lightness = 95 - y * 90;
  dispatchColor(hslToHex(hue, 100, lightness), false);
}

function syncSpectrumIndicator() {
  const surface = palette?.querySelector('.ipad-spectrum');
  const indicator = palette?.querySelector('.ipad-spectrum-indicator');
  if (!surface || !indicator) return;
  const { hue, lightness } = rgbToHsl(currentColor);
  const x = clamp(hue / 360, 0, 1);
  const y = clamp((95 - lightness) / 90, 0, 1);
  indicator.style.left = `${x * 100}%`;
  indicator.style.top = `${y * 100}%`;
  indicator.style.backgroundColor = currentColor;
}

function renderSpectrum() {
  if (!palettePanel) return;
  palettePanel.replaceChildren();
  const hint = document.createElement('div');
  hint.className = 'ipad-spectrum-hint';
  hint.textContent = 'Проведите по спектру, чтобы выбрать любой оттенок';
  const surface = document.createElement('div');
  surface.className = 'ipad-spectrum';
  surface.setAttribute('role', 'slider');
  surface.setAttribute('aria-label', 'Спектр цвета');
  surface.tabIndex = 0;
  const indicator = document.createElement('span');
  indicator.className = 'ipad-spectrum-indicator';
  surface.append(indicator);

  surface.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    spectrumColorFromPointer(surface, event);
    try { surface.setPointerCapture(event.pointerId); } catch { /* no-op */ }
  });
  surface.addEventListener('pointermove', (event) => {
    if (!surface.hasPointerCapture?.(event.pointerId)) return;
    spectrumColorFromPointer(surface, event);
  });
  const finish = (event) => {
    if (surface.hasPointerCapture?.(event.pointerId)) {
      spectrumColorFromPointer(surface, event);
      try { surface.releasePointerCapture(event.pointerId); } catch { /* no-op */ }
    }
    rememberRecentColor(currentColor);
  };
  surface.addEventListener('pointerup', finish);
  surface.addEventListener('pointercancel', finish);

  palettePanel.append(hint, surface);
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
  const hexInput = palette.querySelector('.ipad-hex-input');
  if (hexInput && document.activeElement !== hexInput) hexInput.value = currentColor.toUpperCase();
}

function renderSliders() {
  if (!palettePanel) return;
  palettePanel.replaceChildren();
  const rgb = hexToRgb(currentColor);
  const channels = [
    ['r', 'R', rgb.r],
    ['g', 'G', rgb.g],
    ['b', 'B', rgb.b],
  ];

  const rows = document.createElement('div');
  rows.className = 'ipad-rgb-sliders';
  channels.forEach(([channel, labelText, value]) => {
    const row = document.createElement('label');
    row.className = 'ipad-rgb-row';
    const label = document.createElement('span');
    label.textContent = labelText;
    const input = document.createElement('input');
    input.type = 'range';
    input.min = '0';
    input.max = '255';
    input.step = '1';
    input.value = String(value);
    input.dataset.channel = channel;
    const output = document.createElement('strong');
    output.dataset.output = channel;
    output.textContent = String(value);
    input.addEventListener('input', () => {
      const next = hexToRgb(currentColor);
      next[channel] = Number(input.value);
      dispatchColor(rgbToHex(next.r, next.g, next.b), false);
    });
    input.addEventListener('change', () => rememberRecentColor(currentColor));
    row.append(label, input, output);
    rows.append(row);
  });

  const hexRow = document.createElement('label');
  hexRow.className = 'ipad-hex-row';
  const hexLabel = document.createElement('span');
  hexLabel.textContent = 'HEX';
  const hexInput = document.createElement('input');
  hexInput.type = 'text';
  hexInput.className = 'ipad-hex-input';
  hexInput.value = currentColor.toUpperCase();
  hexInput.maxLength = 7;
  hexInput.spellcheck = false;
  hexInput.autocapitalize = 'characters';
  hexInput.addEventListener('input', () => {
    const value = String(hexInput.value).trim();
    if (/^#[0-9a-fA-F]{6}$/.test(value)) dispatchColor(value, false);
  });
  hexInput.addEventListener('change', () => {
    if (/^#[0-9a-fA-F]{6}$/.test(hexInput.value)) rememberRecentColor(hexInput.value);
    else hexInput.value = currentColor.toUpperCase();
  });
  hexRow.append(hexLabel, hexInput);
  palettePanel.append(rows, hexRow);
  syncSliderValues();
}

function renderPanel() {
  if (activeMode === 'spectrum') renderSpectrum();
  else if (activeMode === 'sliders') renderSliders();
  else renderGrid();
}

function setMode(mode) {
  activeMode = mode;
  palette?.querySelectorAll('.ipad-color-tabs button').forEach((button) => {
    const active = button.dataset.mode === mode;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  renderPanel();
}

function buildPalette() {
  const shell = document.createElement('div');
  shell.className = 'ipad-color-palette';
  shell.setAttribute('role', 'dialog');
  shell.setAttribute('aria-label', 'Палитра цвета');

  const header = document.createElement('div');
  header.className = 'ipad-color-header';
  const preview = document.createElement('span');
  preview.className = 'ipad-color-preview';
  const titleBlock = document.createElement('div');
  titleBlock.className = 'ipad-color-title';
  const title = document.createElement('strong');
  title.textContent = 'Цвет';
  const code = document.createElement('span');
  code.className = 'ipad-color-code';
  titleBlock.append(title, code);

  const eyedropper = document.createElement('button');
  eyedropper.type = 'button';
  eyedropper.className = 'ipad-eyedropper';
  eyedropper.title = 'Пипетка';
  eyedropper.setAttribute('aria-label', 'Пипетка');
  eyedropper.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14.7 5.3a2.8 2.8 0 1 1 4 4l-2 2-1.6-1.6-6.5 6.5-.5 3.5-3.6.5.5-3.6 6.5-6.5-1.6-1.6 2-2Z"/><path d="m13.6 6.4 4 4"/></svg><span>Пипетка</span>';
  eyedropper.addEventListener('click', () => {
    activeRoot?.querySelector(':scope > .eyedropper-button')?.click();
    closePalette();
  });
  header.append(preview, titleBlock, eyedropper);

  const tabs = document.createElement('div');
  tabs.className = 'ipad-color-tabs';
  tabs.setAttribute('role', 'tablist');
  [
    ['grid', 'Сетка'],
    ['spectrum', 'Спектр'],
    ['sliders', 'Ползунки'],
  ].forEach(([mode, label]) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.mode = mode;
    button.textContent = label;
    button.setAttribute('role', 'tab');
    button.addEventListener('click', () => setMode(mode));
    tabs.append(button);
  });

  palettePanel = document.createElement('div');
  palettePanel.className = 'ipad-color-panel';
  shell.append(header, tabs, palettePanel);
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
  recentColors = loadRecentColors();
  activeMode = 'grid';
  palette = buildPalette();
  document.body.append(palette);
  activeInput.setAttribute('aria-expanded', 'true');
  activeInput.setAttribute('aria-haspopup', 'dialog');
  setMode(activeMode);
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
