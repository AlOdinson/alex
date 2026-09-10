import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../src/dock-layout-runtime.js', import.meta.url), 'utf8');

assert.match(source, /dock-layout-mode-button/);
assert.match(source, /data-dock-layout-action/);
assert.match(source, /advanceDockLayoutMode\(/);
assert.match(source, /getDockLayoutMode\(/);
assert.match(source, /DOCK_LAYOUT_CHANGE_EVENT/);
assert.match(source, /--dock-style-bottom/);
assert.match(source, /--dock-style-width/);
assert.match(source, /--dock-style-center-x/);
assert.match(source, /--dock-style-center-y/);

console.log('Dock layout switcher regression passed.');
