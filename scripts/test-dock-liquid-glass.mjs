import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const historyCss = await readFile(new URL('../src/dock-history-icons.css', import.meta.url), 'utf8');
const accessoryCss = await readFile(new URL('../src/dock-style-accessories.css', import.meta.url), 'utf8');

const historyStand = historyCss.match(/\.dock-history-accessories\s*\{([\s\S]*?)\}/)?.[1] ?? '';
assert.match(historyStand, /backdrop-filter:\s*blur\(/, 'Undo/redo stand must blur the board beneath it');
assert.match(historyStand, /linear-gradient\(/, 'Undo/redo stand must use a translucent glass sheen');
assert.match(historyStand, /border-radius:\s*18px/, 'Undo/redo stand must remain a rounded glass pill');
assert.match(historyStand, /box-shadow:/, 'Undo/redo stand must have liquid-glass depth');

const historyButton = historyCss.match(/\.dock-history-button\s*\{([\s\S]*?)\}/)?.[1] ?? '';
assert.match(historyButton, /background:\s*transparent/, 'Undo/redo arrows must remain transparent inside the shared glass stand');
assert.match(historyButton, /backdrop-filter:\s*none/, 'Undo/redo arrows must not create separate glass cards');

const glassTiles = accessoryCss.match(/\.dock-style-eyedropper-button,\s*\.dock-style-preset-button\s*\{([\s\S]*?)\}/)?.[1] ?? '';
assert.match(glassTiles, /backdrop-filter:\s*blur\(/, 'Right-side accessory tiles must blur the board beneath them');
assert.match(glassTiles, /linear-gradient\(/, 'Right-side accessory tiles must use a translucent glass sheen');
assert.match(glassTiles, /border-radius:\s*9px/, 'Right-side accessory tiles must keep rounded liquid-glass corners');
assert.match(glassTiles, /box-shadow:/, 'Right-side accessory tiles must have liquid-glass depth');

const presetFill = accessoryCss.match(/\.dock-style-preset-fill\s*\{([\s\S]*?)\}/)?.[1] ?? '';
assert.match(presetFill, /inset:\s*3px/, 'Preset color fill must leave the glass rim visible');
assert.match(presetFill, /border-radius:\s*6px/, 'Preset color fill must fit inside the rounded glass tile');

console.log('Dock liquid glass regression passed.');
