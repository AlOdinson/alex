import fs from 'node:fs';

const toolbar = fs.readFileSync(new URL('../src/components/Toolbar.jsx', import.meta.url), 'utf8');
const styles = fs.readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const blockMatch = toolbar.match(/<span className="desktop-screen-share">([\s\S]*?)<\/span>/);
assert(blockMatch, 'Desktop toolbar must expose a dedicated ShareScreen control.');
const block = blockMatch[1];

assert(
  block.includes('onClick={screenShare.toggle}'),
  'Desktop ShareScreen control must reuse the existing screenShare.toggle technology.',
);
assert(
  block.includes("{screenShare.isHosting ? 'Stop Share' : 'ShareScreen'}"),
  'Desktop screen-share control must use ShareScreen / Stop Share labels.',
);
assert(
  block.includes('disabled={screenShare.buttonDisabled}'),
  'Desktop ShareScreen control must preserve existing screen-share disabled state.',
);

assert(
  /\.desktop-screen-share\s*\{[^}]*display:\s*inline-flex;?/s.test(styles),
  'Desktop ShareScreen wrapper must be visible on desktop.',
);
assert(
  /@media\s*\(max-width:\s*760px\)[\s\S]*?\.desktop-screen-share\s*\{[^}]*display:\s*none\s*!important;?/s.test(styles),
  'ShareScreen must be hidden on narrow/mobile layouts.',
);
assert(
  /@media\s*\(hover:\s*none\)\s*and\s*\(pointer:\s*coarse\)[\s\S]*?\.desktop-screen-share\s*\{[^}]*display:\s*none\s*!important;?/s.test(styles),
  'ShareScreen must be hidden on touch-first tablet/mobile devices.',
);

console.log('Desktop ShareScreen button regression passed.');
