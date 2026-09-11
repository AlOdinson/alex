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
