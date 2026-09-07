import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const mainSource = await readFile(new URL('../src/main.jsx', import.meta.url), 'utf8');
const enhancerSource = await readFile(new URL('../src/dock-style-accessories.js', import.meta.url), 'utf8');
const gearSource = await readFile(new URL('../src/dock-style-presets-gear.js', import.meta.url), 'utf8');
const historySource = await readFile(new URL('../src/dock-history-icons.js', import.meta.url), 'utf8');
const historyCss = await readFile(new URL('../src/dock-history-icons.css', import.meta.url), 'utf8');
const css = await readFile(new URL('../src/dock-style-accessories.css', import.meta.url), 'utf8');

assert.match(mainSource, /import '\.\/dock-style-accessories\.css';/);
assert.match(mainSource, /import '\.\/dock-style-accessories\.js';/);
assert.match(mainSource, /import '\.\/dock-style-presets-gear\.js';/);
assert.match(mainSource, /import '\.\/dock-history-icons\.css';/);
assert.match(mainSource, /import '\.\/dock-history-icons\.js';/);

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

// Undo/redo use minimal circular SVG arrows with no visible button chrome.
assert.match(historySource, /function createHistoryIcon\(kind\)/);
assert.match(historySource, /dock-history-icon/);
assert.match(historySource, /installHistoryIcons/);
assert.match(historySource, /dock-history-undo/);
assert.match(historySource, /dock-history-redo/);
assert.match(historyCss, /\.dock-history-accessories\s*\{[\s\S]*?gap:\s*12px\s*!important/);
assert.match(historyCss, /\.dock-history-button\s*\{[\s\S]*?border:\s*0\s*!important[\s\S]*?border-radius:\s*0\s*!important[\s\S]*?background:\s*transparent\s*!important[\s\S]*?box-shadow:\s*none\s*!important/);
assert.match(historyCss, /\.dock-history-icon\s*\{[\s\S]*?width:\s*24px\s*!important[\s\S]*?height:\s*24px\s*!important[\s\S]*?fill:\s*none\s*!important[\s\S]*?stroke:\s*#2f4778\s*!important/);

// Preset tiles should read as one clean, palette-like 2x2 block beside the dock.
assert.match(css, /:root\s*\{[\s\S]*?--dock-style-tile:\s*28px/);
assert.match(css, /\.dock-style-right-accessories\s*\{[\s\S]*?position:\s*fixed[\s\S]*?display:\s*grid[\s\S]*?grid-template-columns:\s*repeat\(2,/);
assert.match(css, /\.dock-style-right-accessories\s*\{[\s\S]*?width:\s*calc\(var\(--dock-style-tile\) \* 2 \+ 2px\)\s*!important[\s\S]*?height:\s*calc\(var\(--dock-style-tile\) \* 2 \+ 2px\)\s*!important[\s\S]*?gap:\s*2px\s*!important/);
assert.match(css, /\.dock-style-right-accessories\[hidden\][\s\S]*?display:\s*none/);
assert.match(css, /\.dock-style-right-accessories\s*\{[\s\S]*?border-radius:\s*0\s*!important/);
assert.match(css, /\.dock-style-right-accessories\s*\{[\s\S]*?overflow:\s*visible\s*!important/);
assert.match(css, /\.dock-style-eyedropper-button,[\s\S]*?\.dock-style-preset-button\s*\{[\s\S]*?border:\s*0\s*!important[\s\S]*?border-radius:\s*0\s*!important/);
assert.match(css, /\.dock-style-eyedropper-button\s*\{[\s\S]*?border-radius:\s*0\s*!important/);
assert.match(css, /\.dock-style-preset-button:nth-child\(2\)[\s\S]*?grid-column:\s*2[\s\S]*?grid-row:\s*1[\s\S]*?border-radius:\s*0\s*!important/);
assert.match(css, /\.dock-style-preset-button:nth-child\(3\)[\s\S]*?grid-column:\s*1[\s\S]*?grid-row:\s*2[\s\S]*?border-radius:\s*0\s*!important/);
assert.match(css, /\.dock-style-preset-button:nth-child\(4\)[\s\S]*?grid-column:\s*2[\s\S]*?grid-row:\s*2[\s\S]*?border-radius:\s*0\s*!important/);

// Width is plain text on the tile: no pill/badge, with automatic black/white contrast.
assert.match(enhancerSource, /function presetLabelColor/);
assert.match(enhancerSource, /--preset-label-color/);
assert.match(css, /\.dock-style-preset-button::after\s*\{[\s\S]*?content:\s*attr\(data-preset-width\)[\s\S]*?color:\s*var\(--preset-label-color/);
assert.doesNotMatch(css, /\.dock-style-preset-button::after\s*\{[\s\S]*?background:\s*rgba\(/);
assert.doesNotMatch(css, /\.dock-style-preset-button::after\s*\{[\s\S]*?border-radius:\s*999px/);
assert.match(css, /\.dock-style-preset-button::after\s*\{[\s\S]*?text-shadow:\s*none/);

// The right-side pipette uses a real minimal SVG icon instead of a text glyph.
assert.match(enhancerSource, /function createEyedropperIcon/);
assert.match(enhancerSource, /dock-style-eyedropper-icon/);
assert.match(css, /\.dock-style-eyedropper-icon\s*\{/);

// A gear sits just outside the top-right of the four tiles and opens the existing preset editor.
assert.match(gearSource, /function createPresetsGearIcon/);
assert.match(gearSource, /dock-style-presets-gear/);
assert.match(gearSource, /function openPresetEditorPanel/);
assert.match(gearSource, /document\.querySelector\('\.drawing-presets-gear'\)/);
assert.match(gearSource, /dataset\.dockStyleAction\s*=\s*'edit-presets'/);
assert.match(css, /\.dock-style-presets-gear\s*\{[\s\S]*?position:\s*absolute\s*!important[\s\S]*?left:\s*calc\(100% \+ [^)]+\)\s*!important[\s\S]*?top:/);

assert.match(css, /\.selection-floating-proxy\s*\{/);
assert.match(css, /\.selected-style-controls\.dock-selection-source\s*\{[\s\S]*?display:\s*none/);

console.log('Minimal circular history arrows, square preset tiles with 2px spacing, edit gear, contrast labels, eyedropper icon, and selection controls contract passed.');
