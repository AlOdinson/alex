import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const boardSource = await readFile(new URL('../src/components/Board.jsx', import.meta.url), 'utf8');

const section = (start, end) => {
  const startIndex = boardSource.indexOf(start);
  const endIndex = boardSource.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `Missing section start: ${start}`);
  assert.notEqual(endIndex, -1, `Missing section end: ${end}`);
  return boardSource.slice(startIndex, endIndex);
};

const startSource = section('function beginStylusTouchFallback', 'function moveStylusTouchFallback');
assert.match(startSource, /findChangedStylusTouch\(event\)/);
assert.doesNotMatch(startSource, /if \(penInputRef\.current\.active[^\n]*return false/);
assert.match(startSource, /stylusTouchMatchesNativePointer/);
assert.match(startSource, /cancelStalePenContact\(\)/);
assert.match(startSource, /mode: 'synthetic'/);

const finishSource = section('function finishStylusTouchFallback', 'function shouldRejectNativePenAfterTouchFallback');
assert.match(finishSource, /nativeContactStillOpen/);
assert.match(finishSource, /nativeBridge: true/);
assert.match(finishSource, /rejectedPointerIdsRef\.current\.add\(state\.pointerId\)/);

const rejectSource = section('function shouldRejectNativePenAfterTouchFallback', 'function isLikelyPalmTouch');
assert.match(rejectSource, /state\.active && state\.mode === 'synthetic'/);

// Model the two WebKit streams as one physical-contact state machine. The previous
// implementation lost contact N+1 whenever contact N had no native pointerup because
// stylus touchstart returned immediately while pen.active was still true.
class PencilContactArbiter {
  serial = 0;
  pen = null;
  touch = null;
  committed = [];
  cancelled = [];
  rejectedNativeDowns = 0;

  nativeDown({ pointerId, time, x, y }) {
    if (this.touch?.mode === 'synthetic') {
      this.rejectedNativeDowns += 1;
      return null;
    }
    if (this.pen) this.cancelPen();
    const contact = {
      serial: ++this.serial,
      pointerId,
      source: 'native',
      time,
      x,
      y,
    };
    this.pen = contact;
    return contact;
  }

  stylusStart({ touchId, time, x, y }) {
    const sameNative = this.pen?.source === 'native'
      && !this.touch
      && Math.abs(time - this.pen.time) <= 32
      && Math.hypot(x - this.pen.x, y - this.pen.y) <= 24;
    if (sameNative) {
      this.touch = {
        mode: 'native',
        touchId,
        pointerId: this.pen.pointerId,
        serial: this.pen.serial,
      };
      return this.pen;
    }
    if (this.touch || this.pen) this.cancelPen();
    const contact = {
      serial: ++this.serial,
      pointerId: 1_500_000_000 + touchId,
      source: 'synthetic',
      time,
      x,
      y,
    };
    this.pen = contact;
    this.touch = {
      mode: 'synthetic',
      touchId,
      pointerId: contact.pointerId,
      serial: contact.serial,
    };
    return contact;
  }

  nativeUp(pointerId) {
    if (!this.pen || this.pen.pointerId !== pointerId) return false;
    this.committed.push(this.pen.serial);
    this.pen = null;
    return true;
  }

  stylusEnd(touchId) {
    if (!this.touch || this.touch.touchId !== touchId) return false;
    if (this.pen && this.pen.serial === this.touch.serial) {
      this.committed.push(this.pen.serial);
      this.pen = null;
    }
    this.touch = null;
    return true;
  }

  cancelPen() {
    if (this.pen) this.cancelled.push(this.pen.serial);
    this.pen = null;
    this.touch = null;
  }
}

const arbiter = new PencilContactArbiter();
for (let index = 0; index < 60; index += 1) {
  const time = index * 80;
  const x = 100 + index * 3;
  const touchId = index % 2; // iPadOS is allowed to reuse identifiers.
  if (index % 3 === 1) {
    // Native pointerdown is missing: TouchEvent must create the stroke.
    arbiter.stylusStart({ touchId, time, x, y: 100 });
  } else {
    arbiter.nativeDown({ pointerId: 7, time, x, y: 100 });
    arbiter.stylusStart({ touchId, time: time + 2, x, y: 100 });
  }
  if (index % 3 === 0) {
    // Native pointerup is missing: matching stylus touchend must close the stroke.
    arbiter.stylusEnd(touchId);
  } else {
    arbiter.nativeUp(arbiter.pen.pointerId);
    arbiter.stylusEnd(touchId);
  }
}
assert.equal(arbiter.committed.length, 60);
assert.equal(new Set(arbiter.committed).size, 60);
assert.equal(arbiter.pen, null);
assert.equal(arbiter.touch, null);

// Even if both end events of one contact are absent, the following changed stylus
// touchstart supersedes it immediately instead of being swallowed.
const omittedEnd = new PencilContactArbiter();
omittedEnd.nativeDown({ pointerId: 9, time: 0, x: 50, y: 50 });
omittedEnd.stylusStart({ touchId: 4, time: 1, x: 50, y: 50 });
const recovered = omittedEnd.stylusStart({ touchId: 4, time: 100, x: 70, y: 50 });
assert.equal(recovered.source, 'synthetic');
assert.equal(omittedEnd.cancelled.length, 1);
omittedEnd.stylusEnd(4);
assert.equal(omittedEnd.committed.length, 1);

console.log(JSON.stringify({
  alternatingPencilContacts: 60,
  omittedNativeDownsRecovered: 20,
  omittedNativeUpsRecovered: 20,
  reusedTouchIdentifiers: true,
  lostStrokes: 0,
}));
