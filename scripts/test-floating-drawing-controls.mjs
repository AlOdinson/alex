import assert from 'node:assert/strict';
import fs from 'node:fs';

const main = fs.readFileSync(new URL('../src/main.jsx', import.meta.url), 'utf8');
const toolbar = fs.readFileSync(new URL('../src/components/Toolbar.jsx', import.meta.url), 'utf8');
const presets = fs.readFileSync(new URL('../src/lib/drawingPresets.js', import.meta.url), 'utf8');
const enhancer = fs.readFileSync(new URL('../src/floating-drawing-controls-enhancer.js', import.meta.url), 'utf8');
const cssUrl = new URL('../src/three-dot-drawing-controls.css', import.meta.url);

assert.match(main, /import ['\"]\.\/three-dot-drawing-controls\.css['\"];/, 'Three-dot drawing controls CSS must be loaded after the legacy floating styles');
assert.ok(fs.existsSync(cssUrl), 'Three-dot drawing controls stylesheet must exist');
assert.match(toolbar, /import \{ createPortal \} from ['\"]react-dom['\"];/, 'Toolbar must keep rendering floating controls through a React portal');
assert.match(toolbar, /\['pencil', 'line', 'shape'\]\.includes\(tool\)/, 'Pencil, Line and Shapes must trigger floating drawing controls');
assert.match(toolbar, /floating-drawing-controls/, 'Existing floating control DOM must remain available');
assert.match(toolbar, /<input\s+[\s\S]*?type=['\"]color['\"][\s\S]*?value=\{color\}/, 'Center dot must keep the existing controlled color input');
assert.match(main, /ipad-system-color-palette/, 'The center color input must be enhanced by the approved iPad system palette module');
assert.match(presets, /STROKE_WIDTH_STEPS = \[\s*1,\s*2,\s*3,\s*4,\s*5,\s*8,\s*10,\s*15,\s*20,\s*25,\s*50,\s*100,?\s*\]/, 'Drawing widths must keep the agreed 12 discrete values');

assert.match(enhancer, /\.board-tool-dock \.dock-tool-button\.active/, 'Three-dot controls must anchor to the active Pencil, Line or Shapes dock button');
assert.match(enhancer, /--drawing-controls-x/, 'Enhancer must publish the selected icon horizontal position');
assert.match(enhancer, /--drawing-controls-y/, 'Enhancer must publish the selected icon vertical position');
assert.match(enhancer, /opacity-open/, 'Enhancer must open the opacity scale from the left dot');
assert.match(enhancer, /width-open/, 'Enhancer must open the width scale from the right dot');
assert.doesNotMatch(enhancer, /title\^=/, 'Enhancer must not depend on translated title text');

const css = fs.readFileSync(cssUrl, 'utf8');
assert.match(css, /\.floating-drawing-controls\s*\{[\s\S]*?background:\s*transparent\s*!important;/, 'Old white floating panel must be removed');
assert.match(css, /\.floating-drawing-controls > \.eyedropper-button\s*\{[\s\S]*?display:\s*none\s*!important;/, 'Approved design must show only three dots');
assert.match(css, /\.floating-drawing-controls > \.color-control\s*\{[\s\S]*?order:\s*2;/, 'Center color control must remain the middle dot');
assert.match(css, /\.floating-drawing-controls > \.color-control\s*\{[\s\S]*?flex:\s*0 0 21px\s*!important;[\s\S]*?width:\s*21px\s*!important;[\s\S]*?min-width:\s*21px\s*!important;[\s\S]*?height:\s*21px\s*!important;[\s\S]*?min-height:\s*21px\s*!important;/, 'Center color dot must be exactly 21px on every device');
assert.match(css, /\.floating-drawing-controls > \.eyedropper-button \+ \.compact-slider\s*\{[\s\S]*?order:\s*1;/, 'Opacity must be the left dot');
assert.match(css, /\.floating-drawing-controls > \.compact-slider \+ \.compact-slider\s*\{[\s\S]*?order:\s*3;/, 'Width must be the right dot');
assert.match(css, /\.floating-drawing-controls\.opacity-open[\s\S]*?right:\s*0/, 'Opacity scale must expand left from the left dot');
assert.match(css, /\.floating-drawing-controls\.width-open[\s\S]*?left:\s*0/, 'Width scale must expand right from the right dot');
assert.match(css, /\.floating-drawing-controls > \.eyedropper-button \+ \.compact-slider > strong,[\s\S]*?\.floating-drawing-controls > \.compact-slider \+ \.compact-slider > strong/, 'Opacity and width values must be visible above the side dots with selectors strong enough to beat legacy rules');
assert.match(css, /@media \(max-width:\s*760px\)/, 'Three-dot controls must keep a compact mobile layout');
console.log('Three-dot floating drawing controls regression passed.');
