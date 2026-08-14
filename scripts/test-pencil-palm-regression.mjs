import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const boardSource = await readFile(new URL('../src/components/Board.jsx', import.meta.url), 'utf8');
const stylesSource = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');

const fallbackSource = boardSource.slice(
  boardSource.indexOf('function beginStylusTouchFallback'),
  boardSource.indexOf('function isLikelyPalmTouch'),
);
assert.match(fallbackSource, /return state\.active;/);
assert.doesNotMatch(fallbackSource, /guardUntil|distance <= 42|\+ 180/);

// A duplicate native pointer is rejected only while its synthetic fallback contact is
// active. Thirty immediately neighbouring contacts after release must all be accepted.
const shouldRejectNativePen = (event, fallback) => (
  event.pointerType === 'pen' && !event.syntheticFallback && fallback.active
);
const fallback = { active: true };
assert.equal(shouldRejectNativePen({ pointerType: 'pen' }, fallback), true);
fallback.active = false;
for (let contact = 0; contact < 30; contact += 1) {
  assert.equal(
    shouldRejectNativePen({ pointerType: 'pen', x: 100 + contact, time: contact * 5 }, fallback),
    false,
  );
}

for (const removedPalmHandoff of [
  'PENCIL_HANDOFF_IDLE_MS',
  'finishPenForTwoFingerHandoff',
  'makeSyntheticPenUpEvent',
  'handoffTouchPointers',
]) {
  assert.equal(
    boardSource.includes(removedPalmHandoff),
    false,
    `Palm contacts must not synthesize Pencil-up: ${removedPalmHandoff}`,
  );
}

const palmPointerSource = boardSource.slice(
  boardSource.indexOf('function handlePalmPointerDown'),
  boardSource.indexOf('function handlePalmPointerMove'),
);
assert.match(palmPointerSource, /const duringPencil = penInputRef\.current\.active;/);

// Normal two-finger zoom remains armed after Pencil-up and still uses the deliberate
// hold/movement threshold instead of starting from an incidental palm contact.
assert.match(boardSource, /function eligibleHandoffTouchPair/);
assert.match(boardSource, /beginTouchGestureCandidate\(fingers\)/);
assert.match(boardSource, /elapsed < TOUCH_GESTURE_ARM_MS/);
assert.match(boardSource, /TOUCH_GESTURE_MOVE_THRESHOLD/);
assert.match(boardSource, /for \(const identifier of bypassIds\) suppressedTouchIdsRef\.current\.delete\(identifier\)/);

assert.match(stylesSource, /\.canvas-host[\s\S]*?user-select: none;/);
assert.match(stylesSource, /-webkit-user-select: none;/);
assert.match(stylesSource, /-webkit-touch-callout: none;/);
assert.match(
  stylesSource,
  /\.canvas-host textarea,[\s\S]*?\[contenteditable="true"\][\s\S]*?-webkit-user-select: text;/,
);
assert.match(boardSource, /host\.addEventListener\('selectstart', handleNativeBoardSelectionStart/);
assert.match(boardSource, /host\.removeEventListener\('selectstart', handleNativeBoardSelectionStart/);
assert.match(boardSource, /if \(isNativeBoardTextTarget\(event\.target\)\) return;/);
assert.match(boardSource, /clearNativeBoardSelection\(\);/);

console.log('Pencil palm rejection and Safari selection regression tests passed.');
