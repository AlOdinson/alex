import { test } from 'node:test';
import assert from 'node:assert/strict';
import { frameFixture } from './screen-share-frame-fixture.mjs';

test('receiver recovers decoded progress when video callbacks arrive only twice per second', async t => {
  const h = frameFixture(); t.after(h.close); const before = h.copies;
  for (let i = 1; i <= 120; i++) { h.decode(); if (i % 30 === 0) h.signal(); h.step(); }
  assert.ok(h.copies - before >= 105, `only ${h.copies - before} of 120 fresh frames copied`);
  assert.ok(h.copies - before <= 120, 'do not duplicate counter-identifiable frames');
});
test('video notification re-arms before rendering and coalesces a burst to the latest frame', async t => {
  const h = frameFixture(); t.after(h.close); const before = h.copies;
  for (const color of ['#ff0000', '#0000ff', '#33ee44']) { h.decode(color); h.signal(); }
  assert.equal(h.frames.size, 1, 'keep the next video notification armed');
  assert.equal(h.copies, before, 'do not copy or composite inside the video notification');
  h.step(); assert.equal(h.copies, before + 1);
  assert.deepEqual([...h.media.frameCanvas.getContext('2d').getImageData(0, 0, 1, 1).data], [51,238,68,255]);
});
test('unchanged decoder progress is not recopied, including a delayed callback for the same frame', async t => {
  const h = frameFixture(); t.after(h.close);
  h.decode(); h.step(); const copies = h.copies;
  for (let i = 0; i < 30; i++) { h.video.currentTime += .016; h.step(); }
  h.signal(); h.step(); assert.equal(h.copies, copies, 'known unchanged frame must not be copied on a clock tick');
});
test('receiver without video callback API follows input frames, not sender-only local Ultra state', async t => {
  const h = frameFixture({ callback: false }); t.after(h.close); const before = h.copies;
  for (let i = 0; i < 60; i++) { h.decode(); h.step(); }
  assert.equal(h.copies - before, 60, 'viewer fallback must not be capped to the old 66ms interval');
});
test('counterless playback recovers a stalled notification using advancing media time', async t => {
  const h = frameFixture({ counters: false }); t.after(h.close); const before = h.copies;
  for (let i = 1; i <= 90; i++) { h.decode(); if (i % 30 === 0) h.signal(); h.step(); }
  assert.ok(h.copies - before > 50, 'progress fallback cannot remain stuck at two notifications per second');
  const copies = h.copies; for (let i = 0; i < 30; i++) h.step();
  assert.equal(h.copies, copies, 'stopped media time must not repeatedly stage the same image');
});
test('hidden, offscreen and paused receivers do no copying and resume with latest available pixels', async t => {
  const h = frameFixture(); t.after(h.close); const before = h.copies; h.doc.hidden = true;
  for (let i = 0; i < 5; i++) { h.decode(); h.signal(); h.step(); }
  assert.equal(h.copies, before);
  h.doc.hidden = false; h.media.object.set('left', 10000); h.media.object.setCoords(); h.step();
  assert.equal(h.copies, before);
  h.media.object.set('left', 60); h.media.object.setCoords(); h.decode('#11dd33'); h.step();
  assert.equal(h.copies, before + 1);
  h.video.paused = true; h.decode(); h.signal(); h.step(); assert.equal(h.copies, before + 1);
  h.video.paused = false; h.step(); assert.equal(h.copies, before + 2);
});
test('stream replacement/disposal cancels clocks and stale callbacks cannot resurrect a loop', async t => {
  const h = frameFixture(); t.after(h.close);
  const stale = [...h.frames.values()][0]; h.media.setStream({}); h.step();
  stale(0, {mediaTime: 0, presentedFrames: 0});
  assert.equal(h.frames.size, 1, 'only the replacement stream has an active video callback');
  const late = [...h.frames.values()][0]; const copies = h.copies;
  h.media.setStream(null); late(100, {}); h.step();
  assert.equal(h.frames.size, 0); assert.equal(h.copies, copies);
  h.media.dispose(); h.step();
  assert.equal(h.frames.size, 0); assert.equal(h.intervals.size, 0);
  assert.equal(h.animations.size, 0); assert.equal(h.timers.size, 0);
});
test('a transient staging failure retries without new callbacks or a lost frame', async t => {
  const h = frameFixture(); t.after(h.close);
  const context = h.media.frameCanvas.getContext('2d'), original = context.drawImage;
  let fail = true;
  context.drawImage = function (...args) { if (fail && args[0] === h.video) { fail = false; throw Error('temporary video frame unavailable'); } return original.apply(this, args); };
  const copies = h.copies; h.decode(); h.step(); h.step();
  assert.equal(h.copies, copies + 1, 'same available frame must be retried on the next display tick');
});

// A decoder counter and a displayed-frame counter are distinct browser signals.
test('decoder progress is not vetoed when the native displayed count stays constant', async t => {
  const h = frameFixture(); t.after(h.close); let received=10;
  h.video.getVideoPlaybackQuality = () => ({totalVideoFrames:received, droppedVideoFrames:received-2});
  Object.defineProperty(h.video, 'webkitDecodedFrameCount', {get:()=>received});
  h.step(); const copies=h.copies;
  for (let i=0;i<60;i++) {received++; h.decode(); if(i%30===0)h.signal(); h.step();}
  assert.ok(h.copies-copies>=55, 'displayed minus dropped is not a decoder freshness marker');
});
