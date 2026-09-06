import assert from 'node:assert/strict';
import fs from 'node:fs';

const toolbar = fs.readFileSync(new URL('../src/components/Toolbar.jsx', import.meta.url), 'utf8');
const paletteUrl = new URL('../src/components/ColorPalettePopover.jsx', import.meta.url);
const cssUrl = new URL('../src/ipad-color-palette.css', import.meta.url);

assert.ok(fs.existsSync(paletteUrl), 'iPad-style color palette component must exist');
assert.ok(fs.existsSync(cssUrl), 'iPad-style color palette stylesheet must exist');
assert.match(toolbar, /ColorPalettePopover/, 'Toolbar must use the rich color palette for the center drawing dot');
assert.match(toolbar, /colorAnchorRef/, 'Center color dot must provide an anchor for popover placement');

const palette = fs.readFileSync(paletteUrl, 'utf8');
assert.match(palette, /Сетка/, 'Palette must provide the grid tab');
assert.match(palette, /Спектр/, 'Palette must provide the spectrum tab');
assert.match(palette, /Ползунки/, 'Palette must provide the sliders tab');
assert.match(palette, /recent/i, 'Palette must retain recent colors');
assert.match(palette, /onEyedropper/, 'Palette must expose the board eyedropper action');
assert.match(palette, /createPortal/, 'Palette must render above the board through a portal');
assert.match(palette, /getBoundingClientRect/, 'Palette must position from the center color dot');
assert.match(palette, /openAbove/, 'Palette must prefer opening above the center dot');

const css = fs.readFileSync(cssUrl, 'utf8');
assert.match(css, /\.ipad-color-palette/, 'Palette stylesheet must define the popover shell');
assert.match(css, /\.ipad-color-grid/, 'Palette stylesheet must define a dense preset color grid');
assert.match(css, /\.ipad-spectrum/, 'Palette stylesheet must define the spectrum surface');
assert.match(css, /\.ipad-color-tabs/, 'Palette stylesheet must define the three mode tabs');
assert.match(css, /\.ipad-recent-colors/, 'Palette stylesheet must define recent colors');

console.log('iPad-style color palette regression passed.');
