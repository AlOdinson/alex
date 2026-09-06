import assert from 'node:assert/strict';
import fs from 'node:fs';

const main = fs.readFileSync(new URL('../src/main.jsx', import.meta.url), 'utf8');
const toolbar = fs.readFileSync(new URL('../src/components/Toolbar.jsx', import.meta.url), 'utf8');
const paletteUrl = new URL('../src/ipad-system-color-palette.js', import.meta.url);
const cssUrl = new URL('../src/ipad-system-color-palette.css', import.meta.url);
const scaleCssUrl = new URL('../src/ipad-system-color-palette-scale.css', import.meta.url);

assert.ok(fs.existsSync(paletteUrl), 'iPad system color palette behavior module must exist');
assert.ok(fs.existsSync(cssUrl), 'iPad system color palette stylesheet must exist');
assert.ok(fs.existsSync(scaleCssUrl), 'Palette scale override stylesheet must exist');
assert.match(main, /import ['\"]\.\/ipad-system-color-palette\.css['\"];/, 'System palette CSS must be loaded');
assert.match(main, /import ['\"]\.\/ipad-system-color-palette-scale\.css['\"];/, 'Palette scale override must be loaded after the base palette CSS');
assert.match(main, /import ['\"]\.\/ipad-system-color-palette\.js['\"];/, 'System palette behavior must be loaded');
assert.doesNotMatch(main, /import ['\"]\.\/ipad-color-palette\.js['\"];/, 'Legacy rich palette behavior must not compete with the system palette');
assert.match(toolbar, /type=['\"]color['\"]/, 'The existing center color input must remain the source of truth');

const palette = fs.readFileSync(paletteUrl, 'utf8');
assert.match(palette, /Цвета/, 'Palette header must match the iPad Colors panel title');
assert.match(palette, /Сетка/, 'Palette must provide the grid tab');
assert.match(palette, /Спектр/, 'Palette must provide the spectrum tab');
assert.match(palette, /Бегунки/, 'Palette must provide the sliders tab using the iPad label');
assert.match(palette, /GRID_COLUMNS\s*=\s*12/, 'Grid must use a 12-column iPad-style matrix');
assert.match(palette, /GRID_ROWS\s*=\s*10/, 'Grid must use a 10-row iPad-style matrix');
assert.match(palette, /ipad-system-footer/, 'Palette must provide the large current-color footer area');
assert.match(palette, /QUICK_COLORS/, 'Palette must provide quick color circles under the grid');
assert.match(palette, /ipad-add-color/, 'Palette must provide the plus button from the reference');
assert.match(palette, /localStorage/, 'Custom/recent colors must persist locally');
assert.match(palette, /getBoundingClientRect/, 'Palette must position from the center color dot');
assert.match(palette, /openAbove/, 'Palette must prefer opening above the center dot');
assert.match(palette, /preventDefault\(\)/, 'The native browser color picker must be suppressed');
assert.match(palette, /dispatchEvent/, 'Palette selections must flow through the existing controlled color input');
assert.doesNotMatch(palette, /ipad-system-eyedropper|eyedropper-button/, 'Color palette must not render or proxy an eyedropper control');
assert.match(palette, /document\.body\.append/, 'Palette must render at document level above the board');

const css = fs.readFileSync(cssUrl, 'utf8');
assert.match(css, /\.ipad-system-color-palette/, 'Palette stylesheet must define the system popover shell');
assert.match(css, /\.ipad-system-grid/, 'Palette stylesheet must define the square color matrix');
assert.match(css, /grid-template-columns:\s*repeat\(12,\s*1fr\)/, 'Color matrix must render as twelve contiguous columns');
assert.match(css, /\.ipad-system-preview/, 'Palette stylesheet must define the large selected-color preview');
assert.match(css, /\.ipad-system-quick-colors/, 'Palette stylesheet must define the quick colors row');
assert.match(css, /\.ipad-system-tabs/, 'Palette stylesheet must define the three segmented tabs');
assert.match(css, /\.ipad-system-spectrum/, 'Palette stylesheet must define the spectrum surface');
assert.match(css, /@media \(max-width:\s*760px\)/, 'Base palette must keep the existing mobile/tablet layout');

const scaleCss = fs.readFileSync(scaleCssUrl, 'utf8');
assert.match(scaleCss, /\.ipad-system-color-palette\.open-above\s*\{[\s\S]*?transform:\s*translateY\(-100%\) scale\(0\.73125\) !important;/, 'Palette opening above must be 12.5% larger than the previous 65% scale');
assert.match(scaleCss, /\.ipad-system-color-palette\.open-above\s*\{[\s\S]*?transform-origin:\s*bottom center;/, 'Scaled palette opening above must stay anchored to the center color dot');
assert.match(scaleCss, /\.ipad-system-color-palette\.open-below\s*\{[\s\S]*?transform:\s*scale\(0\.73125\) !important;/, 'Palette opening below must be 12.5% larger than the previous 65% scale');
assert.match(scaleCss, /\.ipad-system-color-palette\.open-below\s*\{[\s\S]*?transform-origin:\s*top center;/, 'Scaled palette opening below must stay anchored to the center color dot');

console.log('iPad system color palette regression passed.');
