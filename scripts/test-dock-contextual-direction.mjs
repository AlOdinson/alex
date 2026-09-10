import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../src/floating-drawing-controls-enhancer.js', import.meta.url), 'utf8');
const toolbar = fs.readFileSync(new URL('../src/components/Toolbar.jsx', import.meta.url), 'utf8');

assert.match(source, /dock-layout-controller\.js/);
assert.match(source, /contextualDirectionForMode/);
assert.match(source, /getDockLayoutMode/);
assert.match(source, /contextDirection/);
assert.match(source, /rect\.bottom\s*\+\s*10/);
assert.match(source, /rect\.right\s*\+\s*10/);
assert.match(source, /DOCK_LAYOUT_CHANGE_EVENT/);
assert.match(toolbar, /const showFloatingDrawingSettings = \['pencil', 'line', 'shape'\]\.includes\(tool\);/);
assert.doesNotMatch(
  toolbar,
  /showFloatingDrawingSettings\s*&&\s*!\(tool === 'shape' && shapesOpen\)/,
  'Shape must keep the three-dot drawing controls visible while its palette is open',
);

console.log('Dock contextual direction regression passed.');
