import assert from 'node:assert/strict';
import fs from 'node:fs';

const toolbarSource = fs.readFileSync(new URL('../src/components/Toolbar.jsx', import.meta.url), 'utf8');
const stylesSource = fs.readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');

assert.match(toolbarSource, /const \[presenceOpen, setPresenceOpen\] = useState\(false\)/,
  'presence counter must own open/closed menu state');
assert.match(toolbarSource, /const presenceAnchorRef = useRef\(null\)/,
  'presence counter needs an anchor for outside-click detection');
assert.match(toolbarSource, /className="presence-summary"[\s\S]*aria-haspopup="listbox"[\s\S]*aria-expanded=\{presenceOpen\}/,
  'presence count must be an accessible toggle button');
assert.match(toolbarSource, /onClick=\{\(\) => setPresenceOpen\(\(value\) => !value\)\}/,
  'clicking the count must toggle the menu');
assert.match(toolbarSource, /presenceOpen && \([\s\S]*className="presence-menu"[\s\S]*users\.map/,
  'open menu must render the live users list');
assert.match(toolbarSource, /user\.name \|\| 'Участник'/,
  'presence menu must display each participant name');
assert.match(toolbarSource, /!presenceAnchorRef\.current\?\.contains\(event\.target\)[\s\S]*setPresenceOpen\(false\)/,
  'clicking outside the presence menu must close it');
assert.match(toolbarSource, /event\.key === 'Escape'[\s\S]*setPresenceOpen\(false\)/,
  'Escape must close the presence menu');
assert.match(stylesSource, /\.presence-anchor\s*\{[\s\S]*position:\s*relative/,
  'presence menu must be anchored to the counter');
assert.match(stylesSource, /\.presence-menu\s*\{[\s\S]*position:\s*absolute[\s\S]*min-width:\s*160px/,
  'presence menu must be a compact dropdown');
assert.match(stylesSource, /\.presence-menu-user\s*\{[\s\S]*display:\s*flex/,
  'participant rows must have dedicated compact styling');

console.log('Participant presence dropdown regression passed.');
