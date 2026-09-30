import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { screenRectToSceneRect, boundedCursorIntersection, createCursorVisibilityController } from '../src/lib/cursorVisibility.js';

test('cursor/name rectangles use board offset, pan and zoom', () => {
  assert.deepEqual(screenRectToSceneRect({ left: 130, top: 240, right: 170, bottom: 260 },
    { left: 10, top: 20 }, [2, 0, 0, 2, 100, 200]),
  { left: 10, top: 10, right: 30, bottom: 20, width: 20, height: 10 });
});

test('precise nearby probes detect ink but have a fixed per-rectangle budget', () => {
  let probes = 0;
  const objects = Array.from({ length: 10000 }, (_, id) => ({ id }));
  assert.equal(boundedCursorIntersection(objects, () => { probes++; return false; }), true);
  assert.equal(probes, 8);
  assert.equal(boundedCursorIntersection(objects.slice(0, 2), () => false), false);
  assert.equal(boundedCursorIntersection(objects.slice(0, 2), (object) => object.id === 1), true);
  assert.equal(boundedCursorIntersection([], () => true), false);
});

test('either arrow or name dims the whole cursor and restores it after content moves', () => {
  const dom = new JSDOM('<div id="root"><div class="remote-cursor"><span class="remote-cursor-arrow"></span><span class="remote-cursor-name">Alex</span></div></div>');
  const root = dom.window.document.querySelector('#root');
  const cursor = root.firstElementChild;
  const box = (left, top, width, height) => ({left, top, width, height, right:left + width, bottom:top + height});
  const arrow = cursor.firstElementChild;
  const name = cursor.lastElementChild;
  arrow.getBoundingClientRect = () => box(10, 10, 20, 20);
  name.getBoundingClientRect = () => box(40, 25, 60, 20);
  let contentX = 80;
  let time = 0;
  const frames = new Map();
  let id = 0;
  let queries = 0;
  const controller = createCursorVisibilityController({root,
    getCanvasRect: () => box(0, 0, 500, 500), getViewport: () => [1,0,0,1,0,0],
    intersects: (rect) => { queries++; return rect.left <= contentX && rect.right >= contentX; },
    now: () => time,
    requestFrame: (callback) => {frames.set(++id, callback); return id;},
    cancelFrame: (frame) => frames.delete(frame),
  });
  const flush = () => {for(let count = 0; frames.size && count < 10; count++) {
    time += 16; const callbacks = [...frames.values()];frames.clear();callbacks.forEach((callback) => callback());
  } assert.equal(frames.size, 0, 'no permanent cursor animation loop');};
  controller.refresh({motion:true});flush();
  assert.equal(cursor.dataset.overlap, 'true', 'name overlap fades arrow and name together');
  const oldQueries = queries;
  controller.refresh();flush();
  assert.equal(queries, oldQueries, 'unchanged geometry and scene reuse the result');
  contentX = 20;controller.refresh({invalidate:true});flush();
  assert.equal(cursor.dataset.overlap, 'true', 'arrow alone also causes fading');
  contentX = 150;controller.refresh({invalidate:true});flush();
  assert.equal(cursor.dataset.overlap, 'false');
  controller.refresh({motion:true});controller.dispose();assert.equal(frames.size,0);
  dom.window.close();
});
