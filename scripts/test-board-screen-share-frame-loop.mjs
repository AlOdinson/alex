import { test } from 'node:test';
import assert from 'node:assert/strict';
import { frameFixture } from './screen-share-frame-fixture.mjs';

test('real media frames reuse static pixels and full native staging without setCoords churn', async t => {
  const h = frameFixture(); t.after(h.close);
  const copies = h.copies, coords = h.coords, paths = h.paths;
  for (let i = 0; i < 30; i++) {h.decode(i%2?'#ee5511':'#3355ee'); h.signal(); h.step();}
  assert.equal(h.media.frameCanvas.width,1920); assert.equal(h.media.frameCanvas.height,1080);
  assert.equal(h.copies-copies,30); assert.equal(h.coords,coords); assert.equal(h.paths,paths);
  assert.equal(h.canvas.nextRenderHandle,0,'static scene must not be redrawn for each video frame');
  assert.equal(h.frames.size,1); assert.equal(h.animations.size,1);
  h.media.dispose(); assert.equal(h.frames.size,0); assert.equal(h.animations.size,0);
});
test('hidden and offscreen frames skip staging and resume with latest video pixels', async t => {
  const h = frameFixture(); t.after(h.close); const copies = h.copies; h.doc.hidden = true;
  for (let i = 0; i < 5; i++) {h.decode(); h.signal(); h.step();}
  assert.equal(h.copies,copies);
  h.doc.hidden = false; h.media.object.set('left',10000); h.media.object.setCoords(); h.decode(); h.signal(); h.step();
  assert.equal(h.copies,copies);
  h.media.object.set('left',60); h.media.object.setCoords(); h.decode('#11dd33'); h.signal(); h.step();
  assert.equal(h.copies,copies+1);
  assert.deepEqual([...h.media.frameCanvas.getContext('2d').getImageData(1900,1060,1,1).data],[17,221,51,255]);
});
test('no-callback progress clock is single, restartable, visibility gated and disposed', async t => {
  const h = frameFixture({callback:false}); t.after(h.close);
  assert.equal(h.animations.size,1); assert.equal(h.intervals.size,0);
  const copies = h.copies; h.doc.hidden = true; h.decode(); h.step(); assert.equal(h.copies,copies);
  h.doc.hidden = false; h.media.setStream({}); h.step(); h.full(); assert.equal(h.animations.size,1);
  h.media.setStream(null); h.full(); assert.equal(h.animations.size,0);
  h.media.setStream({}); assert.equal(h.animations.size,1);
  h.media.dispose(); h.full(); assert.equal(h.animations.size,0);
});
test('metadata size changes update full staging geometry once and refresh the scene', async t => {
  const h = frameFixture(); t.after(h.close); const coords = h.coords;
  h.video.videoWidth=1600; h.video.videoHeight=1000; h.decode(); h.signal(); h.step();
  assert.equal(h.media.frameCanvas.width,1600); assert.equal(h.media.frameCanvas.height,1000);
  assert.equal(h.coords,coords+1); assert.equal(h.media.object.width,1600); assert.equal(h.media.object.height,1000);
  assert.ok(h.canvas.nextRenderHandle); h.full(); h.decode(); h.signal(); h.step();
  assert.equal(h.coords,coords+1); assert.equal(h.canvas.nextRenderHandle,0);
});
test('presenter Ultra UI state cannot restart or throttle a receiver progress clock', async t => {
  const h = frameFixture({callback:false}); t.after(h.close);
  const before = [...h.animations.keys()];
  for (const enabled of [true,false,true]) {
    const event = new Event('alex-screen-share-ultra-state'); event.detail={sessionId:'',enabled,visible:false}; h.win.dispatchEvent(event);
    assert.deepEqual([...h.animations.keys()],before,'local UI state must not control receiver cadence');
  }
  h.decode(); h.step(); assert.equal(h.media.frameCanvas.width,1920); assert.equal(h.media.frameCanvas.height,1080);
});
test('pending scene renders consume the newest staged frame and coalesce requests', async t => {
  const h = frameFixture(); t.after(h.close);
  h.canvas.requestRenderAll(); const pending = h.canvas.nextRenderHandle, paths = h.paths;
  for (const color of ['#ff0000','#0000ff','#33ee44']) {h.decode(color); h.signal(); assert.equal(h.canvas.nextRenderHandle,pending);}
  assert.equal(h.paths,paths); h.step();
  assert.equal(h.paths,paths+1);
  assert.deepEqual([...h.canvas.contextContainer.getImageData(70,45,1,1).data],[51,238,68,255]);
});
