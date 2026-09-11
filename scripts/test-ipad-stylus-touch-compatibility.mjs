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

console.log('iPad stylus TouchEvent compatibility source checks passed.');
