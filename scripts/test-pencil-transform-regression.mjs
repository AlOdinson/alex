import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const boardSource = await readFile(new URL('../src/components/Board.jsx', import.meta.url), 'utf8');
const toolbarSource = await readFile(new URL('../src/components/Toolbar.jsx', import.meta.url), 'utf8');

for (const removedCompositorSymbol of [
  'penTransformIsolationRef',
  'beginPenTransformIsolation',
  'finishPenTransformIsolation',
  'pen-transform-origin-patch',
  'pen-transform-moving-overlay',
  'pen-transform-controls-overlay',
]) {
  assert.equal(
    boardSource.includes(removedCompositorSymbol),
    false,
    `Pencil compositor regression: ${removedCompositorSymbol}`,
  );
}

for (const blockedFabricRenderAssignment of [
  'canvas.requestRenderAll =',
  'canvas.renderAll =',
  'canvas.renderTop =',
]) {
  assert.equal(
    boardSource.includes(blockedFabricRenderAssignment),
    false,
    `Fabric rendering must never remain replaced: ${blockedFabricRenderAssignment}`,
  );
}

assert.match(boardSource, /addEventListener\('lostpointercapture', handlePalmPointerEnd/);
assert.match(boardSource, /removeEventListener\('lostpointercapture', handlePalmPointerEnd/);
assert.match(boardSource, /selectionSession\.nextMoveAt = moveNow \+ 8/);
assert.doesNotMatch(boardSource, /selectionSession\.moveFramePending/);
assert.doesNotMatch(boardSource, /canvas\.perPixelTargetFind = true/);
assert.match(
  boardSource,
  /canvas\.perPixelTargetFind = Boolean\(pen && !isActiveSelectionObject\(activeTarget\)\)/,
);

const transformCommitSource = boardSource.slice(
  boardSource.indexOf("canvas.on('object:modified'"),
  boardSource.indexOf('const refreshSelectionUi'),
);
assert.match(transformCommitSource, /queueDeferredTransformPersistence\(recordInputs\)/);
assert.doesNotMatch(transformCommitSource, /requestAnimationFrame/);

assert.doesNotMatch(toolbarSource, /window\.requestAnimationFrame/);

// Model thirty immediate Pencil contacts. A time deadline may drop excess coalesced move
// samples, but ending a contact always resets it synchronously and never needs a frame.
const session = { active: false, pointerId: null, nextMoveAt: 0 };
for (let gesture = 0; gesture < 30; gesture += 1) {
  session.active = true;
  session.pointerId = gesture + 1;
  session.nextMoveAt = 1000 + gesture * 10 + 8;
  session.active = false;
  session.pointerId = null;
  session.nextMoveAt = 0;
  assert.deepEqual(session, { active: false, pointerId: null, nextMoveAt: 0 });
}

console.log('Pencil transform regression tests passed.');
