import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const accessoryCss = await readFile(new URL('../src/dock-style-accessories.css', import.meta.url), 'utf8');
const historyCss = await readFile(new URL('../src/dock-history-icons.css', import.meta.url), 'utf8');
const mobileCss = await readFile(new URL('../src/mobile-premium-glass-fallback.css', import.meta.url), 'utf8');
const mainEntry = await readFile(new URL('../src/main.jsx', import.meta.url), 'utf8');

const desktopDock = accessoryCss.match(/\.board-tool-dock\s*\{([\s\S]*?)\}/)?.[1] ?? '';
const desktopHistory = historyCss.match(/\.dock-history-accessories\s*\{([\s\S]*?)\}/)?.[1] ?? '';
const desktopTiles = accessoryCss.match(/\.dock-style-eyedropper-button,\s*\.dock-style-preset-button\s*\{([\s\S]*?)\}/)?.[1] ?? '';

assert.match(desktopDock, /rgba\(255, 255, 255, 0\.46\)/, 'Desktop dock must keep the translucent white-glass base');
assert.match(desktopDock, /backdrop-filter:\s*blur\(22px\)/, 'Desktop dock must keep its matte blur');
assert.match(desktopHistory, /rgba\(255, 255, 255, 0\.34\)/, 'Desktop history capsule must keep its translucent body');
assert.match(desktopHistory, /backdrop-filter:\s*blur\(24px\)/, 'Desktop history capsule must keep premium blur');
assert.match(desktopTiles, /rgba\(255, 255, 255, 0\.24\)/, 'Desktop right tiles must keep their transparent glass body');
assert.match(desktopTiles, /inset 0 1px 0 rgba\(255, 255, 255, 0\.82\)/, 'Desktop right tiles must keep their convex/specular depth');

assert.match(mobileCss, /@supports \(-webkit-touch-callout:\s*none\)/, 'iPad/iPhone parity must not depend on pointer reporting');
assert.match(mobileCss, /@media \(max-width:\s*900px\)/, 'Phone parity must cover narrow non-iOS mobile browsers');

const count = (needle) => mobileCss.split(needle).length - 1;
assert.ok(count('rgba(255, 255, 255, 0.46)') >= 2, 'iOS and phone dock overrides must reuse the exact desktop glass opacity');
assert.ok(count('blur(22px) saturate(175%) brightness(106%) contrast(101%)') >= 4, 'Mobile dock must reuse the exact desktop matte filter in both WebKit and phone paths');
assert.ok(count('rgba(255, 255, 255, 0.34)') >= 2, 'iOS and phone history capsule must reuse the exact desktop body opacity');
assert.ok(count('blur(24px) saturate(190%) brightness(105%) contrast(102%)') >= 4, 'Mobile history capsule must reuse the exact desktop premium filter');
assert.ok(count('rgba(255, 255, 255, 0.24)') >= 2, 'iOS and phone right tiles must reuse the exact desktop transparent tile body');
assert.ok(count('blur(18px) saturate(190%) brightness(104%) contrast(102%)') >= 4, 'Mobile right tiles must reuse the exact desktop glass filter');
assert.ok(count('opacity: 0.82') >= 2, 'Mobile tiles must reuse the desktop static specular opacity');

assert.doesNotMatch(mobileCss, /background-color:\s*rgba\(255, 255, 255, 0\.18\)/, 'Mobile must not add the old opaque white backing under the dock gradients');
assert.doesNotMatch(mobileCss, /background-color:\s*rgba\(240, 248, 255, 0\.10\)/, 'Mobile must not add a separate history backing color');
assert.doesNotMatch(mobileCss, /background-color:\s*rgba\(239, 247, 255, 0\.05\)/, 'Mobile must not add a separate right-tile backing color');
assert.doesNotMatch(mobileCss, /\.dock-style-preset-fill\s*\{/, 'Mobile must not alter preset color opacity; preset fill must behave exactly like desktop');
assert.doesNotMatch(mobileCss, /opacity:\s*0\.68/, 'Mobile must not flatten preset colors with a special opacity layer');

assert.ok(
  mainEntry.lastIndexOf("import './refractive-glass-lensing.css';") > mainEntry.lastIndexOf("import './mobile-premium-glass-fallback.css';"),
  'Working mirrored refractive edge must continue loading after material parity overrides'
);

console.log('Mobile glass parity regression passed.');
