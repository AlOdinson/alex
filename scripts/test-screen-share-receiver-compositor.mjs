import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Canvas, FabricImage, Rect, getEnv } from 'fabric/node';
import { createBoardScreenShareCompositor } from '../src/lib/boardScreenShareCompositor.js';

function emptyScene(retina = 1) {
  const doc = getEnv().document, surfaces = [];
  const canvas = new Canvas(null, {width: 320, height: 240, renderOnAddRemove: false, preserveObjectStacking: true});
  canvas.getRetinaScaling = () => retina; canvas.setDimensions({width: 320, height: 240});
  const source = doc.createElement('canvas'); source.width = 160; source.height = 90;
  const video = new FabricImage(source, {left: 20, top: 30, transientScreenShare: true, objectCaching: false});
  canvas.add(video);
  canvas.on('before:render', ({ctx}) => {ctx.fillStyle = 'white'; ctx.fillRect(0,0,320,240);});
  const compositor = createBoardScreenShareCompositor({object: video, document: {hidden: false, createElement(tag) {
    const el = doc.createElement(tag); surfaces.push(el); return el;
  }}});
  const paint = color => {const ctx = source.getContext('2d'); ctx.fillStyle = color; ctx.fillRect(0,0,160,90);};
  const render = () => {canvas.cancelRequestedRender(); canvas.renderAll();};
  const pixels = () => Buffer.from(canvas.contextContainer.getImageData(0,0,320*retina,240*retina).data);
  const close = async () => {compositor.dispose(); canvas.cancelRequestedRender(); await canvas.dispose();};
  paint('#44aaff'); render();
  return {canvas, video, compositor, surfaces, paint, render, pixels, close};
}

test('empty receiving scene allocates no full-window layer bitmaps, at DPR 1 and 2', async () => {
  for (const retina of [1,2]) {
    const h = emptyScene(retina);
    try {
      assert.equal(h.surfaces.length, 0, 'video-only board must not allocate two full-window canvas caches');
      for (let i = 0; i < 5; i++) {h.paint(i%2?'#ee3344':'#22dd55'); h.compositor.present();}
      const latest = h.pixels(); h.render(); assert.ok(latest.equals(h.pixels()), 'empty pixels match native render');
      assert.equal(h.canvas.nextRenderHandle, 0, 'presentation in display tick must not incur a second animation-frame wait');
    } finally {await h.close();}
  }
});
test('empty receiver native path preserves selection, pan/zoom, overlays and active drawing pixels', async t => {
  const h = emptyScene(2); t.after(h.close);
  h.canvas.setActiveObject(h.video); h.canvas.setViewportTransform([1.2,0,0,1.2,5,7]);
  h.canvas.overlayColor = 'rgba(255,0,0,.1)'; h.render();
  h.canvas.contextTop.fillStyle = 'blue'; h.canvas.contextTop.fillRect(4,5,10,10);
  // Simulate a native in-progress brush. It must not be cleared by video updates.
  h.canvas.isDrawingMode = true; h.canvas._isCurrentlyDrawing = true;
  const top = Buffer.from(h.canvas.contextTop.getImageData(0,0,50,50).data);
  h.paint('#ff9933'); h.compositor.present();
  const updated = h.pixels(); h.render(); assert.ok(updated.equals(h.pixels()), 'selected/overlay pixels match native render');
  assert.deepEqual(top, Buffer.from(h.canvas.contextTop.getImageData(0,0,50,50).data));
  assert.equal(h.surfaces.length, 0);
});
test('adding static content enables the existing cache and returning to empty releases it', async t => {
  const h = emptyScene(); t.after(h.close);
  const rect = new Rect({left: 40, top: 50, width: 60, height: 60, fill: 'rgba(0,0,0,.3)', objectCaching: false});
  h.canvas.add(rect); h.render(); assert.equal(h.surfaces.length, 2);
  let calls = 0; const renderRect = rect._render;
  rect._render = function (...args) {calls++; return renderRect.apply(this,args);};
  h.paint('#1199ff'); h.compositor.present(); assert.equal(calls, 0);
  const layered = h.pixels(); h.render(); assert.ok(layered.equals(h.pixels()), 'layered pixels match native render');
  h.canvas.remove(rect); h.render();
  assert.ok(h.surfaces.every(c => c.width === 0 && c.height === 0), 'no stale full-window layers on empty scene');
});
