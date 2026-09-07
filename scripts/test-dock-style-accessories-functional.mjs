import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const enhancerSource = await readFile(new URL('../src/dock-style-accessories.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../src/dock-style-accessories.css', import.meta.url), 'utf8');

assert.match(enhancerSource, /function dispatchHistoryShortcut/);
assert.match(enhancerSource, /new KeyboardEvent\('keydown'/);
assert.match(enhancerSource, /metaKey:\s*true/);
assert.match(enhancerSource, /window\.dispatchEvent\(event\)/);
assert.match(enhancerSource, /function drawingSourceRoot/);
assert.match(enhancerSource, /function selectionSourceRoot/);
assert.match(enhancerSource, /function syncRightAccessories\(shell, accessoriesVisible,[\s\S]*?shell\.hidden\s*=\s*!accessoriesVisible/);
assert.match(enhancerSource, /function ensureSelectionFloatingProxy/);
assert.match(enhancerSource, /selection-floating-proxy/);
assert.match(enhancerSource, /syncSelectionFloatingProxy/);
assert.match(enhancerSource, /setReactInputValue/);
assert.doesNotMatch(enhancerSource, /DRAW_TOOL_LABELS/);
assert.doesNotMatch(enhancerSource, /SELECT_TOOL_LABEL/);
assert.doesNotMatch(enhancerSource, /dock-history-source/);

assert.match(css, /\.dock-style-right-accessories\[hidden\][\s\S]*?display:\s*none/);
assert.match(css, /\.selection-floating-proxy\s*\{/);
assert.match(css, /\.selected-style-controls\.dock-selection-source\s*\{[\s\S]*?display:\s*none/);
assert.doesNotMatch(css, /\.dock-history-source\s*\{/);

console.log('Functional dock accessory wiring contract passed.');
