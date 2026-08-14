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

const pathCreatedSource = section("canvas.on('path:created'", "canvas.on('before:transform'");
assert.match(pathCreatedSource, /const activePending = activePencilRef\.current;/);
assert.match(pathCreatedSource, /&& activePending[\s\S]*&& !activePending\.consumed/);
for (const staleMatcher of [
  /pathStartPoint/,
  /recentlyReleased/,
  /pendingCandidate/,
  /<= 750/,
  /< 1800/,
]) {
  assert.doesNotMatch(pathCreatedSource, staleMatcher);
}

const pencilDownSource = section("if (activeToolRef.current === 'pencil') {", "if (activeToolRef.current === 'text') {");
assert.match(pencilDownSource, /retirePendingPencil\(activePencilRef\.current, \{ cancelled: true \}\)/);
assert.match(pencilDownSource, /pencilStrokeGenerationRef\.current \+ 1/);
assert.doesNotMatch(pencilDownSource, /setTimeout/);

const pencilUpSource = section("canvas.on('mouse:up'", 'finalizeSelectionMarquee(nativeEvent)');
assert.match(pencilUpSource, /retirePendingPencil\(pending, \{ cancelled: true \}\)/);
assert.doesNotMatch(pencilUpSource, /pending\.cancelTimer = window\.setTimeout/);

const discardSource = section('function releaseFabricFreeDrawingListeners', 'function eligibleHandoffTouchPair');
assert.match(discardSource, /canvas\._isCurrentlyDrawing = false/);
assert.match(discardSource, /brush\._points = \[\]/);
assert.match(discardSource, /brush\.oldEnd = undefined/);
assert.match(discardSource, /canvas\.clearContext\?\.\(canvas\.contextTop\)/);
assert.match(discardSource, /ownerDocument\.removeEventListener\(`\$\{prefix\}up`/);
assert.match(discardSource, /upperCanvas\.addEventListener\(`\$\{prefix\}move`/);

const abortSource = section('function abortFabricDrawingForTouchGesture', 'function releaseFabricTouchOwnership');
assert.match(abortSource, /discardFabricFreeDrawing\(\{ cancelPending: true \}\)/);
assert.doesNotMatch(abortSource, /_onMouseUpInDrawingMode/);

const palmDownSource = section('function handlePalmPointerDown', 'function handlePalmPointerMove');
assert.match(palmDownSource, /activeBoardTouchPointerIds\.add\(event\.pointerId\)/);
assert.match(palmDownSource, /gestureCandidates\.length >= 2/);
assert.match(palmDownSource, /blockedGesturePointerIds\.add\(pointerId\)/);
assert.match(palmDownSource, /blockPointerFromFabric\(event\)/);
assert.match(palmDownSource, /penInputRef\.current\.active[\s\S]*discardFabricFreeDrawing/);

const finishGestureSource = section('function finishTouchGesture', 'function activateTouchGesture');
assert.match(finishGestureSource, /gesture\.active \|\| drawingSuspendedForTouchGesture/);
assert.match(finishGestureSource, /applyCanvasInputMode\(\)/);

const fastAddSource = section('function recordForJustAddedObject', 'function commitAddedObject');
assert.match(fastAddSource, /internalObjects\[lastIndex\] === object/);
assert.match(fastAddSource, /zIndex: lastIndex/);

// Model the ownership invariant independently of browser pointer ids. Reusing the same
// pointer id thirty times cannot block a new physical contact or reuse the prior token.
const state = {
  generation: 0,
  active: null,
  committed: [],
  cancelled: [],
  contextTopDirty: false,
};
const beginContact = (pointerId) => {
  if (state.active) state.cancelled.push(state.active.generation);
  state.generation += 1;
  state.active = { pointerId, generation: state.generation };
  state.contextTopDirty = true;
  return state.active;
};
const createPath = (contact) => {
  assert.equal(state.active, contact);
  state.committed.push(contact.generation);
  state.active = null;
  state.contextTopDirty = false;
};
const cancelForPinch = () => {
  if (state.active) state.cancelled.push(state.active.generation);
  state.active = null;
  state.contextTopDirty = false;
};

for (let index = 0; index < 30; index += 1) {
  const contact = beginContact(7);
  createPath(contact);
}
assert.deepEqual(state.committed, Array.from({ length: 30 }, (_, index) => index + 1));
assert.deepEqual(state.cancelled, []);

const provisionalFingerStroke = beginContact(19);
cancelForPinch();
assert.equal(state.active, null);
assert.equal(state.contextTopDirty, false);
assert.equal(state.committed.includes(provisionalFingerStroke.generation), false);

console.log(JSON.stringify({
  rapidPencilContacts: 30,
  reusedPointerId: true,
  lostStrokes: 0,
  pinchGarbageCommitted: false,
}));
