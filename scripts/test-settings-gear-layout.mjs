import fs from 'node:fs';

const main = fs.readFileSync(new URL('../src/main.jsx', import.meta.url), 'utf8');
const jsUrl = new URL('../src/board-settings-gear.js', import.meta.url);
const cssUrl = new URL('../src/board-settings-gear.css', import.meta.url);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(main.includes("import './board-settings-gear.css';"), 'main.jsx must load board-settings-gear.css.');
assert(main.includes("import './board-settings-gear.js';"), 'main.jsx must load board-settings-gear.js.');
assert(fs.existsSync(jsUrl), 'board-settings-gear.js must exist.');
assert(fs.existsSync(cssUrl), 'board-settings-gear.css must exist.');

const enhancer = fs.readFileSync(jsUrl, 'utf8');
const styles = fs.readFileSync(cssUrl, 'utf8');

for (const action of ['share', 'export', 'background', 'language', 'screenShare']) {
  assert(enhancer.includes(`data-action=\"${action}\"`) || enhancer.includes(`data-action="${action}"`) || enhancer.includes(`dataset.action = '${action}'`), `Settings gear must expose ${action}.`);
}
assert(enhancer.includes('.edit-actions'), 'Bring-here proxy must anchor to the left edit-actions rail.');
assert(enhancer.includes('bringStudents'), 'Bring-here proxy must be implemented as a dedicated action.');
assert(styles.includes('.toolbar-status'), 'Sync status must be hidden by the settings-gear stylesheet.');
assert(styles.includes('.toolbar-share-button'), 'Original Share button must be hidden from the board surface.');
assert(styles.includes('.toolbar-export-button'), 'Original Export button must be hidden from the board surface.');
assert(styles.includes('.background-control'), 'Original Background control must be hidden from the board surface.');
assert(styles.includes('.toolbar-secondary-row .language-toggle'), 'Original RU/EN control must be hidden from the board surface.');
assert(styles.includes('.desktop-screen-share'), 'Original ShareScreen control must be hidden from the board surface.');
assert(styles.includes('width: 42px') && styles.includes('height: 42px'), 'Gear must match the 42x42 A brand box.');
assert(styles.includes('#2563eb'), 'Gear must use the same blue as the A brand box.');

console.log('Settings gear layout regression passed.');
