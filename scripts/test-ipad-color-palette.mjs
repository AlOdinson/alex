import assert from 'node:assert/strict';
import fs from 'node:fs';

const main = fs.readFileSync(new URL('../src/main.jsx', import.meta.url), 'utf8');
const toolbar = fs.readFileSync(new URL('../src/components/Toolbar.jsx', import.meta.url), 'utf8');
const paletteUrl = new URL('../src/ipad-color-palette.js', import.meta.url);
const cssUrl = new URL('../src/ipad-color-palette.css', import.meta.url);

assert.ok(fs.existsSync(paletteUrl), 'iPad-style color palette behavior module must exist');
assert.ok(fs.existsSync(cssUrl), 'iPad-style color palette stylesheet must exist');
assert.match(main, /import ['\"]\.\/ipad-color-palette\.css['\"];/, 'iPad palette CSS must be loaded');
assert.match(main, /import ['\"]\.\/ipad-color-palette\.js['\"];/, 'iPad palette behavior must be loaded');
assert.match(toolbar, /type=['\"]color['\"]/, 'The existing center color input must remain the source of truth');

const palette = fs.readFileSync(paletteUrl, 'utf8');
assert.match(palette, /Сетка/, 'Palette must provide the grid tab');
assert.match(palette, /Спектр/, 'Palette must provide the spectrum tab');
assert.match(palette, /Ползунки/, 'Palette must provide the sliders tab');
assert.match(palette, /recent/i, 'Palette must retain recent colors');
assert.match(palette, /localStorage/, 'Recent colors must persist locally');
assert.match(palette, /getBoundingClientRect/, 'Palette must position from the center color dot');
assert.match(palette, /openAbove/, 'Palette must prefer opening above the center dot');
assert.match(palette, /preventDefault\(\)/, 'The native browser color picker must be suppressed');
assert.match(palette, /dispatchEvent/, 'Palette selections must flow through the existing controlled color input');
assert.match(palette, /eyedropper-button/, 'Palette eyedropper must reuse the board eyedropper action');
assert.match(palette, /document\.body\.append/, 'Palette must render at document level above the board');

const css = fs.readFileSync(cssUrl, 'utf8');
assert.match(css, /\.ipad-color-palette/, 'Palette stylesheet must define the popover shell');
assert.match(css, /\.ipad-color-grid/, 'Palette stylesheet must define a dense preset color grid');
assert.match(css, /\.ipad-spectrum/, 'Palette stylesheet must define the spectrum surface');
assert.match(css, /\.ipad-color-tabs/, 'Palette stylesheet must define the three mode tabs');
assert.match(css, /\.ipad-recent-colors/, 'Palette stylesheet must define recent colors');

console.log('iPad-style color palette regression passed.');
