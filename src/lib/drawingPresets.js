const DRAWING_PRESETS_KEY = 'alex-board:drawing-presets:v1';

export const DRAWING_PRESET_COUNT = 3;
export const STROKE_WIDTH_STEPS = [
  ...Array.from({ length: 24 }, (_, index) => index + 1),
  50,
  100,
];

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

export function normalizeDrawingPreset(value, fallback = null) {
  const color = String(value?.color ?? fallback?.color ?? '').toLowerCase();
  if (!/^#[0-9a-f]{6}$/.test(color)) return null;
  const requestedOpacity = Number(value?.opacity ?? fallback?.opacity ?? 1);
  const requestedWidth = Number(value?.width ?? fallback?.width ?? 3);
  const opacity = clamp(Number.isFinite(requestedOpacity) ? requestedOpacity : 1, 0.05, 1);
  const width = clamp(Math.round(Number.isFinite(requestedWidth) ? requestedWidth : 3), 1, 100);
  return {
    color,
    opacity: Math.round(opacity * 20) / 20,
    width,
  };
}

function emptyPresetSlots() {
  return Array.from({ length: DRAWING_PRESET_COUNT }, () => null);
}

export function getDrawingPresets() {
  try {
    const stored = JSON.parse(localStorage.getItem(DRAWING_PRESETS_KEY) ?? '[]');
    const source = Array.isArray(stored) ? stored : [];
    return emptyPresetSlots().map((_, index) => normalizeDrawingPreset(source[index]));
  } catch {
    return emptyPresetSlots();
  }
}

export function writeDrawingPresets(presets) {
  const normalized = emptyPresetSlots().map((_, index) => (
    normalizeDrawingPreset(Array.isArray(presets) ? presets[index] : null)
  ));
  try {
    localStorage.setItem(DRAWING_PRESETS_KEY, JSON.stringify(normalized));
  } catch {
    // The current board can continue even if Safari temporarily blocks local storage.
  }
  return normalized;
}

export function saveDrawingPreset(index, preset) {
  const requestedSlot = Number(index);
  const slot = Math.max(
    0,
    Math.min(DRAWING_PRESET_COUNT - 1, Number.isFinite(requestedSlot) ? Math.round(requestedSlot) : 0),
  );
  const presets = getDrawingPresets();
  presets[slot] = normalizeDrawingPreset(preset);
  return writeDrawingPresets(presets);
}

export function clearDrawingPreset(index) {
  const requestedSlot = Number(index);
  const slot = Math.max(
    0,
    Math.min(DRAWING_PRESET_COUNT - 1, Number.isFinite(requestedSlot) ? Math.round(requestedSlot) : 0),
  );
  const presets = getDrawingPresets();
  presets[slot] = null;
  return writeDrawingPresets(presets);
}

export function widthToSliderStep(width) {
  const numeric = Number(width);
  if (!Number.isFinite(numeric)) return 3;
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

export function sliderStepToWidth(step) {
  const index = Math.max(
    0,
    Math.min(STROKE_WIDTH_STEPS.length - 1, Math.round(Number(step)) - 1),
  );
  return STROKE_WIDTH_STEPS[index];
}

export function drawingPresetStorageKey() {
  return DRAWING_PRESETS_KEY;
}
