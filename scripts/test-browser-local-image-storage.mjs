import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { copySerializedBoardImages } from '../src/lib/imageStorage.js';

const source = await readFile(new URL('../src/lib/imageStorage.js', import.meta.url), 'utf8');

assert.doesNotMatch(source, /from ['"]\.\/supabase\.js['"]/);
assert.doesNotMatch(source, /board-assets/);
assert.doesNotMatch(source, /supabase\.storage/);
assert.match(source, /url:\s*await blobToDataUrl\(prepared\.blob\)/);

const original = {
  version: 2,
  canvas: {
    objects: [{
      type: 'image',
      boardObjectId: 'image-1',
      src: 'data:image/png;base64,AAAA',
      storagePath: null,
    }],
  },
};
const copied = await copySerializedBoardImages(original, 'target-board');
assert.deepEqual(copied, original, 'self-contained browser images should copy without any network rewrite');
assert.notStrictEqual(copied, original, 'copying serialized board images must not return the mutable source object');
assert.notStrictEqual(copied.canvas, original.canvas);

console.log('Browser-only durable image storage regression passed.');
