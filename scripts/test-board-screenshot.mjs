import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import {
  normalizeScreenshotRect,
  screenshotSceneBounds,
  captureBoardScreenshot,
  screenshotCanvasToBlob,
} from '../src/lib/boardScreenshot.js';

test('screenshot rectangle can be dragged backwards and is clipped to the viewport', () => {
  assert.deepEqual(
    normalizeScreenshotRect({ x: 540, y: 390 }, { x: -30, y: 20 }, { width: 500, height: 300 }),
    { left: 0, top: 20, right: 500, bottom: 300, width: 500, height: 280 },
  );
  assert.equal(normalizeScreenshotRect({ x: NaN, y: 10 }, { x: 20, y: 30 }, { width: 500, height: 300 }), null);
});

test('screenshot preserves scene position and size under zoom and pan', () => {
  assert.deepEqual(
    screenshotSceneBounds({ left: 100, top: 80, right: 300, bottom: 240 },
      [2, 0, 0, 2, -100, -60]),
    { left: 100, top: 70, width: 100, height: 80, centerX: 150, centerY: 110 },
  );
  const mirrored = screenshotSceneBounds({ left: 20, top: 10, right: 60, bottom: 30 },
    [-1, 0, 0, -1, 100, 90]);
  assert.equal(mirrored.width, 40);
  assert.equal(mirrored.height, 20);
  assert.equal(mirrored.centerX, 60);
  assert.equal(mirrored.centerY, 70);
});

test('screenshot copies the composited lower canvas at retina scale and caps its dimensions', () => {
  const framebuffer = { width: 4000, height: 2400 };
  let draw = null;
  let image;
  const doc = {
    createElement: (tag) => {
      assert.equal(tag, 'canvas');
      image = {
        width: 0, height: 0,
        getContext: () => ({ drawImage: (...args) => { draw = args; } }),
      };
      return image;
    },
  };
  const canvas = {
    lowerCanvasEl: framebuffer,
    getWidth: () => 2000,
    getHeight: () => 1200,
    viewportTransform: [2, 0, 0, 2, -40, 10],
  };
  const shot = captureBoardScreenshot(canvas, { left: 250, top: 200, right: 1250, bottom: 800 }, { doc });
  assert.equal(shot.bitmap, image);
  assert.equal(image.width, 1800);
  assert.equal(image.height, 1080);
  assert.deepEqual(draw, [framebuffer, 500, 400, 2000, 1200, 0, 0, 1800, 1080]);
  assert.deepEqual(shot.sceneRect, { left: 145, top: 95, width: 500, height: 300, centerX: 395, centerY: 245 });
});

test('tiny gestures produce no image and cannot allocate a bitmap', () => {
  const board = { lowerCanvasEl: { width: 800, height: 600 }, getWidth: () => 400, getHeight: () => 300 };
  assert.equal(captureBoardScreenshot(board,
    { left: 5, top: 5, right: 7, bottom: 6 },
    { doc: { createElement: () => { throw Error('must not allocate'); } } }), null);
});

test('PNG blob export handles success and capture failures', async () => {
  const blob = new Blob(['pixels'], { type: 'image/png' });
  assert.equal(await screenshotCanvasToBlob({ toBlob: callback => callback(blob) }), blob);
  await assert.rejects(screenshotCanvasToBlob({ toBlob: callback => callback(null) }), /скриншот/);
});

test('Board wires screenshot selection and reuses the durable image pipeline', () => {
  const board = fs.readFileSync(new URL('../src/components/Board.jsx', import.meta.url), 'utf8');
  assert.match(board, /className="screenshot-capture-overlay"/);
  assert.match(board, /onPointerDown=\{beginScreenshotGesture\}/);
  assert.match(board, /onPointerUp=\{finishScreenshotGesture\}/);
  assert.match(board, /captureBoardScreenshot\(canvas, rect\)/);
  assert.match(board, /screenshotCanvasToBlob\(screenshot\.bitmap\)/);
  assert.match(board, /addImageFiles\(\[file\], new Point/);
  assert.match(board, /screenshotPlacement\?\.selectOnInsert/);
  assert.match(board, /selectInsertedObjects\(\[object\]\)/);
  assert.match(board, /setTool\('select'\)/);
});
