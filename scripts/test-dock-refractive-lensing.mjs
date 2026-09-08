import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const mainEntry = await readFile(new URL('../src/main.jsx', import.meta.url), 'utf8');
const refractiveCss = await readFile(new URL('../src/refractive-glass-lensing.css', import.meta.url), 'utf8');
const stylesCss = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');
const historyCss = await readFile(new URL('../src/dock-history-icons.css', import.meta.url), 'utf8');
const runtimeUrl = new URL('../src/refractive-glass-lensing.js', import.meta.url);
const runtimeSource = await readFile(runtimeUrl, 'utf8');
const runtime = await import(`${runtimeUrl.href}?test=${Date.now()}`);

assert.ok(
  mainEntry.lastIndexOf("import './refractive-glass-lensing.js';") > mainEntry.lastIndexOf("import './refractive-glass-lensing.css';"),
  'Canvas-backed refractive runtime must load after the visual glass CSS'
);

assert.equal(typeof runtime.computeSurfaceSourceRect, 'function', 'Mobile glass runtime must expose full-surface source-rect math');
assert.equal(typeof runtime.computeParallelInsetRoundedRect, 'function', 'Runtime must expose exact parallel rounded-rect inset geometry');
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

// Keep these fixtures tied to the actual UI geometry so the offset test matches
// what users see on iPad/phone and in the compact undo/redo capsule.
assert.match(stylesCss, /@media \(max-width:\s*760px\)[\s\S]*\.board-tool-dock\s*\{[\s\S]*padding:\s*5px;[\s\S]*border-radius:\s*15px;/, 'Mobile dock fixture expects the real 15px outer radius');
assert.match(stylesCss, /@media \(max-width:\s*760px\)[\s\S]*\.board-tool-dock \.dock-tool-button\s*\{[\s\S]*height:\s*52px;/, 'Mobile dock fixture expects the real 52px tool height');
assert.match(historyCss, /\.dock-history-accessories\s*\{[\s\S]*padding:\s*3px 5px[\s\S]*border-radius:\s*18px/, 'History fixture expects the real 18px capsule radius');
assert.match(historyCss, /\.dock-history-button\s*\{[\s\S]*height:\s*28px/, 'History fixture expects the real 28px button height');

function assertExactParallelInset({ width, height, radius, inset, label }) {
  const inner = runtime.computeParallelInsetRoundedRect({ width, height, radius, inset });
  assert.deepEqual(
    inner,
    {
      x: inset,
      y: inset,
      width: width - inset * 2,
      height: height - inset * 2,
      radius: Math.max(0, radius - inset),
    },
    `${label}: inner rounded rect must be the mathematical inset of the outer rounded rect`
  );

  // For a true parallel circular offset the corner arcs are concentric: moving
  // the inner rect by inset and reducing the radius by the same inset leaves
  // the arc centre unchanged. That makes the gap exactly inset at every angle.
  const outerCenter = { x: radius, y: radius };
  const innerCenter = { x: inner.x + inner.radius, y: inner.y + inner.radius };
  assert.ok(Math.abs(outerCenter.x - innerCenter.x) < 1e-9, `${label}: corner arc centres must align on X`);
  assert.ok(Math.abs(outerCenter.y - innerCenter.y) < 1e-9, `${label}: corner arc centres must align on Y`);

  for (const degrees of [0, 15, 30, 45, 60, 75, 90]) {
    const radians = degrees * Math.PI / 180;
    const outerPoint = {
      x: outerCenter.x + Math.cos(radians) * radius,
      y: outerCenter.y + Math.sin(radians) * radius,
    };
    const innerPoint = {
      x: innerCenter.x + Math.cos(radians) * inner.radius,
      y: innerCenter.y + Math.sin(radians) * inner.radius,
    };
    const distance = Math.hypot(outerPoint.x - innerPoint.x, outerPoint.y - innerPoint.y);
    assert.ok(Math.abs(distance - inset) < 1e-9, `${label}: curved gap at ${degrees}° must equal ${inset}px, got ${distance}`);
  }
}

// Real rendered heights: mobile dock = 52 + 5*2 + 1*2 = 64px;
// desktop dock = 58 + 7*2 + 1*2 = 74px; history = 28 + 3*2 + 1*2 = 36px.
assertExactParallelInset({ width: 520, height: 64, radius: 15, inset: 9, label: 'mobile dock' });
assertExactParallelInset({ width: 600, height: 74, radius: 18, inset: 9, label: 'desktop dock' });
assertExactParallelInset({ width: 68, height: 36, radius: 18, inset: 7, label: 'history capsule' });

assert.match(runtimeSource, /\.lower-canvas/, 'Runtime must prefer Fabric lower-canvas as the real board image source');
assert.match(runtimeSource, /drawImage\(/, 'Runtime must copy real board pixels rather than relying on backdrop-filter imitation');
assert.match(runtimeSource, /refractive-contour-sample--dock/, 'Runtime must create one continuous contour sample for the main dock');
assert.match(runtimeSource, /refractive-contour-sample--history/, 'Runtime must create one continuous contour sample for the undo\/redo glass');
assert.match(runtimeSource, /className:\s*'refractive-contour-sample--dock'[\s\S]*thicknessCss:\s*9/, 'Dock refractive contour must use the 1.5x thicker 9px ring');
assert.match(runtimeSource, /className:\s*'refractive-contour-sample--history'[\s\S]*thicknessCss:\s*7/, 'History refractive contour must use the 1.5x thicker 7px ring');
assert.match(runtimeSource, /className:\s*'refractive-surface-sample--dock'[\s\S]*insetCss:\s*9/, 'Dock surface sample must start exactly inside the 9px contour instead of bleeding underneath it');
assert.match(runtimeSource, /className:\s*'refractive-surface-sample--history'[\s\S]*insetCss:\s*7/, 'History surface sample must start exactly inside the 7px contour instead of bleeding underneath it');
assert.match(runtimeSource, /CONTINUOUS_RING_BASE_ALPHA\s*=\s*0\.[6-9]/, 'Rounded corner crescents must receive a strong continuous sampled base, not a faint fallback');
assert.doesNotMatch(runtimeSource, /globalAlpha\s*=\s*0\.14/, 'The old 14% corner fallback must be removed because it leaves the visible contour rectangular');
assert.match(runtimeSource, /scale\(1,\s*-1\)/, 'Top and bottom contour sections must retain vertical mirrored refraction');
assert.match(runtimeSource, /scale\(-1,\s*1\)/, 'Left and right contour sections must retain horizontal mirrored refraction');
assert.match(runtimeSource, /globalCompositeOperation\s*=\s*['"]destination-out['"]/, 'Contour renderer must cut out the center of the continuous sampled ring');
assert.match(runtimeSource, /roundRect\(/, 'Contour renderer must preserve a rounded inner contour');
assert.match(runtimeSource, /canvas\.style\.borderRadius\s*=\s*`\$\{innerRadiusCss\}px`/, 'Mobile center canvas must use exactly the same radius as the parallel inner contour opening');
assert.match(runtimeSource, /canvas\.style\.clipPath\s*=\s*`inset\(0 round \$\{innerRadiusCss\}px\)`/, 'Mobile center canvas must be explicitly clipped to the parallel inner contour');
assert.doesNotMatch(runtimeSource, /refractive-lens-sample--dock-top/, 'Old top-only dock strip must remain removed');
assert.doesNotMatch(runtimeSource, /refractive-lens-sample--history-top/, 'Old top-only history strip must remain removed');
assert.match(runtimeSource, /matchMedia\?\.\(['"]\(pointer:\s*coarse\)['"]\)/, 'Full-surface sampling must be limited to touch/coarse-pointer devices');
assert.match(runtimeSource, /maxTouchPoints/, 'iPad surface sampling must also survive desktop-like pointer reporting');
assert.match(runtimeSource, /document\.hidden/, 'Runtime must stop sampling while the tab is hidden');

assert.match(refractiveCss, /\.refractive-contour-sample\s*\{/, 'The continuous rounded edge must have one dedicated contour canvas layer');
assert.match(refractiveCss, /\.refractive-surface-sample\s*\{/, 'Mobile full-surface samples must keep their dedicated transparent glass layer');
assert.match(refractiveCss, /@supports \(-webkit-touch-callout:\s*none\)/, 'iPad\/iPhone must retain an explicit sampled-canvas enhancement');
assert.match(refractiveCss, /@media \(max-width:\s*900px\)/, 'Phone viewports must keep sampled refraction visible');
assert.match(refractiveCss, /refractive-surface-sample--dock[\s\S]*opacity:\s*0\.72/, 'Mobile dock surface sample must stay visibly transparent rather than milky');
assert.match(refractiveCss, /refractive-surface-sample--history[\s\S]*opacity:\s*0\.76/, 'Mobile history surface sample must keep showing board content through the glass');
assert.doesNotMatch(refractiveCss, /animation:/, 'Refractive contour must not add continuous CSS animation on iPad\/phone');
assert.doesNotMatch(refractiveCss, /\.dock-style-right-accessories/, 'Contour change must not touch the four right-side glass tiles');

console.log('Dock exact-parallel full-contour refractive regression passed.');
