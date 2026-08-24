import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const storage = new Map();
globalThis.localStorage = {
  getItem(key) {
    return storage.has(key) ? storage.get(key) : null;
  },
  setItem(key, value) {
    storage.set(key, String(value));
  },
};

const presets = await import('../src/lib/drawingPresets.js');
assert.equal(presets.DRAWING_PRESET_COUNT, 3);
assert.deepEqual(presets.getDrawingPresets(), [null, null, null]);

presets.saveDrawingPreset(1, { color: '#FF0000', opacity: 0.51, width: 12 });
assert.deepEqual(presets.getDrawingPresets(), [
  null,
  { color: '#ff0000', opacity: 0.5, width: 12 },
  null,
]);
assert.equal(presets.sliderStepToWidth(presets.widthToSliderStep(12)), 12);
assert.equal(presets.sliderStepToWidth(presets.widthToSliderStep(50)), 50);

presets.clearDrawingPreset(1);
assert.deepEqual(presets.getDrawingPresets(), [null, null, null]);

const toolbarSource = await readFile(new URL('../src/components/Toolbar.jsx', import.meta.url), 'utf8');
assert.match(toolbarSource, /<DrawingPresets/);
assert.match(toolbarSource, /canApply=\{canEdit && showDrawingSettings\}/);

const presetSource = await readFile(new URL('../src/components/DrawingPresets.jsx', import.meta.url), 'utf8');
assert.match(presetSource, /Сохраняются на этом устройстве/);
assert.match(presetSource, /Выберите один из трёх квадратиков/);
assert.match(presetSource, /onActivate=\{\(\) => onApply\?\.\(preset\)\}/);

const boardSource = await readFile(new URL('../src/components/Board.jsx', import.meta.url), 'utf8');
assert.match(boardSource, /const applyDrawingPreset = useCallback/);
assert.match(boardSource, /drawingStylesRef\.current\[activeTool\] = \{[\s\S]*?color: nextColor,[\s\S]*?opacity: nextOpacity,[\s\S]*?width: nextWidth/);
assert.match(boardSource, /onApplyDrawingPreset=\{applyDrawingPreset\}/);

console.log('Three device-local drawing presets and atomic active-tool application tests passed.');
