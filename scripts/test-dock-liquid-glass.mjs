import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const historyCss = await readFile(new URL('../src/dock-history-icons.css', import.meta.url), 'utf8');
const accessoryCss = await readFile(new URL('../src/dock-style-accessories.css', import.meta.url), 'utf8');
const mobileCss = await readFile(new URL('../src/mobile-premium-glass-fallback.css', import.meta.url), 'utf8');
const mainEntry = await readFile(new URL('../src/main.jsx', import.meta.url), 'utf8');

const historyStand = historyCss.match(/\.dock-history-accessories\s*\{([\s\S]*?)\}/)?.[1] ?? '';
assert.match(historyStand, /backdrop-filter:\s*blur\(24px\)/, 'Undo/redo stand must use premium frosted blur');
assert.match(historyStand, /linear-gradient\(/, 'Undo/redo stand must keep translucent glass sheen');
assert.match(historyStand, /radial-gradient\(/, 'Undo/redo stand must keep specular reflection');
assert.match(historyStand, /border-radius:\s*18px/, 'Undo/redo stand must remain one rounded glass capsule');
assert.match(historyStand, /border:\s*1px solid rgba\(255, 255, 255, 0\.64\)/, 'History glass must keep the restrained desktop edge');
assert.match(historyStand, /0 9px 24px rgba\(15, 23, 42, 0\.14\)/, 'History glass must keep the desktop floating shadow');
assert.doesNotMatch(historyCss, /\.dock-history-accessories::before\s*\{/, 'Undo/redo stand must not render a second full-size capsule');

const historyButton = historyCss.match(/\.dock-history-button\s*\{([\s\S]*?)\}/)?.[1] ?? '';
assert.match(historyButton, /background:\s*transparent/, 'Undo/redo arrows must remain transparent inside shared glass');
assert.match(historyButton, /backdrop-filter:\s*none/, 'Undo/redo arrows must not become separate cards');

const rightShell = accessoryCss.match(/\.dock-style-right-accessories\s*\{([\s\S]*?)\}/)?.[1] ?? '';
assert.match(rightShell, /border:\s*0/, 'Right-side group must not have a shared border');
assert.match(rightShell, /border-radius:\s*0/, 'Right-side group must not become rounded');
assert.match(rightShell, /background:\s*transparent/, 'Right-side group must have no shared backing');
assert.match(rightShell, /box-shadow:\s*none/, 'Right-side group must have no shared shadow');

const glassTiles = accessoryCss.match(/\.dock-style-eyedropper-button,\s*\.dock-style-preset-button\s*\{([\s\S]*?)\}/)?.[1] ?? '';
assert.match(glassTiles, /border:\s*0/, 'Right-side tiles must remain borderless squares');
assert.match(glassTiles, /border-radius:\s*0/, 'Right-side tiles must remain square');
assert.match(glassTiles, /rgba\(255, 255, 255, 0\.24\)/, 'Desktop tile body must remain genuinely translucent');
assert.match(glassTiles, /backdrop-filter:\s*blur\(18px\)/, 'Each right tile must itself be liquid glass');
assert.match(glassTiles, /box-shadow:/, 'Each right tile must keep its own glass depth');

const tileSheen = accessoryCss.match(/\.dock-style-eyedropper-button::before,\s*\.dock-style-preset-button::before\s*\{([\s\S]*?)\}/)?.[1] ?? '';
assert.match(tileSheen, /linear-gradient\(/, 'Each right tile must carry its own glass highlight');
assert.match(tileSheen, /transform:\s*translate3d\(-1px, -1px, 0\) scale\(1\.04\)/, 'Tile reflection must keep its premium offset');
assert.match(tileSheen, /opacity:\s*0\.82/, 'Desktop tile reflection must remain visible before hover');

const presetFill = accessoryCss.match(/\.dock-style-preset-fill\s*\{([\s\S]*?)\}/)?.[1] ?? '';
assert.match(presetFill, /inset:\s*0/, 'Preset color must fill the tile itself');
assert.match(presetFill, /border-radius:\s*inherit/, 'Preset color must follow tile geometry');
assert.match(presetFill, /inset 0 0 10px rgba\(15, 23, 42, 0\.045\)/, 'Preset color must read beneath the glass surface');

const matteDock = accessoryCss.match(/\.board-tool-dock\s*\{([\s\S]*?)\}/)?.[1] ?? '';
assert.match(matteDock, /border:\s*1px solid rgba\(255, 255, 255, 0\.58\)/, 'Bottom dock must keep desktop translucent edge');
assert.match(matteDock, /rgba\(255, 255, 255, 0\.46\)/, 'Bottom dock must keep desktop translucent white-glass base');
assert.match(matteDock, /backdrop-filter:\s*blur\(22px\)/, 'Bottom dock must keep desktop matte blur');
assert.match(matteDock, /box-shadow:/, 'Bottom dock must keep floating depth');

assert.ok(mainEntry.lastIndexOf("import './mobile-premium-glass-fallback.css';") > mainEntry.lastIndexOf("import './floating-toolbar-layout.css';"), 'Mobile parity CSS must load after layout/style sheets');
assert.match(mobileCss, /@supports \(-webkit-touch-callout:\s*none\)/, 'iPad/iPhone must have a WebKit parity path');
assert.match(mobileCss, /@media \(max-width:\s*900px\)/, 'Phones must have a viewport parity path');
assert.ok((mobileCss.match(/rgba\(255, 255, 255, 0\.46\)/g) ?? []).length >= 2, 'Mobile dock must repeat the exact desktop glass base');
assert.ok((mobileCss.match(/rgba\(255, 255, 255, 0\.34\)/g) ?? []).length >= 2, 'Mobile history capsule must repeat the exact desktop glass body');
assert.ok((mobileCss.match(/rgba\(255, 255, 255, 0\.24\)/g) ?? []).length >= 2, 'Mobile right tiles must repeat the exact desktop glass body');
assert.doesNotMatch(mobileCss, /background-color:\s*rgba\(/, 'Mobile parity must not add an opaque backing color beneath desktop gradients');
assert.doesNotMatch(mobileCss, /\.dock-style-preset-fill\s*\{/, 'Mobile parity must not flatten preset colors with a separate fill override');
assert.doesNotMatch(mobileCss, /opacity:\s*0\.68/, 'Mobile preset color opacity must not differ from desktop');
assert.doesNotMatch(mobileCss, /\.dock-style-right-accessories\s*\{[\s\S]*?background:/, 'Mobile parity must not add a shared backing behind the four tiles');

console.log('Dock liquid glass regression passed.');
