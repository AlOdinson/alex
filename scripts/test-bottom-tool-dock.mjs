import assert from 'node:assert/strict';
import fs from 'node:fs';

const toolbar = fs.readFileSync(new URL('../src/components/Toolbar.jsx', import.meta.url), 'utf8');
const styles = fs.readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
const palette = fs.readFileSync(new URL('../src/components/ShapePalette.jsx', import.meta.url), 'utf8');
const i18n = fs.readFileSync(new URL('../src/i18n.js', import.meta.url), 'utf8');

assert.match(toolbar, /function DockToolIcon\(\{ id \}\)/, 'Toolbar must define custom SVG dock icons');
for (const id of ['select', 'pencil', 'line', 'eraser', 'text', 'shape', 'image']) {
  assert.match(toolbar, new RegExp(`case ['\"]${id}['\"]:`), `DockToolIcon must include ${id}`);
}

const primaryStart = toolbar.indexOf('<div className="toolbar-primary-row">');
const primaryEnd = toolbar.indexOf('<div className="toolbar-secondary-row">');
assert.ok(primaryStart >= 0 && primaryEnd > primaryStart, 'Toolbar primary row must exist');
const primary = toolbar.slice(primaryStart, primaryEnd);
assert.doesNotMatch(primary, /className="tool-group main-tools"/, 'Main drawing tools must be removed from the top row');
assert.doesNotMatch(primary, /TOOLS\.map/, 'Top row must not render the drawing tool list');

const dockStart = toolbar.indexOf('className="board-tool-dock"');
assert.ok(dockStart >= 0, 'Bottom tool dock must exist');
const dock = toolbar.slice(dockStart);
assert.match(dock, /TOOLS\.map/, 'Bottom dock must render the core tools');
assert.match(dock, /className="dock-tool-label"/, 'Bottom dock tools must show labels');
assert.match(dock, /<DockToolIcon id=\{item\.id\} \/>/, 'Core tools must use custom SVG dock icons');
assert.match(dock, /<DockToolIcon id="shape" \/>/, 'Shapes must use the custom shapes icon');
assert.match(dock, /<DockToolIcon id="image" \/>/, 'Picture must use the custom picture icon');
assert.match(dock, />Картинка<\/span>/, 'Picture must have a visible short label');

assert.match(dock, /className="image-file-input"/, 'Existing image file input must remain');
assert.match(dock, /accept="image\/\*,\.heic,\.heif"/, 'Existing image formats must remain unchanged');
assert.match(dock, /\bmultiple\b/, 'Existing multi-image upload must remain unchanged');
assert.match(dock, /if \(files\.length\) onAddImages\(files\);/, 'Existing onAddImages behavior must remain unchanged');

assert.match(styles, /\.board-tool-dock\s*\{[\s\S]*?position:\s*absolute;/, 'Dock must float over the board');
assert.match(styles, /\.board-tool-dock\s*\{[\s\S]*?left:\s*50%;/, 'Dock must be centered horizontally');
assert.match(styles, /\.board-tool-dock\s*\{[\s\S]*?bottom:\s*max\(/, 'Dock must sit near the bottom safe area');
assert.match(styles, /\.board-tool-dock \.dock-tool-button\.active/, 'Active tool needs reference-style dock highlighting');
assert.match(styles, /\.dock-tool-icon/, 'Dock SVG icons need dedicated sizing');
assert.match(styles, /\.dock-tool-label/, 'Dock labels need dedicated styling');

assert.match(palette, /openAbove/, 'Shape palette must support opening above a bottom dock anchor');
assert.match(palette, /translateY\(-100%\)/, 'Shape palette must anchor above without leaving a gap');

assert.match(i18n, /'Картинка':\s*'Image'/, 'Short Picture label must have an English translation');

console.log('Bottom tool dock regression passed.');
