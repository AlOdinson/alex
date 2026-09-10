import assert from 'node:assert/strict';
import fs from 'node:fs';

const controller = fs.readFileSync(new URL('../src/dock-layout-controller.js', import.meta.url), 'utf8');
const runtime = fs.readFileSync(new URL('../src/dock-layout-runtime.js', import.meta.url), 'utf8');
const enhancer = fs.readFileSync(new URL('../src/floating-drawing-controls-enhancer.js', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../src/dock-layout-modes.css', import.meta.url), 'utf8');
const main = fs.readFileSync(new URL('../src/main.jsx', import.meta.url), 'utf8');
const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

assert.match(controller, /alex-board:dock-layout:v1/);
assert.match(controller, /alex-board:dock-layout-change/);
assert.match(controller, /1:\s*['"]2['"]/);
assert.match(controller, /2:\s*['"]3['"]/);
assert.match(controller, /3:\s*['"]1['"]/);
assert.match(runtime, /dock-layout-mode-button/);
assert.match(runtime, /advanceDockLayoutMode/);
assert.match(enhancer, /contextualDirectionForMode/);
assert.match(css, /data-dock-layout="3"[\s\S]*?flex-direction:\s*column/);
assert.match(css, /data-context-direction="below"/);
assert.match(css, /data-context-direction="right"/);
assert.match(css, /\.edit-actions[\s\S]*?flex-direction:\s*row/);
assert.match(css, /\.object-actions[\s\S]*?flex-direction:\s*row/);
assert.match(main, /dock-layout-controller\.js/);
assert.match(main, /dock-layout-runtime\.js/);
assert.match(main, /dock-layout-modes\.css/);
assert.match(pkg.scripts['test:sync'], /test-dock-layout-controller\.mjs/);
assert.match(pkg.scripts['test:sync'], /test-dock-layout-switcher\.mjs/);
assert.match(pkg.scripts['test:sync'], /test-dock-contextual-direction\.mjs/);
assert.match(pkg.scripts['test:sync'], /test-dock-layout-css\.mjs/);
assert.match(pkg.scripts['test:sync'], /test-dock-layout-modes\.mjs/);

console.log('Dock layout modes integration regression passed.');
