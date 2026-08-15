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

assert.doesNotMatch(boardSource, /enablePointerEvents: true/,
  'Production canvas must retain the original iPad TouchEvent drawing path');
assert.doesNotMatch(boardSource, /addEventListener\('lostpointercapture', handlePalmPointerEnd/);
const selectionPenSessionSource = boardSource.slice(
  boardSource.indexOf('function beginSelectionPenSession'),
  boardSource.indexOf('function handlePalmPointerDown'),
);
assert.doesNotMatch(selectionPenSessionSource, /setPointerCapture|releasePointerCapture/);
assert.match(boardSource, /selectionSession\.nextMoveAt = moveNow \+ 16/);
assert.doesNotMatch(boardSource, /selectionSession\.moveFramePending/);
assert.match(boardSource, /function paintSelectionMarqueeImmediately\(\)/);
assert.match(boardSource, /selectionDrag\.end = new Point\(point\.x, point\.y\);\s*paintSelectionMarqueeImmediately\(\)/,
  'Pencil marquee feedback must be committed before transform move throttling');
const selectionMoveCaptureSource = boardSource.slice(
  boardSource.indexOf('function handlePalmPointerMove'),
  boardSource.indexOf('function handlePalmPointerEnd'),
);
assert.ok(
  selectionMoveCaptureSource.indexOf('paintSelectionMarqueeImmediately();')
    < selectionMoveCaptureSource.indexOf('const moveNow = performance.now();'),
  'The cheap Pencil marquee must bypass the 16 ms Fabric transform limiter',
);
assert.match(boardSource, /canvas\.perPixelTargetFind = Boolean\(pen\)/);
assert.match(boardSource, /const tolerance = 2/);
assert.match(boardSource, /canvas\.on\('mouse:down:before', restoreSelectionTargetFindBeforeFabricLogic\)/);
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

const marqueeFinalizeSource = boardSource.slice(
  boardSource.indexOf('function finalizeSelectionMarquee'),
  boardSource.indexOf("canvas.on('mouse:down'"),
);
assert.match(marqueeFinalizeSource, /queryTransformSpatialObjects\(selectionRect\)/,
  'Marquee selection must query only nearby indexed objects');
assert.doesNotMatch(marqueeFinalizeSource, /window\.requestAnimationFrame\s*\(/,
  'Marquee selection must exist before the next rapid Pencil contact');

const penReleaseSource = boardSource.slice(
  boardSource.indexOf('function handlePalmPointerEnd'),
  boardSource.indexOf('function activateObjectEraserPointer'),
);
assert.match(penReleaseSource, /const drawingToolNeedsPalmGrace = activeToolRef\.current === 'pencil'/);
assert.match(penReleaseSource, /penInputRef\.current\.suppressUntil = drawingToolNeedsPalmGrace\s*\? now \+ PENCIL_TOUCH_GRACE_MS\s*:\s*0/,
  'Selection/transform Pencil releases must have no 240 ms touch-side grace');

const staleTransformReleaseSource = boardSource.slice(
  boardSource.indexOf('function releaseStaleSelectionTransform'),
  boardSource.indexOf('function handlePalmPointerDown'),
);
assert.match(staleTransformReleaseSource, /canvas\.endCurrentTransform\(event\)/,
  'A Fabric transform missed by pointerup must be closed synchronously');
assert.match(staleTransformReleaseSource, /switchFabricInputMode\(true\)/,
  'Selection must be restored to direct PointerEvents without Fabric touch cooldown');
assert.match(staleTransformReleaseSource, /queueMicrotask\(\(\) =>/,
  'Post-pointerup ownership verification must run before the next native event');
assert.doesNotMatch(staleTransformReleaseSource, /setTimeout|requestAnimationFrame/,
  'Re-arming Pencil selection must not depend on a timer or rendered frame');

const beginSelectionSource = boardSource.slice(
  boardSource.indexOf('function beginSelectionPenSession'),
  boardSource.indexOf('function finishSelectionPenSession'),
);
assert.match(beginSelectionSource, /\|\| canvas\._currentTransform/,
  'A stale Fabric transform must be repaired even if the app session already ended');
assert.ok(
  beginSelectionSource.indexOf('releaseStaleSelectionTransform')
    < beginSelectionSource.indexOf('session.pointerId = event.pointerId'),
  'Previous transform ownership must be released before the new Pencil contact opens',
);

const pointerDownSource = boardSource.slice(
  boardSource.indexOf('function handlePalmPointerDown'),
  boardSource.indexOf('function handlePalmPointerMove'),
);
assert.ok(
  pointerDownSource.indexOf('beginSelectionPenSession(event);')
    < pointerDownSource.indexOf('armExactSelectionTargetFind({ pen: event.pointerType'),
  'Stale transform cleanup must precede exact hit-test arming for the new contact',
);

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
