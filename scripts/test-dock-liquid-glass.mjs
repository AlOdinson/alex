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

const historyButton = historyCss.match(/\.dock-history-button\s*\{([\s\S]*?)\}/)?.[1] ?? '';
assert.match(historyButton, /background:\s*transparent/, 'Undo/redo arrows must remain transparent inside the shared glass stand');
assert.match(historyButton, /backdrop-filter:\s*none/, 'Undo/redo arrows must not become separate cards');

const rightShell = accessoryCss.match(/\.dock-style-right-accessories\s*\{([\s\S]*?)\}/)?.[1] ?? '';
assert.match(rightShell, /border:\s*0/, 'Right-side accessory group must not have a shared border');
assert.match(rightShell, /border-radius:\s*0/, 'Right-side accessory group must not become a rounded container');
assert.match(rightShell, /background:\s*transparent/, 'Right-side accessory group must have no shared backing');
assert.match(rightShell, /box-shadow:\s*none/, 'Right-side accessory group must have no shared shadow/backplate');

const glassTiles = accessoryCss.match(/\.dock-style-eyedropper-button,\s*\.dock-style-preset-button\s*\{([\s\S]*?)\}/)?.[1] ?? '';
assert.match(glassTiles, /backdrop-filter:\s*blur\(18px\)/, 'Each of the four right-side tiles must itself be liquid glass');
assert.match(glassTiles, /border-radius:\s*4px/, 'Right-side tiles must stay square with only a small corner radius');
assert.match(glassTiles, /box-shadow:/, 'Each right-side tile must carry its own glass depth');

const tileSheen = accessoryCss.match(/\.dock-style-eyedropper-button::before,\s*\.dock-style-preset-button::before\s*\{([\s\S]*?)\}/)?.[1] ?? '';
assert.match(tileSheen, /linear-gradient\(/, 'Each right-side tile must carry its own glass highlight');
assert.match(tileSheen, /border-radius:\s*3px/, 'Glass highlight must follow the nearly-square tile shape');

const presetFill = accessoryCss.match(/\.dock-style-preset-fill\s*\{([\s\S]*?)\}/)?.[1] ?? '';
assert.match(presetFill, /inset:\s*0/, 'Preset color must fill the glass tile itself rather than sit on a smaller inner plate');
assert.match(presetFill, /border-radius:\s*inherit/, 'Preset color must follow the tile shape directly');

console.log('Dock liquid glass regression passed.');
