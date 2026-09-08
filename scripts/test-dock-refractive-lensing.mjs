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
assert.equal(typeof runtime.computeContinuousContourSamplePoint, 'function', 'Contour runtime must expose one continuous rounded-contour reflection mapping');
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
  outerRadiusCss: 24,
  insetCss: 9,
  innerWidthCss: 300,
  innerHeightCss: 46,
});
assert.equal(dockInnerRadius, 15, '24px mobile dock corner inset by 9px must have a 15px inner radius');

const historyInnerRadius = runtime.computeParallelInsetRadiusCss({
  outerRadiusCss: 18,
  insetCss: 7,
  innerWidthCss: 56,
  innerHeightCss: 22,
});
assert.equal(historyInnerRadius, 11, '18px history capsule inset by 7px must have an 11px inner radius');

// For concentric quarter-circle corners, a true inward offset keeps every point
// exactly `inset` pixels away along the normal. Verify this at several angles.
for (const { outerRadius, innerRadius, inset } of [
  { outerRadius: 24, innerRadius: dockInnerRadius, inset: 9 },
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

// The new contour is one field of normals, not four rectangular mirror strips.
// Straight sections reflect orthogonally and the corner normal rotates smoothly.
const geometry = { width: 400, height: 60, outerRadius: 24, thickness: 9 };
const top = runtime.computeContinuousContourSamplePoint({ ...geometry, x: 200, y: 4 });
assert.ok(top?.inRing, 'Top point must belong to the continuous contour ring');
assert.ok(Math.abs(top.normalX) < 1e-9 && top.normalY < -0.999, 'Top contour normal must point vertically outward');
assert.ok(top.sampleY > 4, 'Top contour reflection must sample inward from the same continuous ring');

const right = runtime.computeContinuousContourSamplePoint({ ...geometry, x: 396, y: 30 });
assert.ok(right?.inRing, 'Right point must belong to the continuous contour ring');
assert.ok(right.normalX > 0.999 && Math.abs(right.normalY) < 1e-9, 'Right contour normal must point horizontally outward');
assert.ok(right.sampleX < 396, 'Right contour reflection must sample inward from the same continuous ring');

const cornerCenterX = geometry.width - geometry.outerRadius;
const cornerCenterY = geometry.outerRadius;
const cornerAngle = -Math.PI / 4;
const cornerRadius = geometry.outerRadius - 4;
const corner = runtime.computeContinuousContourSamplePoint({
  ...geometry,
  x: cornerCenterX + Math.cos(cornerAngle) * cornerRadius,
  y: cornerCenterY + Math.sin(cornerAngle) * cornerRadius,
});
assert.ok(corner?.inRing, 'Rounded corner point must belong to the same continuous contour ring');
assert.ok(corner.normalX > 0.6 && corner.normalY < -0.6, 'Corner normal must rotate diagonally instead of switching between separate side strips');
assert.ok(Math.abs(Math.hypot(corner.normalX, corner.normalY) - 1) < 1e-9, 'Continuous contour normal must remain normalized around the curve');

assert.match(runtimeSource, /\.lower-canvas/, 'Runtime must prefer Fabric lower-canvas as the real board image source');
assert.match(runtimeSource, /drawImage\(/, 'Runtime must copy real board pixels rather than relying on backdrop-filter imitation');
assert.match(runtimeSource, /refractive-contour-sample--dock/, 'Runtime must create one continuous contour sample for the main dock');
assert.match(runtimeSource, /refractive-contour-sample--history/, 'Runtime must create one continuous contour sample for the undo\/redo glass');
assert.match(runtimeSource, /className:\s*'refractive-contour-sample--dock'[\s\S]*thicknessCss:\s*9/, 'Dock refractive contour must use the 1.5x thicker 9px ring');
assert.match(runtimeSource, /className:\s*'refractive-contour-sample--history'[\s\S]*thicknessCss:\s*7/, 'History refractive contour must use the 1.5x thicker 7px ring');
assert.match(runtimeSource, /className:\s*'refractive-surface-sample--dock'[\s\S]*insetCss:\s*9/, 'Dock surface sample must start exactly inside the 9px contour instead of bleeding underneath it');
assert.match(runtimeSource, /className:\s*'refractive-surface-sample--history'[\s\S]*insetCss:\s*7/, 'History surface sample must start exactly inside the 7px contour instead of bleeding underneath it');
assert.match(runtimeSource, /computeContinuousContourSamplePoint/, 'Contour renderer must use one continuous normal-field mapping');
assert.match(runtimeSource, /getImageData\(/, 'Continuous contour renderer must read one sampled board image for curved normal-field reflection');
assert.match(runtimeSource, /putImageData\(/, 'Continuous contour renderer must write one unified reflected contour image');
assert.doesNotMatch(runtimeSource, /sourceDepthX/, 'Old left\/right strip sampling must be removed');
assert.doesNotMatch(runtimeSource, /sourceDepthY/, 'Old top\/bottom strip sampling must be removed');
assert.doesNotMatch(runtimeSource, /context\.scale\(1,\s*-1\)/, 'Contour must not be assembled from a separate vertically mirrored top\/bottom strip');
assert.doesNotMatch(runtimeSource, /context\.scale\(-1,\s*1\)/, 'Contour must not be assembled from a separate horizontally mirrored left\/right strip');
assert.match(runtimeSource, /globalCompositeOperation\s*=\s*['"]destination-in['"]/, 'Outer contour must be masked by Canvas geometry rather than relying only on CSS border-radius rasterization');
assert.match(runtimeSource, /traceRoundedRect\(context,\s*0,\s*0,\s*pixelWidth,\s*pixelHeight,\s*outerRadiusPx\)/, 'Outer contour must use the same Canvas rounded-rect path system as the inner contour');
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
assert.match(refractiveCss, /@supports \(-webkit-touch-callout:\s*none\)[\s\S]*refractive-surface-sample--dock,[\s\S]*refractive-contour-sample--dock\s*\{[\s\S]*opacity:\s*0\.84/, 'iOS dock center must reuse the approved clean contour opacity');
assert.match(refractiveCss, /@supports \(-webkit-touch-callout:\s*none\)[\s\S]*refractive-surface-sample--history,[\s\S]*refractive-contour-sample--history\s*\{[\s\S]*opacity:\s*0\.88/, 'iOS history center must reuse the approved clean contour opacity');
assert.match(refractiveCss, /@media \(max-width:\s*900px\)[\s\S]*refractive-surface-sample--dock,[\s\S]*refractive-contour-sample--dock\s*\{[\s\S]*opacity:\s*0\.82/, 'Phone dock center and contour must keep identical opacity');
assert.match(refractiveCss, /@media \(max-width:\s*900px\)[\s\S]*refractive-surface-sample--history,[\s\S]*refractive-contour-sample--history\s*\{[\s\S]*opacity:\s*0\.86/, 'Phone history center and contour must keep identical opacity');
assert.doesNotMatch(refractiveCss, /animation:/, 'Refractive contour must not add continuous CSS animation on iPad\/phone');
assert.doesNotMatch(refractiveCss, /\.dock-style-right-accessories/, 'Contour change must not touch the four right-side glass tiles');

console.log('Dock continuous-normal refractive contour regression passed.');
