import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import {
  enterNativeFullscreen,
  exitNativeFullscreen,
  getFullscreenElement,
} from '../src/board-fullscreen-controller.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

{
  let requested = 0;
  const target = { requestFullscreen: async () => { requested += 1; } };
  const doc = { documentElement: target };
  assert.equal(await enterNativeFullscreen(doc, target), true);
  assert.equal(requested, 1);
}

{
  let requested = 0;
  const target = { webkitRequestFullscreen: () => { requested += 1; } };
  const doc = { documentElement: target };
  assert.equal(await enterNativeFullscreen(doc, target), true);
  assert.equal(requested, 1);
}

{
  const marker = {};
  assert.equal(getFullscreenElement({ webkitFullscreenElement: marker }), marker);
}

{
  let exited = 0;
  const doc = { webkitExitFullscreen: () => { exited += 1; } };
  assert.equal(await exitNativeFullscreen(doc), true);
  assert.equal(exited, 1);
}

const main = fs.readFileSync(path.join(root, 'src/main.jsx'), 'utf8');
const ui = fs.readFileSync(path.join(root, 'src/board-fullscreen.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'src/board-fullscreen.css'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

assert.match(main, /import ['"]\.\/board-fullscreen\.css['"]/);
assert.match(main, /import ['"]\.\/board-fullscreen\.js['"]/);
assert.match(ui, /\.toolbar-primary-row \.brand-button/);
assert.match(ui, /brandRect\.right\s*\+\s*BUTTON_GAP/);
assert.match(ui, /alex-board-immersive-fallback/);
assert.match(ui, /fullscreenchange/);
assert.match(ui, /webkitfullscreenchange/);
assert.match(ui, /FULLSCREEN_ICON_VARIANT\s*=\s*['"]corner-brackets-1['"]/);
assert.match(ui, /M10 5H5V10/);
assert.match(ui, /M14 5h5v5/);
assert.match(ui, /M10 19H5v-5/);
assert.match(ui, /M14 19h5v-5/);
assert.match(css, /\.alex-board-fullscreen-button[\s\S]*?width:\s*42px/);
assert.match(css, /\.alex-board-fullscreen-button[\s\S]*?height:\s*42px/);
assert.match(css, /\.alex-board-fullscreen-button[\s\S]*?background:\s*transparent/);
assert.match(css, /\.alex-board-fullscreen-button[\s\S]*?color:\s*#2563eb/);
assert.match(css, /\.alex-board-fullscreen-button[\s\S]*?box-shadow:\s*none/);
assert.doesNotMatch(css, /\.alex-board-fullscreen-button\s*\{[\s\S]*?background:\s*#2563eb/);
assert.match(pkg.scripts['test:sync'], /test-board-fullscreen\.mjs/);

console.log('Board fullscreen regression passed.');
