import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const mainSource = await readFile(new URL('../src/main.jsx', import.meta.url), 'utf8');
const enhancerSource = await readFile(new URL('../src/dock-style-accessories.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../src/dock-style-accessories.css', import.meta.url), 'utf8');

assert.match(mainSource, /import '\.\/dock-style-accessories\.css';/);
assert.match(mainSource, /import '\.\/dock-style-accessories\.js';/);

assert.match(enhancerSource, /alex-board:drawing-presets:v1/);
assert.match(enhancerSource, /dock-style-drawing-active/);
assert.match(enhancerSource, /dock-style-selection-active/);
assert.match(enhancerSource, /selected-style-controls/);
assert.match(enhancerSource, /floating-drawing-controls/);
assert.match(enhancerSource, /applyPresetToSelection/);
assert.match(enhancerSource, /data-preset-width/);
assert.match(enhancerSource, /Отмена и возврат/);
assert.match(enhancerSource, /Карандаш/);
assert.match(enhancerSource, /Прямая/);
assert.match(enhancerSource, /Фигуры/);
assert.match(enhancerSource, /ensureAccessoryShells/);
assert.match(enhancerSource, /dock-style-right-accessories/);
assert.match(enhancerSource, /dock-history-source/);
assert.match(enhancerSource, /clickActiveEyedropper/);
assert.match(enhancerSource, /handleAccessoryTouchEnd/);
assert.match(enhancerSource, /touchType/);
assert.match(enhancerSource, /suppressAccessoryClickUntil/);

assert.match(css, /\.dock-history-accessories\s*\{[\s\S]*?position:\s*fixed/);
assert.match(css, /\.dock-style-right-accessories\s*\{[\s\S]*?position:\s*fixed[\s\S]*?display:\s*grid[\s\S]*?grid-template-columns:\s*repeat\(2,/);
assert.match(css, /\.dock-style-preset-button:nth-child\(2\)[\s\S]*?grid-column:\s*2[\s\S]*?grid-row:\s*1/);
assert.match(css, /\.dock-style-preset-button:nth-child\(3\)[\s\S]*?grid-column:\s*1[\s\S]*?grid-row:\s*2/);
assert.match(css, /\.dock-style-preset-button:nth-child\(4\)[\s\S]*?grid-column:\s*2[\s\S]*?grid-row:\s*2/);
assert.match(css, /\.dock-style-preset-button::after\s*\{[\s\S]*?content:\s*attr\(data-preset-width\)/);
assert.match(css, /\.drawing-presets-anchor\s*\{[\s\S]*?visibility:\s*hidden/);
assert.match(css, /\.dock-history-source\s*\{[\s\S]*?display:\s*none/);
assert.match(css, /body:not\(\.dock-style-drawing-active\):not\(\.dock-style-selection-active\)[\s\S]*?\.dock-style-right-accessories[\s\S]*?display:\s*none/);
assert.match(css, /\.dock-style-selection-active[\s\S]*?\.selection-floating-controls/);

console.log('Bottom dock history, eyedropper, preset-grid, selection-style, and stylus activation contract passed.');
