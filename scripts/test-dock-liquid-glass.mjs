import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const historyCss = await readFile(new URL('../src/dock-history-icons.css', import.meta.url), 'utf8');
const accessoryCss = await readFile(new URL('../src/dock-style-accessories.css', import.meta.url), 'utf8');

const historyStand = historyCss.match(/\.dock-history-accessories\s*\{([\s\S]*?)\}/)?.[1] ?? '';
assert.match(historyStand, /backdrop-filter:\s*blur\(24px\)/, 'Undo/redo stand must use the stronger Telegram-like frosted blur');
assert.match(historyStand, /linear-gradient\(/, 'Undo/redo stand must keep a translucent glass sheen');
assert.match(historyStand, /radial-gradient\(/, 'Undo/redo stand must have a stronger specular reflection');
assert.match(historyStand, /border-radius:\s*18px/, 'Undo/redo stand must remain one compact rounded glass capsule');
assert.match(historyStand, /box-shadow:/, 'Undo/redo stand must have floating liquid-glass depth');
assert.doesNotMatch(historyCss, /\.dock-history-accessories::before\s*\{/, 'Undo/redo stand must not render a second full-size inner capsule');
assert.match(historyStand, /border:\s*1px solid rgba\(255, 255, 255, 0\.64\)/, 'Premium history glass must use a thinner-looking translucent edge instead of a milky white rim');
assert.match(historyStand, /0 9px 24px rgba\(15, 23, 42, 0\.14\)/, 'Premium history glass must use a tighter softer floating shadow');
assert.match(historyStand, /rgba\(163, 207, 255, 0\.2\)/, 'Premium history glass must include a restrained cold edge reflection');

const historyButton = historyCss.match(/\.dock-history-button\s*\{([\s\S]*?)\}/)?.[1] ?? '';
assert.match(historyButton, /background:\s*transparent/, 'Undo/redo arrows must remain transparent inside the shared glass stand');
assert.match(historyButton, /backdrop-filter:\s*none/, 'Undo/redo arrows must not become separate cards');

const rightShell = accessoryCss.match(/\.dock-style-right-accessories\s*\{([\s\S]*?)\}/)?.[1] ?? '';
assert.match(rightShell, /border:\s*0/, 'Right-side accessory group must not have a shared border');
assert.match(rightShell, /border-radius:\s*0/, 'Right-side accessory group must not become a rounded container');
assert.match(rightShell, /background:\s*transparent/, 'Right-side accessory group must have no shared backing');
assert.match(rightShell, /box-shadow:\s*none/, 'Right-side accessory group must have no shared shadow/backplate');

const glassTiles = accessoryCss.match(/\.dock-style-eyedropper-button,\s*\.dock-style-preset-button\s*\{([\s\S]*?)\}/)?.[1] ?? '';
assert.match(glassTiles, /border:\s*0/, 'Right-side liquid-glass tiles must keep the original borderless square geometry');
assert.match(glassTiles, /backdrop-filter:\s*blur\(18px\)/, 'Each of the four right-side tiles must itself be liquid glass');
assert.match(glassTiles, /border-radius:\s*0/, 'Right-side tiles must remain square rather than becoming rounded cards');
assert.match(glassTiles, /box-shadow:/, 'Each right-side tile must carry its own glass depth');
assert.match(glassTiles, /transition:\s*box-shadow 140ms/, 'Premium glass tiles must transition their optical depth without changing layout');

const tileSheen = accessoryCss.match(/\.dock-style-eyedropper-button::before,\s*\.dock-style-preset-button::before\s*\{([\s\S]*?)\}/)?.[1] ?? '';
assert.match(tileSheen, /linear-gradient\(/, 'Each right-side tile must carry its own glass highlight');
assert.match(tileSheen, /border-radius:\s*0/, 'Glass highlight must preserve the square tile shape');
assert.match(tileSheen, /transform:\s*translate3d\(-1px, -1px, 0\) scale\(1\.04\)/, 'Premium tile highlight must begin slightly offset to simulate a glass reflection');
assert.match(tileSheen, /transition:\s*transform 140ms/, 'Premium tile reflection must shift subtly on interaction');

const tileHoverSheen = accessoryCss.match(/\.dock-style-eyedropper-button:hover:not\(:disabled\)::before,\s*\.dock-style-preset-button:hover:not\(:disabled\)::before\s*\{([\s\S]*?)\}/)?.[1] ?? '';
assert.match(tileHoverSheen, /translate3d\(1px, 1px, 0\)/, 'Hover must move the specular reflection rather than adding another backing layer');

const tileActiveSheen = accessoryCss.match(/\.dock-style-eyedropper-button:active:not\(:disabled\)::before,\s*\.dock-style-preset-button:active:not\(:disabled\)::before\s*\{([\s\S]*?)\}/)?.[1] ?? '';
assert.match(tileActiveSheen, /translate3d\(0, 2px, 0\)/, 'Press must nudge the reflection by only a couple of pixels');

const presetFill = accessoryCss.match(/\.dock-style-preset-fill\s*\{([\s\S]*?)\}/)?.[1] ?? '';
assert.match(presetFill, /inset:\s*0/, 'Preset color must fill the glass tile itself rather than sit on a smaller inner plate');
assert.match(presetFill, /border-radius:\s*inherit/, 'Preset color must follow the tile shape directly');
assert.match(presetFill, /inset 0 0 10px rgba\(15, 23, 42, 0\.045\)/, 'Preset color must read as sitting beneath a shallow glass surface');

const matteDock = accessoryCss.match(/\.board-tool-dock\s*\{([\s\S]*?)\}/)?.[1] ?? '';
assert.match(matteDock, /border:\s*1px solid rgba\(255, 255, 255, 0\.58\)/, 'Bottom dock must have a restrained translucent white glass edge');
assert.match(matteDock, /rgba\(255, 255, 255, 0\.46\)/, 'Bottom dock must use a white frosted-glass base rather than an opaque white plate');
assert.match(matteDock, /backdrop-filter:\s*blur\(22px\)/, 'Bottom dock must use matte blur');
assert.match(matteDock, /box-shadow:/, 'Bottom dock must keep soft floating depth');

assert.match(historyCss, /@media \(hover: none\), \(pointer: coarse\)/, 'Touch devices must have an explicit premium history-glass treatment');
assert.match(historyCss, /@media \(hover: none\), \(pointer: coarse\)[\s\S]*?\.dock-history-accessories\s*\{[\s\S]*?rgba\(163, 207, 255, 0\.24\)/, 'Touch history glass must retain a visible cold reflection without hover');
assert.match(accessoryCss, /@media \(hover: none\), \(pointer: coarse\)/, 'Touch devices must have an explicit premium accessory-glass treatment');
assert.match(accessoryCss, /@media \(hover: none\), \(pointer: coarse\)[\s\S]*?\.dock-style-eyedropper-button::before,[\s\S]*?\.dock-style-preset-button::before\s*\{[\s\S]*?opacity:\s*0\.94/, 'Touch accessory tiles must show the premium specular layer statically');
assert.match(accessoryCss, /@media \(hover: none\), \(pointer: coarse\)[\s\S]*?\.board-tool-dock\s*\{[\s\S]*?backdrop-filter:\s*blur\(22px\)/, 'Touch bottom dock must keep the same white matte glass material as desktop');

console.log('Dock liquid glass regression passed.');
