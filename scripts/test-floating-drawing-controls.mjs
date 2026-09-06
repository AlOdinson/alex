import assert from 'node:assert/strict';
import fs from 'node:fs';

const main = fs.readFileSync(new URL('../src/main.jsx', import.meta.url), 'utf8');
const toolbar = fs.readFileSync(new URL('../src/components/Toolbar.jsx', import.meta.url), 'utf8');
const presets = fs.readFileSync(new URL('../src/lib/drawingPresets.js', import.meta.url), 'utf8');
const enhancer = fs.readFileSync(new URL('../src/floating-drawing-controls-enhancer.js', import.meta.url), 'utf8');
const cssUrl = new URL('../src/floating-drawing-controls.css', import.meta.url);

assert.match(main, /import ['\"]\.\/floating-drawing-controls\.css['\"];/, 'Floating drawing controls CSS must be loaded');
assert.match(main, /import ['\"]\.\/floating-drawing-controls-enhancer\.js['\"];/, 'Floating drawing controls enhancer must be loaded');
assert.ok(fs.existsSync(cssUrl), 'Floating drawing controls stylesheet must exist');
assert.match(toolbar, /import \{ createPortal \} from ['\"]react-dom['\"];/, 'Toolbar must render floating controls through a React portal');
assert.match(toolbar, /createPortal\([\s\S]*?floating-drawing-controls[\s\S]*?document\.body/, 'Floating drawing controls must be portaled to document.body');
assert.match(toolbar, /\['pencil', 'line', 'shape'\]\.includes\(tool\)/, 'Pencil, Line and Shapes must trigger floating drawing controls');
assert.match(presets, /STROKE_WIDTH_STEPS = \[\s*1,\s*2,\s*3,\s*4,\s*5,\s*8,\s*10,\s*15,\s*20,\s*25,\s*50,\s*100,?\s*\]/, 'Drawing widths must use the agreed 12 discrete values');
assert.match(enhancer, /\.eyedropper-button \+ \.compact-slider/, 'Opacity enhancer must target the control structurally, independent of language');
assert.doesNotMatch(enhancer, /title\^=/, 'Opacity enhancer must not depend on translated title text');
assert.match(enhancer, /--opacity-stop/, 'Opacity enhancer must sync the visual fill and bubble position');

const css = fs.readFileSync(cssUrl, 'utf8');
assert.match(css, /\.floating-drawing-controls\s*\{[\s\S]*?position:\s*fixed;/, 'Floating row must be fixed to the viewport');
assert.match(css, /width:\s*min\(438px,\s*calc\(100vw - 24px\)\)/, 'Desktop floating controls must be slightly narrower than the bottom dock');
assert.match(css, /\.floating-drawing-controls \.color-control[\s\S]*?width:\s*30px\s*!important;[\s\S]*?height:\s*30px\s*!important;/, 'Color circle must stay compact');
assert.match(css, /eyedropper-button > span::before[\s\S]*?data:image\/svg\+xml/, 'Eyedropper must use the approved eyedropper pictogram');
assert.match(css, /\.eyedropper-button \+ \.compact-slider[\s\S]*?--opacity-stop[\s\S]*?repeating-conic-gradient/, 'Opacity control must use checkerboard transparency with dynamic fill');
assert.match(css, /\.compact-slider \+ \.compact-slider[\s\S]*?linear-gradient\(90deg, #cbd5e1, #cbd5e1\)/, 'Width dots must be connected with a light line');
assert.doesNotMatch(css, /title\^=/, 'Floating control styling must not depend on translated title text');
const dotStops = css.match(/radial-gradient\(circle at [^,]+,\s*#8a96a8 0 4px/g) ?? [];
assert.equal(dotStops.length, 12, 'Width track must render exactly 12 equal-size dots');
assert.match(css, /\.compact-slider \+ \.compact-slider[\s\S]*?strong\s*\{\s*display:\s*none\s*!important;/, 'Width numbers must not be displayed');
assert.match(css, /bottom:\s*calc\(max\(12px,\s*env\(safe-area-inset-bottom\)\) \+ 82px\)/, 'Floating controls must sit directly above the dock');
assert.doesNotMatch(css, /\.board-page:has\(/, 'Floating controls must not depend on CSS :has relocation');
console.log('Floating drawing controls regression passed.');
