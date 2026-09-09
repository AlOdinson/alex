import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const mainEntry = await readFile(new URL('../src/main.jsx', import.meta.url), 'utf8');
const css = await readFile(new URL('../src/refractive-glass-lensing.css', import.meta.url), 'utf8');
const desktopRuntime = await readFile(new URL('../src/refractive-glass-desktop-surface.js', import.meta.url), 'utf8');

assert.ok(
  mainEntry.lastIndexOf("import './refractive-glass-desktop-surface.js';") > mainEntry.lastIndexOf("import './refractive-glass-lensing.js';"),
  'Desktop center sampler must load after the existing contour runtime'
);
assert.match(desktopRuntime, /const\s+MAX_DESKTOP_SURFACE_DPR\s*=\s*2\s*;/, 'Desktop center must sample at the same 2x cap as the contour');
assert.match(desktopRuntime, /isTouchSurfaceDevice/, 'Desktop sampler must explicitly avoid racing the existing touch surface sampler');
assert.match(desktopRuntime, /refractive-surface-sample--dock/, 'Desktop sampler must render the dock center into the same surface class');
assert.match(desktopRuntime, /refractive-surface-sample--history/, 'Desktop sampler must render the history center into the same surface class');
assert.match(desktopRuntime, /computeSurfaceSourceRect/, 'Desktop sampler must copy the real board pixels under the glass');
assert.match(desktopRuntime, /maskRoundedSurface/, 'Desktop center must keep the same rounded inner geometry');

assert.match(css, /\.board-tool-dock,\s*\.dock-history-accessories\s*\{[\s\S]*?background:\s*transparent\s*!important;[\s\S]*?-webkit-backdrop-filter:\s*none\s*!important;[\s\S]*?backdrop-filter:\s*none\s*!important;/, 'Legacy full-area CSS glass must be globally inert, including desktop');
assert.match(css, /\.board-tool-dock\s*\{[\s\S]*?--refractive-sample-opacity:\s*0\.84;[\s\S]*?--refractive-sample-filter:\s*brightness\(1\.18\)\s+saturate\(1\.5\)\s+contrast\(1\.12\)\s+blur\(0\.16px\);/, 'Desktop dock must use the same opaque sampled-glass profile as iPad');
assert.match(css, /\.dock-history-accessories\s*\{[\s\S]*?--refractive-sample-opacity:\s*0\.88;[\s\S]*?--refractive-sample-filter:\s*brightness\(1\.2\)\s+saturate\(1\.54\)\s+contrast\(1\.13\)\s+blur\(0\.14px\);/, 'Desktop history capsule must use the same opaque sampled-glass profile as iPad');
assert.match(css, /\.refractive-surface-sample,\s*\.refractive-contour-sample\s*\{[\s\S]*?opacity:\s*var\(--refractive-sample-opacity\);[\s\S]*?filter:\s*var\(--refractive-sample-filter\);/, 'Surface and contour must consume the exact same opacity and filter');
assert.doesNotMatch(css, /--refractive-sample-opacity:\s*0\.70|--refractive-sample-opacity:\s*0\.76/, 'Desktop must not leave enough underlying board visible to create a second text/grid layer');
assert.doesNotMatch(css, /blur\(1\.35px\)|blur\(1\.1px\)/, 'Old dirty center blur must be removed');

console.log('Glass center/contour optical parity regression passed.');
