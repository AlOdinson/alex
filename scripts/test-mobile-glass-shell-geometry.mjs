import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const refractiveCss = await readFile(new URL('../src/refractive-glass-lensing.css', import.meta.url), 'utf8');
const runtimeSource = await readFile(new URL('../src/refractive-glass-lensing.js', import.meta.url), 'utf8');

function extractBalancedBlock(source, marker) {
  const markerIndex = source.indexOf(marker);
  assert.notEqual(markerIndex, -1, `Missing block marker: ${marker}`);
  const openIndex = source.indexOf('{', markerIndex + marker.length);
  assert.notEqual(openIndex, -1, `Missing opening brace for: ${marker}`);
  let depth = 0;
  for (let i = openIndex; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(openIndex + 1, i);
    }
  }
  throw new Error(`Unclosed block for: ${marker}`);
}

function assertTransparentShell(block, selector, label) {
  const selectorBlock = extractBalancedBlock(block, selector);
  assert.match(selectorBlock, /background:\s*transparent\s*!important/, `${label} shell must not paint a full-area background under the sampled glass`);
  assert.match(selectorBlock, /border-color:\s*transparent\s*!important/, `${label} shell border must not create a competing contour`);
  assert.match(selectorBlock, /-webkit-backdrop-filter:\s*none\s*!important/, `${label} shell must not create a full-area WebKit backdrop plate`);
  assert.match(selectorBlock, /backdrop-filter:\s*none\s*!important/, `${label} shell must not create a full-area backdrop plate`);
  assert.doesNotMatch(selectorBlock, /box-shadow:[\s\S]*?inset/, `${label} mobile shell must not draw inset shadows that look like a second inner plate`);
}

function assertRoundedGeometry(block, label) {
  const dockBlock = extractBalancedBlock(block, '.board-tool-dock');
  const historyBlock = extractBalancedBlock(block, '.dock-history-accessories');
  assert.match(dockBlock, /border-radius:\s*24px\s*!important/, `${label} dock must use a 24px outer radius so the 9px inset leaves a clearly rounded 15px inner contour`);
  assert.match(historyBlock, /border-radius:\s*999px\s*!important/, `${label} undo/redo must force capsule geometry so runtime clamps the outer radius to half the actual height`);
}

const iosBlock = extractBalancedBlock(refractiveCss, '@supports (-webkit-touch-callout: none)');
assertTransparentShell(iosBlock, '.board-tool-dock', 'iOS dock');
assertTransparentShell(iosBlock, '.dock-history-accessories', 'iOS undo/redo');
assertRoundedGeometry(iosBlock, 'iOS');

const phoneBlock = extractBalancedBlock(refractiveCss, '@media (max-width: 900px)');
assertTransparentShell(phoneBlock, '.board-tool-dock', 'Phone dock');
assertTransparentShell(phoneBlock, '.dock-history-accessories', 'Phone undo/redo');
assertRoundedGeometry(phoneBlock, 'Phone');

assert.match(runtimeSource, /function\s+maskRoundedSurface\s*\(/, 'Sampled center must have a dedicated Canvas rounded mask');
assert.match(runtimeSource, /globalCompositeOperation\s*=\s*['"]destination-in['"]/, 'Sampled center pixels must be physically clipped by Canvas composition');
assert.match(runtimeSource, /maskRoundedSurface\(context,\s*pixelWidth,\s*pixelHeight,\s*innerRadiusPx\)/, 'Surface renderer must apply the same inner rounded geometry after drawing sampled board pixels');
assert.match(runtimeSource, /const\s+fallback\s*=\s*Math\.min\(targetRect\.width,\s*targetRect\.height\)\s*\/\s*2/, 'Runtime must cap capsule radius at half the actual element height/width');
assert.match(runtimeSource, /return\s+clamp\(parsed,\s*0,\s*fallback\)/, 'A 999px CSS capsule radius must be clamped to the actual half-height before inset math');

console.log('Mobile glass shell geometry regression passed.');
