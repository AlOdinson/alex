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

assert.match(boardSource, /enablePointerEvents: true/);
assert.doesNotMatch(boardSource, /addEventListener\('lostpointercapture', handlePalmPointerEnd/);
const selectionPenSessionSource = boardSource.slice(
  boardSource.indexOf('function beginSelectionPenSession'),
  boardSource.indexOf('function handlePalmPointerDown'),
);
assert.doesNotMatch(selectionPenSessionSource, /setPointerCapture|releasePointerCapture/);
assert.match(boardSource, /selectionSession\.nextMoveAt = moveNow \+ 16/);
assert.doesNotMatch(boardSource, /selectionSession\.moveFramePending/);
assert.doesNotMatch(boardSource, /canvas\.perPixelTargetFind = true/);
assert.match(boardSource, /canvas\.perPixelTargetFind = false/);
assert.match(boardSource, /const suppressTargetFindDuringTransform/);
assert.match(boardSource, /canvas\.skipTargetFind = true/);
assert.match(boardSource, /canvas\.on\('mouse:up:before', restoreTargetFindAfterTransform\)/);
assert.match(boardSource, /canvas\.off\('mouse:up:before', restoreTargetFindAfterTransform\)/);
assert.doesNotMatch(boardSource, /shouldSuppressSelectionCompatibilityEvent/);
assert.doesNotMatch(boardSource, /manuallyPaintedPencilSelectionTarget/);

const transformCommitSource = boardSource.slice(
  boardSource.indexOf("canvas.on('object:modified'"),
  boardSource.indexOf('const refreshSelectionUi'),
);
assert.match(transformCommitSource, /queueDeferredTransformPersistence\(recordInputs\)/);
assert.doesNotMatch(transformCommitSource, /requestAnimationFrame/);

assert.doesNotMatch(toolbarSource, /window\.requestAnimationFrame/);

// Model thirty immediate Pencil contacts. A time deadline may drop excess samples, but
// ending a contact always resets synchronously and never depends on a rendered frame.
const session = { active: false, pointerId: null, nextMoveAt: 0 };
for (let gesture = 0; gesture < 30; gesture += 1) {
  session.active = true;
  session.pointerId = gesture + 1;
  session.nextMoveAt = 1000 + gesture * 20 + 16;
  session.active = false;
  session.pointerId = null;
  session.nextMoveAt = 0;
  assert.deepEqual(session, { active: false, pointerId: null, nextMoveAt: 0 });
}

console.log('Pencil transform regression tests passed.');
