import assert from 'node:assert/strict';
import fs from 'node:fs';

const main = fs.readFileSync(new URL('../src/main.jsx', import.meta.url), 'utf8');
const toolbar = fs.readFileSync(new URL('../src/components/Toolbar.jsx', import.meta.url), 'utf8');
const cssUrl = new URL('../src/floating-drawing-controls.css', import.meta.url);

assert.match(main, /import ['\"]\.\/floating-drawing-controls\.css['\"];/, 'Floating drawing controls CSS must be loaded');
assert.ok(fs.existsSync(cssUrl), 'Floating drawing controls stylesheet must exist');
assert.match(toolbar, /import \{ createPortal \} from ['\"]react-dom['\"];/, 'Toolbar must render floating controls through a React portal');
assert.match(toolbar, /createPortal\([\s\S]*?floating-drawing-controls[\s\S]*?document\.body/, 'Floating drawing controls must be portaled to document.body');
assert.match(toolbar, /\['pencil', 'line', 'shape'\]\.includes\(tool\)/, 'Pencil, Line and Shapes must trigger floating drawing controls');
assert.match(toolbar, /const DRAWING_WIDTHS = \[1, 2, 3, 4, 5, 8, 10, 15, 20, 25, 50, 100\];/, 'Floating toolbar must expose the agreed 12 discrete widths');
assert.match(toolbar, /floating-color-control[\s\S]*?eyedropper-button[\s\S]*?opacity-control[\s\S]*?opacity-tooltip[\s\S]*?width-dot-track/, 'Floating row must contain circular color, eyedropper, opacity tooltip and discrete width dots');
assert.match(toolbar, /DRAWING_WIDTHS\.map\(\(value\) =>[\s\S]*?className=\{`width-dot/, 'Width control must render one dot per discrete width');

const css = fs.readFileSync(cssUrl, 'utf8');
assert.match(css, /\.floating-drawing-controls\s*\{[\s\S]*?position:\s*fixed;/, 'Floating row must be fixed to the viewport');
assert.match(css, /width:\s*min\(440px,\s*calc\(100vw - 24px\)\)/, 'Desktop floating controls must be slightly narrower than the bottom dock');
assert.match(css, /\.floating-color-control[\s\S]*?border-radius:\s*50%/, 'Color control must be circular');
assert.match(css, /\.opacity-track-shell[\s\S]*?repeating-conic-gradient/, 'Opacity control must use a transparency checker track');
assert.match(css, /\.width-dot-track::before[\s\S]*?height:\s*1px/, 'Width dots must be connected with a light line');
assert.match(css, /\.width-dot\s*\{[\s\S]*?width:\s*9px;[\s\S]*?height:\s*9px;/, 'All width dots must have one identical size');
assert.match(css, /bottom:\s*calc\(max\(12px,\s*env\(safe-area-inset-bottom\)\) \+ 82px\)/, 'Floating controls must sit directly above the dock');
assert.doesNotMatch(css, /\.board-page:has\(/, 'Floating controls must not depend on CSS :has relocation');
console.log('Floating drawing controls regression passed.');
