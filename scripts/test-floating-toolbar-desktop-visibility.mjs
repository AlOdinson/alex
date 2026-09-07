import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const css = await readFile(new URL('../src/floating-toolbar-layout.css', import.meta.url), 'utf8');

// Regression: the shared toolbar shell must remain a viewport-sized transparent layer.
// Collapsing it to 0x0 hides all of its desktop utility descendants while the bottom dock,
// which lives outside the shell, remains visible.
assert.match(css, /\.toolbar-shell\s*\{[\s\S]*?position:\s*fixed\s*!important/);
assert.match(css, /\.toolbar-shell\s*\{[\s\S]*?inset:\s*0\s*!important/);
assert.doesNotMatch(css, /\.toolbar-shell\s*\{[\s\S]*?width:\s*0\s*!important/);
assert.doesNotMatch(css, /\.toolbar-shell\s*\{[\s\S]*?height:\s*0\s*!important/);
assert.match(css, /\.toolbar-shell\s*\{[\s\S]*?pointer-events:\s*none/);

// The status must participate in the right-side row instead of staying absolutely
// positioned by the legacy desktop toolbar CSS.
assert.match(css, /\.toolbar-status\s*\{[\s\S]*?position:\s*static\s*!important/);

console.log('Desktop floating toolbar visibility regression passed.');
