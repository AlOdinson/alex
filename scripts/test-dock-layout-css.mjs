import assert from 'node:assert/strict';
import fs from 'node:fs';

const main = fs.readFileSync(new URL('../src/main.jsx', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../src/dock-layout-modes.css', import.meta.url), 'utf8');
const preResponsive = css.split('@media (max-width: 1180px)')[0];

assert.match(main, /import ['"]\.\/dock-layout-controller\.js['"]/);
assert.match(main, /import ['"]\.\/dock-layout-runtime\.js['"]/);
assert.match(main, /import ['"]\.\/dock-layout-modes\.css['"]/);
assert.match(css, /html\[data-dock-layout="1"\][\s\S]*?\.board-tool-dock/);
assert.match(css, /html\[data-dock-layout="2"\][\s\S]*?\.board-tool-dock/);
assert.match(css, /html\[data-dock-layout="3"\][\s\S]*?\.board-tool-dock/);
assert.match(preResponsive, /data-dock-layout="2"[\s\S]*?\.board-tool-dock[\s\S]*?top:\s*max\(64px/);
assert.match(css, /data-dock-layout="3"[\s\S]*?flex-direction:\s*column/);
assert.match(preResponsive, /data-dock-layout="3"[\s\S]*?\.edit-actions[\s\S]*?top:\s*max\(64px/);
assert.match(preResponsive, /data-dock-layout="3"[\s\S]*?\.object-actions[\s\S]*?top:\s*max\(112px/);
assert.match(css, /data-dock-layout="3"[\s\S]*?\.object-actions[\s\S]*?flex-direction:\s*row/);
assert.match(css, /data-context-direction="below"/);
assert.match(css, /data-context-direction="right"/);
assert.match(css, /dock-layout-mode-button/);
assert.match(css, /data-dock-layout="2"[\s\S]*?\.toolbar-secondary-row[\s\S]*?top:\s*max\(132px/);

console.log('Dock layout CSS regression passed.');
