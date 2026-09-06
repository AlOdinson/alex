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
assert.match(toolbar, /title=\"Цвет\"[\s\S]*?eyedropper-button[\s\S]*?Прозр\.[\s\S]*?Толщ\./, 'Floating row must contain color, eyedropper, opacity and width controls');

const css = fs.readFileSync(cssUrl, 'utf8');
assert.match(css, /\.floating-drawing-controls\s*\{[\s\S]*?position:\s*fixed;/, 'Floating row must be fixed to the viewport');
assert.match(css, /width:\s*min\(468px,\s*calc\(100vw - 24px\)\)/, 'Desktop floating controls must match dock width');
assert.match(css, /bottom:\s*calc\(max\(12px,\s*env\(safe-area-inset-bottom\)\) \+ 82px\)/, 'Floating controls must sit directly above the dock');
assert.doesNotMatch(css, /\.board-page:has\(/, 'Floating controls must not depend on CSS :has relocation');
console.log('Floating drawing controls regression passed.');
