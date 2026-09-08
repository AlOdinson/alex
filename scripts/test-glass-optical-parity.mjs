import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const css = await readFile(new URL('../src/refractive-glass-lensing.css', import.meta.url), 'utf8');
const runtimeSource = await readFile(new URL('../src/refractive-glass-lensing.js', import.meta.url), 'utf8');

assert.match(runtimeSource, /const\s+MAX_SURFACE_DPR\s*=\s*MAX_CONTOUR_DPR\s*;/, 'Surface and contour sampling must use the same DPR so the center is not softer than the edge');
assert.doesNotMatch(runtimeSource, /isTouchSurfaceDevice/, 'Full-surface sampling must not be touch-only; desktop must use the same Canvas glass path as mobile');
assert.match(runtimeSource, /for\s*\(const\s+config\s+of\s+SURFACE_CONFIGS\)/, 'Surface samples must render on every device before the contour samples');

assert.match(css, /\.board-tool-dock,\s*\.dock-history-accessories\s*\{[\s\S]*?background:\s*transparent\s*!important;[\s\S]*?-webkit-backdrop-filter:\s*none\s*!important;[\s\S]*?backdrop-filter:\s*none\s*!important;/, 'The legacy full-area CSS glass must be globally inert so desktop does not keep a dirty 22-24px backdrop blur under the Canvas layers');
assert.match(css, /\.board-tool-dock\s*\{[\s\S]*?--refractive-sample-opacity:\s*0\.70;[\s\S]*?--refractive-sample-filter:\s*brightness\(1\.14\)\s+saturate\(1\.4\)\s+contrast\(1\.09\)\s+blur\(0\.22px\);/, 'Dock must define one optical profile shared by its center and contour');
assert.match(css, /\.dock-history-accessories\s*\{[\s\S]*?--refractive-sample-opacity:\s*0\.76;[\s\S]*?--refractive-sample-filter:\s*brightness\(1\.17\)\s+saturate\(1\.46\)\s+contrast\(1\.11\)\s+blur\(0\.18px\);/, 'Undo/redo must define one optical profile shared by its center and contour');
assert.match(css, /\.refractive-surface-sample,\s*\.refractive-contour-sample\s*\{[\s\S]*?opacity:\s*var\(--refractive-sample-opacity\);[\s\S]*?filter:\s*var\(--refractive-sample-filter\);/, 'Surface and contour layers must consume the exact same opacity and filter variables');
assert.doesNotMatch(css, /blur\(1\.35px\)/, 'Dock center must not retain the old dirty 1.35px blur');
assert.doesNotMatch(css, /blur\(1\.1px\)/, 'History center must not retain the old dirty 1.1px blur');

console.log('Glass center/contour optical parity regression passed.');
