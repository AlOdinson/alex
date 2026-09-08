import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const mainEntry = await readFile(new URL('../src/main.jsx', import.meta.url), 'utf8');
const refractiveCss = await readFile(new URL('../src/refractive-glass-lensing.css', import.meta.url), 'utf8');

assert.ok(
  mainEntry.lastIndexOf("import './refractive-glass-lensing.css';") > mainEntry.lastIndexOf("import './mobile-premium-glass-fallback.css';"),
  'Refractive lensing CSS must load last so mobile/WebKit fallbacks cannot flatten the effect'
);

const dockTopLip = refractiveCss.match(/\.board-tool-dock::before\s*\{([\s\S]*?)\}/)?.[1] ?? '';
assert.match(dockTopLip, /height:\s*7px/, 'Bottom dock top refractive lip must stay narrow rather than becoming a second panel');
assert.match(dockTopLip, /scaleY\(-1\)/, 'Bottom dock top lip must use a mirrored lens transform');
assert.match(dockTopLip, /-webkit-backdrop-filter:/, 'Bottom dock top lip must have a WebKit backdrop optical pass');
assert.match(dockTopLip, /brightness\(112%\)/, 'Bottom dock top lip must brighten refracted content like a glass edge');

const dockBottomLip = refractiveCss.match(/\.board-tool-dock::after\s*\{([\s\S]*?)\}/)?.[1] ?? '';
assert.match(dockBottomLip, /height:\s*5px/, 'Bottom dock lower refractive lip must remain a thin optical edge');
assert.match(dockBottomLip, /scaleY\(-1\)/, 'Bottom dock lower lip must mirror the passing backdrop subtly');
assert.match(dockBottomLip, /opacity:\s*0\.48/, 'Bottom dock lower refraction must remain restrained');

const historyTopLip = refractiveCss.match(/\.dock-history-accessories::before\s*\{([\s\S]*?)\}/)?.[1] ?? '';
assert.match(historyTopLip, /height:\s*5px/, 'Undo/redo glass may use only a narrow top lens strip, not a second capsule');
assert.match(historyTopLip, /scaleY\(-1\)/, 'Undo/redo top edge must refract/mirror the backdrop');
assert.doesNotMatch(historyTopLip, /inset:\s*0/, 'Undo/redo refractive strip must never become a full-size inner backing');

const historyBottomLip = refractiveCss.match(/\.dock-history-accessories::after\s*\{([\s\S]*?)\}/)?.[1] ?? '';
assert.match(historyBottomLip, /height:\s*4px/, 'Undo/redo lower edge must remain a narrow lens strip');
assert.match(historyBottomLip, /backdrop-filter:/, 'Undo/redo lower edge must carry its own subtle optical filtering');

assert.match(refractiveCss, /@supports \(-webkit-touch-callout:\s*none\)/, 'iPad/iPhone must receive an explicit refractive edge enhancement');
assert.match(refractiveCss, /@media \(max-width:\s*900px\)/, 'Phone viewports must keep the refractive edge treatment');
assert.doesNotMatch(refractiveCss, /animation:/, 'Refractive lensing must not add continuous animation on iPad/phone');
assert.doesNotMatch(refractiveCss, /\.dock-style-right-accessories/, 'Refractive lensing change must not touch the four right-side glass tiles');

console.log('Dock refractive lensing regression passed.');
