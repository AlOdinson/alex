import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const mainEntry = await readFile(new URL('../src/main.jsx', import.meta.url), 'utf8');
const refractiveCss = await readFile(new URL('../src/refractive-glass-lensing.css', import.meta.url), 'utf8');
const runtimeUrl = new URL('../src/refractive-glass-lensing.js', import.meta.url);
const runtimeSource = await readFile(runtimeUrl, 'utf8');
const runtime = await import(`${runtimeUrl.href}?test=${Date.now()}`);

assert.ok(
  mainEntry.lastIndexOf("import './refractive-glass-lensing.js';") > mainEntry.lastIndexOf("import './refractive-glass-lensing.css';"),
  'Canvas-backed refractive runtime must load after the visual glass CSS'
);

assert.equal(typeof runtime.computeLensSourceRect, 'function', 'Refractive runtime must expose its source-rect math for regression coverage');
assert.equal(typeof runtime.computeSurfaceSourceRect, 'function', 'Mobile glass runtime must expose full-surface source-rect math');
assert.ok(runtime.LENS_REFRESH_MS >= 100, 'Refractive sampling must be throttled to protect iPad/Pencil performance');

const sourceRect = { left: 0, top: 0, width: 1000, height: 800 };
const targetRect = { left: 100, top: 700, right: 500, bottom: 760, width: 400, height: 60 };
const topSample = runtime.computeLensSourceRect({
  sourceRect,
  sourceWidth: 2000,
  sourceHeight: 1600,
  targetRect,
  insetCss: 12,
  edge: 'top',
  lipHeightCss: 7,
  sampleDepthCss: 14,
});
assert.deepEqual(topSample, { sx: 224, sy: 1400, sw: 752, sh: 28 }, 'Top dock lip must sample the actual board pixels directly behind it');

const bottomSample = runtime.computeLensSourceRect({
  sourceRect,
  sourceWidth: 2000,
  sourceHeight: 1600,
  targetRect,
  insetCss: 16,
  edge: 'bottom',
  lipHeightCss: 5,
  sampleDepthCss: 12,
});
assert.deepEqual(bottomSample, { sx: 232, sy: 1496, sw: 736, sh: 24 }, 'Bottom dock lip must sample the actual board pixels directly behind it');

const surfaceSample = runtime.computeSurfaceSourceRect({
  sourceRect,
  sourceWidth: 2000,
  sourceHeight: 1600,
  targetRect,
  insetCss: 2,
});
assert.deepEqual(surfaceSample, { sx: 204, sy: 1404, sw: 792, sh: 112 }, 'Full mobile glass surface must sample the actual board area behind the dock');

assert.match(runtimeSource, /\.lower-canvas/, 'Runtime must prefer Fabric lower-canvas as the real board image source');
assert.match(runtimeSource, /drawImage\(/, 'Runtime must copy real board pixels rather than relying on backdrop-filter imitation');
assert.match(runtimeSource, /scale\(1,\s*-1\)/, 'Copied board strip must be mirrored vertically for the lens reflection');
assert.match(runtimeSource, /refractive-lens-sample--dock-top/, 'Runtime must create a real top sample for the main dock');
assert.match(runtimeSource, /refractive-lens-sample--history-top/, 'Runtime must create a real sample for the undo\/redo glass');
assert.match(runtimeSource, /refractive-surface-sample--dock/, 'Runtime must create a full sampled surface for the mobile dock');
assert.match(runtimeSource, /refractive-surface-sample--history/, 'Runtime must create a full sampled surface for mobile undo\/redo glass');
assert.match(runtimeSource, /matchMedia\?\.\(['"]\(pointer:\s*coarse\)['"]\)/, 'Full-surface sampling must be limited to touch/coarse-pointer devices');
assert.match(runtimeSource, /maxTouchPoints/, 'iPad surface sampling must also survive desktop-like pointer reporting');
assert.match(runtimeSource, /document\.hidden/, 'Runtime must stop sampling while the tab is hidden');

assert.match(refractiveCss, /\.refractive-lens-sample\s*\{/, 'Real sampled canvas strips must have a dedicated visual layer');
assert.match(refractiveCss, /\.refractive-surface-sample\s*\{/, 'Mobile full-surface samples must have a dedicated transparent glass layer');
assert.match(refractiveCss, /filter:\s*brightness\(/, 'Sampled pixels must receive a restrained optical glass treatment');
assert.match(refractiveCss, /@supports \(-webkit-touch-callout:\s*none\)/, 'iPad\/iPhone must receive an explicit sampled-canvas enhancement');
assert.match(refractiveCss, /@media \(max-width:\s*900px\)/, 'Phone viewports must keep sampled refraction visible');
assert.match(refractiveCss, /refractive-surface-sample--dock[\s\S]*opacity:\s*0\.72/, 'Mobile dock surface sample must be visibly transparent rather than milky');
assert.match(refractiveCss, /refractive-surface-sample--history[\s\S]*opacity:\s*0\.76/, 'Mobile history surface sample must visibly show board content through the glass');
assert.doesNotMatch(refractiveCss, /animation:/, 'Refractive lensing must not add continuous CSS animation on iPad\/phone');
assert.doesNotMatch(refractiveCss, /\.dock-style-right-accessories/, 'Refractive lensing change must not touch the four right-side glass tiles');

console.log('Dock refractive lensing regression passed.');
