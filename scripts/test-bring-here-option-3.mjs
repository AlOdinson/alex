import fs from 'node:fs';

const main = fs.readFileSync(new URL('../src/main.jsx', import.meta.url), 'utf8');
const iconUrl = new URL('../src/bring-here-option-3.css', import.meta.url);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(main.includes("import './bring-here-option-3.css';"), 'main.jsx must load the selected Bring here icon override.');
assert(fs.existsSync(iconUrl), 'Selected Bring here icon stylesheet must exist.');
const styles = fs.readFileSync(iconUrl, 'utf8');
assert(styles.includes('.alex-settings-source-bring::before'), 'Override must target the existing Bring here button icon only.');
assert(styles.includes('option-3-pin-four-inward-arrows'), 'Override must identify selected option 3: location pin plus four inward arrows.');
assert(styles.includes('data:image/svg+xml'), 'Bring here icon must be an SVG, not emoji/text.');
assert(styles.includes('%232f7cff') && styles.includes('%231258e8'), 'Bring here icon must keep the vivid blue gradient from option 3.');
assert(styles.includes('-webkit-mask: none') && styles.includes('mask: none'), 'Old people/arrow mask must be fully replaced.');
assert(
  /\.alex-settings-source-bring\s*\{[^}]*transform:\s*scale\(1\.2\)\s*!important;/s.test(styles),
  'Bring here button and its icon must be exactly 20% larger.',
);
assert(
  styles.includes('transform-origin: center center !important;'),
  'Bring here 20% enlargement must stay centered on the current position.',
);

console.log('Bring here option 3 icon regression passed.');
