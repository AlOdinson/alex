import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const css = await readFile(new URL('../src/floating-toolbar-layout.css', import.meta.url), 'utf8');
const mainSource = await readFile(new URL('../src/main.jsx', import.meta.url), 'utf8');
const i18nSource = await readFile(new URL('../src/i18n.js', import.meta.url), 'utf8');
const historyCss = await readFile(new URL('../src/dock-history-icons.css', import.meta.url), 'utf8');
const historyJs = await readFile(new URL('../src/dock-history-icons.js', import.meta.url), 'utf8');
const shellBlock = css.match(/\.toolbar-shell\s*\{([^}]*)\}/)?.[1] ?? '';

// Regression: the React toolbar wrapper must not create its own layout/compositing box.
// A viewport-sized box can wash out the canvas; a 1x1 positioned box can become the
// containing block for Chrome's fixed descendants and push the desktop controls offscreen.
assert.match(shellBlock, /(?:^|\n)\s*display:\s*contents\s*!important/);
assert.doesNotMatch(shellBlock, /(?:^|\n)\s*width:\s*1px\s*!important/);
assert.doesNotMatch(shellBlock, /(?:^|\n)\s*height:\s*1px\s*!important/);
assert.doesNotMatch(shellBlock, /(?:^|\n)\s*inset:\s*0\s*!important/);

// The actual floating rows must remain viewport-fixed and independently interactive.
assert.match(css, /\.toolbar-primary-row,\s*\n\.toolbar-secondary-row\s*\{[^}]*position:\s*fixed\s*!important/);
assert.match(css, /\.toolbar-primary-row\s*\{[^}]*right:\s*max\(10px,\s*env\(safe-area-inset-right\)\)\s*!important/);
assert.match(css, /\.toolbar-secondary-row\s*\.edit-actions\s*\{[^}]*top:\s*50%\s*!important/);

// The status must participate in the right-side row instead of staying absolutely
// positioned by the legacy desktop toolbar CSS.
assert.match(css, /(?:^|\n)\.toolbar-status\s*\{[^}]*position:\s*static\s*!important/);

// Undo/redo belong beside the bottom dock on every viewport. i18n rewrites the legacy
// upper group's aria-label in English, so hiding it by translated text is unsafe.
assert.match(mainSource, /import '\.\/dock-history-icons\.css';/);
assert.match(mainSource, /import '\.\/dock-history-icons\.js';/);
assert.match(i18nSource, /'Отмена и возврат':\s*'Undo and redo'/);
assert.match(css, /#root\s+\.toolbar-shell\s+\.toolbar-primary-row\s*>\s*\.brand-button\s*\+\s*\.tool-group\.compact\s*\{[^}]*display:\s*none\s*!important/);
assert.doesNotMatch(css, /\[aria-label="Отмена и возврат"\]/);
assert.doesNotMatch(css, /\.dock-history-accessories\s*\{[^}]*display:\s*none\s*!important/);

// Keep the approved thin circular SVG treatment instead of text glyph buttons.
assert.match(historyJs, /dock-history-icon/);
assert.match(historyJs, /replaceChildren\(createHistoryIcon\(kind\)\)/);
assert.match(historyCss, /\.dock-history-button\s*\{[^}]*border:\s*0\s*!important[^}]*background:\s*transparent\s*!important[^}]*box-shadow:\s*none\s*!important/);
assert.match(historyCss, /\.dock-history-icon\s*\{[^}]*stroke-width:\s*1\.9\s*!important[^}]*stroke-linecap:\s*round\s*!important/);
assert.match(historyCss, /@media \(max-width:\s*760px\)[\s\S]*?\.dock-history-accessories\s*\{[^}]*left:\s*max\(4px,\s*calc\(var\(--dock-style-left,\s*50vw\)\s*-\s*70px\)\)\s*!important/);

console.log('Floating toolbar and dock history placement regression passed.');
