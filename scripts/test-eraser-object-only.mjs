import assert from 'node:assert/strict';
import fs from 'node:fs';

const main = fs.readFileSync(new URL('../src/main.jsx', import.meta.url), 'utf8');
const board = fs.readFileSync(new URL('../src/components/Board.jsx', import.meta.url), 'utf8');
const overridePath = new URL('../src/eraser-object-only.css', import.meta.url);

assert.match(board, /const eraserModeRef = useRef\(['\"]object['\"]\)/, 'Eraser runtime must default to object mode');
assert.match(board, /useState\(['\"]object['\"]\)/, 'Eraser state must default to object mode');
assert.match(main, /import ['\"]\.\/eraser-object-only\.css['\"];/, 'Object-only eraser UI override must be loaded');
assert.ok(fs.existsSync(overridePath), 'Object-only eraser UI override file must exist');
const override = fs.readFileSync(overridePath, 'utf8');
assert.match(override, /\.eraser-controls\s*\{[\s\S]*?display:\s*none\s*!important\s*;/, 'Eraser mode controls must never be displayed');

console.log('Object-only eraser regression passed.');
