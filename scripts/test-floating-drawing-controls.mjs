import assert from 'node:assert/strict';
import fs from 'node:fs';

const main = fs.readFileSync(new URL('../src/main.jsx', import.meta.url), 'utf8');
const cssUrl = new URL('../src/floating-drawing-controls.css', import.meta.url);

assert.match(main, /import ['\"]\.\/floating-drawing-controls\.css['\"];/, 'Floating drawing controls CSS must be loaded');
assert.ok(fs.existsSync(cssUrl), 'Floating drawing controls stylesheet must exist');
const css = fs.readFileSync(cssUrl, 'utf8');
assert.match(css, /nth-child\(2\)\.active/, 'Pencil must trigger floating drawing controls');
assert.match(css, /nth-child\(3\)\.active/, 'Line must trigger floating drawing controls');
assert.match(css, /dock-shape-anchor[\s\S]*dock-tool-button\.active/, 'Shapes must trigger floating drawing controls');
assert.match(css, /width:\s*min\(468px,\s*calc\(100vw - 24px\)\)/, 'Desktop floating controls must match dock width');
assert.match(css, /bottom:\s*calc\(max\(12px,\s*env\(safe-area-inset-bottom\)\) \+ 82px\)/, 'Floating controls must sit directly above the dock');
assert.match(
  css,
  /\.toolbar-shell\s*\{[\s\S]*?backdrop-filter:\s*none\s*!important;[\s\S]*?-webkit-backdrop-filter:\s*none\s*!important;/,
  'Floating controls must release the toolbar fixed-position containing block',
);
console.log('Floating drawing controls regression passed.');
