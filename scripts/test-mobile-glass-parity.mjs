import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const accessoryCss = await readFile(new URL('../src/dock-style-accessories.css', import.meta.url), 'utf8');
const historyCss = await readFile(new URL('../src/dock-history-icons.css', import.meta.url), 'utf8');
const mobileCss = await readFile(new URL('../src/mobile-premium-glass-fallback.css', import.meta.url), 'utf8');
const mainEntry = await readFile(new URL('../src/main.jsx', import.meta.url), 'utf8');

const touchMarker = '@media (hover: none), (pointer: coarse), (any-pointer: coarse)';
const accessoryTouchStart = accessoryCss.indexOf(touchMarker);
const accessoryMobileStart = accessoryCss.indexOf('@media (max-width: 760px)', accessoryTouchStart);
const accessoryTouchBlock = accessoryCss.slice(accessoryTouchStart, accessoryMobileStart === -1 ? undefined : accessoryMobileStart);

const historyTouchStart = historyCss.indexOf(touchMarker);
const historyMobileStart = historyCss.indexOf('@media (max-width: 760px)', historyTouchStart);
const historyTouchBlock = historyCss.slice(historyTouchStart, historyMobileStart === -1 ? undefined : historyMobileStart);

assert.ok(accessoryTouchStart >= 0, 'Accessory CSS must keep a touch interaction block');
assert.ok(historyTouchStart >= 0, 'History CSS must keep a touch interaction block');

assert.doesNotMatch(accessoryTouchBlock, /\.board-tool-dock\s*\{/, 'Touch devices must inherit the exact desktop dock material instead of overriding it');
assert.doesNotMatch(accessoryTouchBlock, /\.dock-style-eyedropper-button,\s*\.dock-style-preset-button\s*\{/, 'Touch devices must inherit the exact desktop glass-tile body material');
assert.doesNotMatch(historyTouchBlock, /\.dock-history-accessories\s*\{/, 'Touch devices must inherit the exact desktop undo/redo glass capsule material');

assert.doesNotMatch(mobileCss, /\.board-tool-dock\s*\{/, 'Last-loaded mobile fallback must not replace the desktop dock material');
assert.doesNotMatch(mobileCss, /\.dock-history-accessories\s*\{/, 'Last-loaded mobile fallback must not replace the desktop history material');
assert.doesNotMatch(mobileCss, /\.dock-style-eyedropper-button/, 'Last-loaded mobile fallback must not replace the desktop right-tile material');
assert.doesNotMatch(mobileCss, /\.dock-style-preset-button/, 'Last-loaded mobile fallback must not replace the desktop preset-tile material');
assert.doesNotMatch(mobileCss, /\.dock-style-preset-fill/, 'Last-loaded mobile fallback must not change preset color opacity on mobile');

const desktopDock = accessoryCss.match(/\.board-tool-dock\s*\{([\s\S]*?)\}/)?.[1] ?? '';
assert.match(desktopDock, /rgba\(255, 255, 255, 0\.46\)/, 'Shared dock material must keep the desktop translucent white-glass base');
assert.match(desktopDock, /backdrop-filter:\s*blur\(22px\)/, 'Shared dock material must keep desktop matte blur');

const desktopHistory = historyCss.match(/\.dock-history-accessories\s*\{([\s\S]*?)\}/)?.[1] ?? '';
assert.match(desktopHistory, /rgba\(255, 255, 255, 0\.34\)/, 'Shared history capsule must keep the desktop translucent glass body');
assert.match(desktopHistory, /backdrop-filter:\s*blur\(24px\)/, 'Shared history capsule must keep desktop premium blur');

const desktopTiles = accessoryCss.match(/\.dock-style-eyedropper-button,\s*\.dock-style-preset-button\s*\{([\s\S]*?)\}/)?.[1] ?? '';
assert.match(desktopTiles, /rgba\(255, 255, 255, 0\.24\)/, 'Shared right tiles must keep the desktop transparent glass body');
assert.match(desktopTiles, /inset 0 1px 0 rgba\(255, 255, 255, 0\.82\)/, 'Shared right tiles must keep desktop convex/specular depth');

assert.ok(
  mainEntry.lastIndexOf("import './refractive-glass-lensing.css';") > mainEntry.lastIndexOf("import './mobile-premium-glass-fallback.css';"),
  'Working refractive edge layer must continue loading after the mobile compatibility file'
);

console.log('Mobile glass parity regression passed.');
