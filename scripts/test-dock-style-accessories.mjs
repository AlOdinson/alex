import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const mainSource = await readFile(new URL('../src/main.jsx', import.meta.url), 'utf8');
const enhancerSource = await readFile(new URL('../src/dock-style-accessories.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../src/dock-style-accessories.css', import.meta.url), 'utf8');

assert.match(mainSource, /import '\.\/dock-style-accessories\.css';/);
assert.match(mainSource, /import '\.\/dock-style-accessories\.js';/);

assert.match(enhancerSource, /alex-board:drawing-presets:v1/);
assert.match(enhancerSource, /dispatchHistoryShortcut/);
assert.match(enhancerSource, /drawingSourceRoot/);
assert.match(enhancerSource, /selectionSourceRoot/);
assert.match(enhancerSource, /ensureSelectionFloatingProxy/);
assert.match(enhancerSource, /selection-floating-proxy/);
assert.match(enhancerSource, /applyPresetToSelection/);
assert.match(enhancerSource, /data-preset-width/);
assert.match(enhancerSource, /handleAccessoryTouchEnd/);
assert.match(enhancerSource, /touchType/);
assert.match(enhancerSource, /function syncRightAccessories\(shell, accessoriesVisible,[\s\S]*?shell\.hidden\s*=\s*!accessoriesVisible/);

assert.match(css, /\.dock-history-accessories\s*\{[\s\S]*?position:\s*fixed/);
assert.match(css, /\.dock-style-right-accessories\s*\{[\s\S]*?position:\s*fixed[\s\S]*?display:\s*grid[\s\S]*?grid-template-columns:\s*repeat\(2,/);
assert.match(css, /\.dock-style-right-accessories\[hidden\][\s\S]*?display:\s*none/);
assert.match(css, /\.dock-style-preset-button:nth-child\(2\)[\s\S]*?grid-column:\s*2[\s\S]*?grid-row:\s*1/);
assert.match(css, /\.dock-style-preset-button:nth-child\(3\)[\s\S]*?grid-column:\s*1[\s\S]*?grid-row:\s*2/);
assert.match(css, /\.dock-style-preset-button:nth-child\(4\)[\s\S]*?grid-column:\s*2[\s\S]*?grid-row:\s*2/);
assert.match(css, /\.dock-style-preset-button::after\s*\{[\s\S]*?content:\s*attr\(data-preset-width\)/);
assert.match(css, /\.selection-floating-proxy\s*\{/);
assert.match(css, /\.selected-style-controls\.dock-selection-source\s*\{[\s\S]*?display:\s*none/);

console.log('Bottom dock history, right-side preset grid, and selection three-dot controls contract passed.');
