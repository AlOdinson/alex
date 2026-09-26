import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const readSource = async (url) => {
  try {
    return await readFile(url, 'utf8');
  } catch {
    return '';
  }
};

const main = await readSource(new URL('../src/main.jsx', import.meta.url));
const compatibility = await readSource(new URL('../src/fabricStylusTouchCompatibility.js', import.meta.url));
const board = await readSource(new URL('../src/components/Board.jsx', import.meta.url));
const styles = await readSource(new URL('../src/styles.css', import.meta.url));

assert.match(
  main,
  /import ['"]\.\/fabricStylusTouchCompatibility\.js['"];?/,
  'the iPad stylus compatibility shim must load before the board creates a Fabric Canvas',
);
assert.match(
  compatibility,
  /touchType[\s\S]*stylus/i,
  'the shim must be limited to WebKit stylus TouchEvents',
);
assert.match(
  compatibility,
  /_onTouchStart/,
  'the shim must wrap Fabric touchstart rather than globally changing browser input',
);
assert.match(
  compatibility,
  /preventDefault/,
  'the shim must explicitly neutralize Fabric preventDefault for a paired stylus touchstart',
);
assert.doesNotMatch(
  compatibility,
  /enablePointerEvents\s*=\s*true/,
  'the fix must not globally enable Fabric Pointer Events on iPad',
);

assert.match(
  board,
  /const boardPage = host\.closest\?\.\('\.board-page'\) \?\? host;/,
  'native selection protection must cover the whole board page, not only the Fabric canvas',
);
assert.match(
  board,
  /boardPage\.addEventListener\('selectstart', handleNativeBoardSelectionStart/,
  'board page must cancel Safari native selection outside real text editors',
);
assert.match(
  board,
  /boardPage\.addEventListener\('contextmenu', handleNativeBoardContextMenu/,
  'board page must suppress Safari long-press callouts outside text editors',
);
assert.match(
  board,
  /document\.addEventListener\('selectionchange', handleNativeBoardSelectionChange\)/,
  'stray Safari selections must be cleared even if WebKit creates them after the initial contact',
);
assert.match(
  styles,
  /\.board-page\s*\{[\s\S]*?-webkit-user-select:\s*none;[\s\S]*?-webkit-touch-callout:\s*none;/,
  'board page CSS must declaratively disable Safari selection and touch callouts',
);
assert.match(
  styles,
  /\.board-page input,[\s\S]*?\.board-page textarea,[\s\S]*?\[contenteditable="true"\][\s\S]*?-webkit-user-select:\s*text;/,
  'real text editors must retain native text selection',
);

const {
  startsStylusContact,
  stylusSafeTouchEvent,
} = await import('../src/fabricStylusTouchCompatibility.js');

let prevented = 0;
const stylusEvent = {
  changedTouches: [{ touchType: 'stylus' }],
  preventDefault() { prevented += 1; },
  stopPropagation() {},
  touches: [{ touchType: 'stylus' }],
};
assert.equal(startsStylusContact(stylusEvent), true,
  'a changed WebKit stylus touch must select the compatibility path');
const safeStylusEvent = stylusSafeTouchEvent(stylusEvent);
safeStylusEvent.preventDefault();
assert.equal(prevented, 0,
  'Fabric preventDefault must be neutralized only for the stylus wrapper event');
assert.equal(safeStylusEvent.touches, stylusEvent.touches,
  'the wrapper must preserve the native TouchEvent data Fabric uses for drawing');

const fingerEvent = { changedTouches: [{ touchType: 'direct' }] };
assert.equal(startsStylusContact(fingerEvent), false,
  'finger-only touchstart must stay on Fabric normal touch handling');

console.log('iPad stylus TouchEvent compatibility checks passed.');
