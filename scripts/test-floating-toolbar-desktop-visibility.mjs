import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const css = await readFile(new URL('../src/floating-toolbar-layout.css', import.meta.url), 'utf8');
const shellBlock = css.match(/\.toolbar-shell\s*\{([^}]*)\}/)?.[1] ?? '';

// Regression: the shared shell must stay as a tiny technical anchor only.
// A viewport-sized shell sits above the canvas/bottom dock and can wash the board
// out with legacy toolbar background/backdrop compositing. A zero-sized static shell,
// on the other hand, previously made the fixed utility descendants disappear.
assert.match(shellBlock, /(?:^|\n)\s*position:\s*fixed\s*!important/);
assert.match(shellBlock, /(?:^|\n)\s*top:\s*0\s*!important/);
assert.match(shellBlock, /(?:^|\n)\s*left:\s*0\s*!important/);
assert.match(shellBlock, /(?:^|\n)\s*width:\s*1px\s*!important/);
assert.match(shellBlock, /(?:^|\n)\s*height:\s*1px\s*!important/);
assert.doesNotMatch(shellBlock, /(?:^|\n)\s*inset:\s*0\s*!important/);
assert.match(shellBlock, /(?:^|\n)\s*background:\s*transparent\s*!important/);
assert.match(shellBlock, /(?:^|\n)\s*backdrop-filter:\s*none\s*!important/);
assert.match(shellBlock, /(?:^|\n)\s*-webkit-backdrop-filter:\s*none\s*!important/);
assert.match(shellBlock, /(?:^|\n)\s*overflow:\s*visible\s*!important/);
assert.match(shellBlock, /(?:^|\n)\s*pointer-events:\s*none/);

// The status must participate in the right-side row instead of staying absolutely
// positioned by the legacy desktop toolbar CSS.
assert.match(css, /(?:^|\n)\.toolbar-status\s*\{[^}]*position:\s*static\s*!important/);

console.log('Desktop floating toolbar visibility and board clarity regression passed.');
