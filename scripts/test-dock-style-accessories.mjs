import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const mainSource = await readFile(new URL('../src/main.jsx', import.meta.url), 'utf8');
const toolbarSource = await readFile(new URL('../src/components/Toolbar.jsx', import.meta.url), 'utf8');
const layoutCss = await readFile(new URL('../src/floating-toolbar-layout.css', import.meta.url), 'utf8').catch(() => '');
const enhancerSource = await readFile(new URL('../src/dock-style-accessories.js', import.meta.url), 'utf8');
const gearSource = await readFile(new URL('../src/dock-style-presets-gear.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../src/dock-style-accessories.css', import.meta.url), 'utf8');

assert.match(mainSource, /import '\.\/dock-style-accessories\.css';/);
assert.match(mainSource, /import '\.\/dock-style-accessories\.js';/);
assert.match(mainSource, /import '\.\/dock-style-presets-gear\.js';/);
assert.match(mainSource, /import '\.\/floating-toolbar-layout\.css';/);
assert.doesNotMatch(mainSource, /dock-history-icons/);

assert.match(enhancerSource, /alex-board:drawing-presets:v1/);
assert.match(enhancerSource, /drawingSourceRoot/);
assert.match(enhancerSource, /selectionSourceRoot/);
assert.match(enhancerSource, /ensureSelectionFloatingProxy/);
assert.match(enhancerSource, /selection-floating-proxy/);
assert.match(enhancerSource, /applyPresetToSelection/);
assert.match(enhancerSource, /data-preset-width/);
assert.match(enhancerSource, /handleAccessoryTouchEnd/);
assert.match(enhancerSource, /touchType/);
assert.match(enhancerSource, /function syncRightAccessories\(shell, accessoriesVisible,[\s\S]*?shell\.hidden\s*=\s*!accessoriesVisible/);

// Existing React controls stay intact; layout is changed without replacing their handlers.
assert.match(toolbarSource, /className="tool-group compact edit-actions"/);
assert.match(toolbarSource, /selectedCount > 0[\s\S]*?className="tool-group compact object-actions"/);
assert.match(toolbarSource, /className="tool-group compact zoom-group"/);
assert.match(toolbarSource, /className="tool-group compact navigation-actions"/);
assert.match(toolbarSource, /className="background-control"/);
assert.match(toolbarSource, /<LanguageToggle compact \/>/);
assert.match(toolbarSource, /className={`toolbar-status sync-\$\{syncTone\}`}/);
assert.match(toolbarSource, /className="toolbar-end-actions"/);

// Undo/redo disappear from the screen, but Board keyboard shortcuts remain untouched.
assert.match(layoutCss, /\.toolbar-primary-row \[aria-label="Отмена и возврат"\]\s*\{[\s\S]*?display:\s*none\s*!important/);
assert.match(layoutCss, /\.dock-history-accessories\s*\{[\s\S]*?display:\s*none\s*!important/);

// Permanent left-center edit column and selection-only object column.
assert.match(layoutCss, /\.toolbar-secondary-row \.edit-actions\s*\{[\s\S]*?position:\s*fixed\s*!important[\s\S]*?left:[\s\S]*?top:\s*50%\s*!important[\s\S]*?flex-direction:\s*column\s*!important/);
assert.match(layoutCss, /\.toolbar-secondary-row \.object-actions\s*\{[\s\S]*?position:\s*fixed\s*!important[\s\S]*?left:[\s\S]*?top:\s*50%\s*!important[\s\S]*?flex-direction:\s*column\s*!important/);
assert.match(layoutCss, /\.toolbar-secondary-row \.object-actions > :nth-child\(2\)\s*\{\s*order:\s*1\s*;?\s*\}/);
assert.match(layoutCss, /\.toolbar-secondary-row \.object-actions > :nth-child\(1\)\s*\{\s*order:\s*2\s*;?\s*\}/);

// The old full-width white toolbar chrome is gone; its two rows float at the upper right.
assert.match(layoutCss, /\.toolbar-shell\s*\{[\s\S]*?background:\s*transparent\s*!important[\s\S]*?box-shadow:\s*none\s*!important[\s\S]*?backdrop-filter:\s*none\s*!important/);
assert.match(layoutCss, /\.toolbar-primary-row,\s*\.toolbar-secondary-row\s*\{[\s\S]*?position:\s*fixed\s*!important[\s\S]*?width:\s*auto\s*!important[\s\S]*?background:\s*transparent\s*!important/);
assert.match(layoutCss, /\.toolbar-primary-row\s*\{[\s\S]*?top:[\s\S]*?right:[\s\S]*?max-width:/);
assert.match(layoutCss, /\.toolbar-secondary-row\s*\{[\s\S]*?top:[\s\S]*?right:[\s\S]*?max-width:/);
assert.match(layoutCss, /\.toolbar-primary-row \.toolbar-spacer\s*\{[\s\S]*?display:\s*none\s*!important/);
assert.match(layoutCss, /\.toolbar-primary-row \.brand-button\s*\{[\s\S]*?position:\s*fixed\s*!important[\s\S]*?left:/);
assert.match(layoutCss, /\.toolbar-status\s*\{[\s\S]*?margin-left:\s*0\s*!important/);

// Preset tiles remain the approved 2x2 block beside the bottom dock.
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

console.log('Floating left actions, top-right utility rows/status, hidden on-screen history, and the approved preset block contract passed.');
