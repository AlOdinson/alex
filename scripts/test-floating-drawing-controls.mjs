import assert from 'node:assert/strict';
import fs from 'node:fs';

const main = fs.readFileSync(new URL('../src/main.jsx', import.meta.url), 'utf8');
const toolbar = fs.readFileSync(new URL('../src/components/Toolbar.jsx', import.meta.url), 'utf8');
const presets = fs.readFileSync(new URL('../src/lib/drawingPresets.js', import.meta.url), 'utf8');
const cssUrl = new URL('../src/three-dot-drawing-controls.css', import.meta.url);

assert.match(main, /import ['\"]\.\/three-dot-drawing-controls\.css['\"];/, 'Three-dot drawing controls CSS must be loaded');
assert.ok(fs.existsSync(cssUrl), 'Three-dot drawing controls stylesheet must exist');
assert.match(toolbar, /import \{ createPortal \} from ['\"]react-dom['\"];/, 'Toolbar must render drawing controls through a React portal');
assert.match(toolbar, /\['pencil', 'line', 'shape'\]\.includes\(tool\)/, 'Pencil, Line and Shapes must trigger the three-dot controls');
assert.match(toolbar, /data-drawing-tool=\{item\.id\}/, 'Dock tool buttons must expose their drawing-tool anchor');
assert.match(toolbar, /data-drawing-tool=['\"]shape['\"]/, 'Shapes must expose its drawing-tool anchor');
assert.match(toolbar, /querySelector\(`\.board-tool-dock \[data-drawing-tool="\$\{tool\}"\]`\)/, 'Floating controls must follow the currently selected dock icon');
assert.match(toolbar, /three-dot-drawing-controls/, 'Toolbar must render the approved three-dot design');
assert.match(toolbar, /floating-opacity-dot/, 'Left dot must control opacity');
assert.match(toolbar, /Math\.round\(opacity \* 100\)\}%/, 'Opacity percentage must be shown above the left dot');
assert.match(toolbar, /floating-color-input[\s\S]*?type=['\"]color['\"]|type=['\"]color['\"][\s\S]*?floating-color-input/, 'Center dot must keep the existing color input/palette');
assert.match(toolbar, /floating-width-dot/, 'Right dot must control width');
assert.match(toolbar, /\{width\}px/, 'Current width must be shown above the right dot');
assert.match(toolbar, /openDrawingControl === ['\"]opacity['\"][\s\S]*?floating-opacity-scale/, 'Opacity scale must open only from the left dot');
assert.match(toolbar, /openDrawingControl === ['\"]width['\"][\s\S]*?floating-width-scale/, 'Width scale must open only from the right dot');
assert.match(toolbar, /createPortal\([\s\S]*?three-dot-drawing-controls[\s\S]*?document\.body/, 'Three-dot controls must be portaled to document.body');
assert.doesNotMatch(toolbar, /three-dot-drawing-controls[\s\S]{0,1800}eyedropper-button/, 'The approved three-dot row must not add a fourth eyedropper button');
assert.match(presets, /STROKE_WIDTH_STEPS = \[\s*1,\s*2,\s*3,\s*4,\s*5,\s*8,\s*10,\s*15,\s*20,\s*25,\s*50,\s*100,?\s*\]/, 'Drawing widths must keep the agreed 12 discrete values');

const css = fs.readFileSync(cssUrl, 'utf8');
assert.match(css, /\.three-dot-drawing-controls\s*\{[\s\S]*?position:\s*fixed;[\s\S]*?background:\s*transparent;/, 'Three-dot root must float without the old white panel');
assert.match(css, /\.floating-opacity-scale\s*\{[\s\S]*?right:\s*calc\(100% \+/, 'Opacity scale must extend directly to the left of the left dot');
assert.match(css, /\.floating-width-scale\s*\{[\s\S]*?left:\s*calc\(100% \+/, 'Width scale must extend directly to the right of the right dot');
assert.match(css, /\.floating-control-value/, 'Value labels must be positioned above the side dots');
assert.match(css, /\.floating-color-dot/, 'Center dot must visually show the current color');
assert.match(css, /@media \(max-width:\s*760px\)/, 'Three-dot controls must keep a compact mobile layout');
console.log('Three-dot floating drawing controls regression passed.');
