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

assert.equal(typeof runtime.computeSurfaceSourceRect, 'function', 'Mobile glass runtime must expose full-surface source-rect math');
assert.equal(typeof runtime.computeParallelInsetRadiusCss, 'function', 'Contour runtime must expose exact parallel-inset geometry for regression coverage');
assert.ok(runtime.LENS_REFRESH_MS >= 100, 'Refractive sampling must be throttled to protect iPad/Pencil performance');

const sourceRect = { left: 0, top: 0, width: 1000, height: 800 };
const targetRect = { left: 100, top: 700, right: 500, bottom: 760, width: 400, height: 60 };
const surfaceSample = runtime.computeSurfaceSourceRect({
  sourceRect,
  sourceWidth: 2000,
  sourceHeight: 1600,
  targetRect,
  insetCss: 9,
});
assert.deepEqual(surfaceSample, { sx: 218, sy: 1418, sw: 764, sh: 84 }, 'Mobile dock center must sample only the area inside the 9px refractive contour');

const dockInnerRadius = runtime.computeParallelInsetRadiusCss({
  outerRadiusCss: 15,
  insetCss: 9,
  innerWidthCss: 300,
  innerHeightCss: 46,
});
assert.equal(dockInnerRadius, 6, '15px mobile dock corner inset by 9px must have a 6px inner radius');

const historyInnerRadius = runtime.computeParallelInsetRadiusCss({
  outerRadiusCss: 18,
  insetCss: 7,
  innerWidthCss: 56,
  innerHeightCss: 22,
});
assert.equal(historyInnerRadius, 11, '18px history capsule inset by 7px must have an 11px inner radius');

// For concentric quarter-circle corners, a true inward offset keeps every point
// exactly `inset` pixels away along the normal. Verify this at several angles,
// not just by checking the radius formula.
for (const { outerRadius, innerRadius, inset } of [
  { outerRadius: 15, innerRadius: dockInnerRadius, inset: 9 },
  { outerRadius: 18, innerRadius: historyInnerRadius, inset: 7 },
]) {
  for (const degrees of [0, 15, 30, 45, 60, 75, 90]) {
    const angle = (degrees * Math.PI) / 180;
    const outerX = outerRadius * Math.cos(angle);
    const outerY = outerRadius * Math.sin(angle);
    const innerX = innerRadius * Math.cos(angle);
    const innerY = innerRadius * Math.sin(angle);
    const distance = Math.hypot(outerX - innerX, outerY - innerY);
    assert.ok(Math.abs(distance - inset) < 1e-9, `Parallel corner offset must stay ${inset}px at ${degrees}°; got ${distance}`);
  }
}

assert.match(runtimeSource, /\.lower-canvas/, 'Runtime must prefer Fabric lower-canvas as the real board image source');
assert.match(runtimeSource, /drawImage\(/, 'Runtime must copy real board pixels rather than relying on backdrop-filter imitation');
assert.match(runtimeSource, /refractive-contour-sample--dock/, 'Runtime must create one continuous contour sample for the main dock');
assert.match(runtimeSource, /refractive-contour-sample--history/, 'Runtime must create one continuous contour sample for the undo\/redo glass');
assert.match(runtimeSource, /className:\s*'refractive-contour-sample--dock'[\s\S]*thicknessCss:\s*9/, 'Dock refractive contour must use the 1.5x thicker 9px ring');
assert.match(runtimeSource, /className:\s*'refractive-contour-sample--history'[\s\S]*thicknessCss:\s*7/, 'History refractive contour must use the 1.5x thicker 7px ring');
assert.match(runtimeSource, /className:\s*'refractive-surface-sample--dock'[\s\S]*insetCss:\s*9/, 'Dock surface sample must start exactly inside the 9px contour instead of bleeding underneath it');
assert.match(runtimeSource, /className:\s*'refractive-surface-sample--history'[\s\S]*insetCss:\s*7/, 'History surface sample must start exactly inside the 7px contour instead of bleeding underneath it');
assert.match(runtimeSource, /scale\(1,\s*-1\)/, 'Top and bottom contour sections must mirror the board vertically');
assert.match(runtimeSource, /scale\(-1,\s*1\)/, 'Left and right contour sections must mirror the board horizontally');
assert.match(runtimeSource, /globalCompositeOperation\s*=\s*['"]destination-out['"]/, 'Contour renderer must cut out the center so the edge has uniform thickness around the full perimeter');
assert.match(runtimeSource, /roundRect\(/, 'Contour renderer must preserve the rounded inner contour rather than only drawing top and bottom strips');
assert.match(runtimeSource, /outerRadiusCss\s*-\s*insetCss/, 'Exact parallel rounded-rect inset must reduce the corner radius by the same physical inset');
assert.match(runtimeSource, /canvas\.style\.borderRadius\s*=\s*`\$\{innerRadiusCss\}px`/, 'Mobile center canvas must use exactly the same rounded radius as the inner contour opening');
assert.match(runtimeSource, /canvas\.style\.clipPath\s*=\s*`inset\(0 round \$\{innerRadiusCss\}px\)`/, 'Mobile center canvas must be explicitly clipped to the same parallel inner contour so filter blur cannot create a rectangular plate');
assert.doesNotMatch(runtimeSource, /refractive-lens-sample--dock-top/, 'Old top-only dock strip must be removed once the full contour ring is active');
assert.doesNotMatch(runtimeSource, /refractive-lens-sample--history-top/, 'Old top-only history strip must be removed once the full contour ring is active');
assert.match(runtimeSource, /refractive-surface-sample--dock/, 'Runtime must preserve the full sampled surface for the mobile dock');
assert.match(runtimeSource, /refractive-surface-sample--history/, 'Runtime must preserve the full sampled surface for mobile undo\/redo glass');
assert.match(runtimeSource, /matchMedia\?\.\(['"]\(pointer:\s*coarse\)['"]\)/, 'Full-surface sampling must be limited to touch/coarse-pointer devices');
assert.match(runtimeSource, /maxTouchPoints/, 'iPad surface sampling must also survive desktop-like pointer reporting');
assert.match(runtimeSource, /document\.hidden/, 'Runtime must stop sampling while the tab is hidden');

assert.match(refractiveCss, /\.refractive-contour-sample\s*\{/, 'The continuous rounded edge must have one dedicated contour canvas layer');
assert.match(refractiveCss, /\.refractive-surface-sample\s*\{/, 'Mobile full-surface samples must keep their dedicated transparent glass layer');
assert.match(refractiveCss, /\.refractive-contour-sample--dock\s*\{[\s\S]*opacity:/, 'Dock contour must receive its own optical treatment');
assert.match(refractiveCss, /\.refractive-contour-sample--history\s*\{[\s\S]*opacity:/, 'History contour must receive its own optical treatment');
assert.doesNotMatch(refractiveCss, /refractive-lens-sample--dock-top/, 'CSS must no longer render only a top dock edge');
assert.doesNotMatch(refractiveCss, /refractive-lens-sample--dock-bottom/, 'CSS must no longer render only a bottom dock edge');
assert.match(refractiveCss, /@supports \(-webkit-touch-callout:\s*none\)/, 'iPad\/iPhone must retain an explicit sampled-canvas enhancement');
assert.match(refractiveCss, /@media \(max-width:\s*900px\)/, 'Phone viewports must keep sampled refraction visible');
assert.match(refractiveCss, /refractive-surface-sample--dock[\s\S]*opacity:\s*0\.72/, 'Mobile dock surface sample must stay visibly transparent rather than milky');
assert.match(refractiveCss, /refractive-surface-sample--history[\s\S]*opacity:\s*0\.76/, 'Mobile history surface sample must keep showing board content through the glass');
assert.doesNotMatch(refractiveCss, /animation:/, 'Refractive contour must not add continuous CSS animation on iPad\/phone');
assert.doesNotMatch(refractiveCss, /\.dock-style-right-accessories/, 'Contour change must not touch the four right-side glass tiles');

console.log('Dock exact-parallel refractive contour regression passed.');
