import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const boardSource = await readFile(new URL('../src/components/Board.jsx', import.meta.url), 'utf8');

const canvasConfigStart = boardSource.indexOf('const canvas = new Canvas(canvasElement, {');
const canvasConfigEnd = boardSource.indexOf('});', canvasConfigStart);
assert.ok(canvasConfigStart >= 0 && canvasConfigEnd > canvasConfigStart);
const canvasConfig = boardSource.slice(canvasConfigStart, canvasConfigEnd);

// Fabric's default mode is the input path used by the original 1.31.14 board: Apple
// Pencil free drawing is accepted through touchstart/touchmove/touchend. Enabling the
// PointerEvent-only mode here regressed rapid consecutive short strokes in iPad Safari.
assert.doesNotMatch(canvasConfig, /enablePointerEvents\s*:\s*true/);

const palmPointerStart = boardSource.indexOf('function handlePalmPointerDown');
const palmPointerEnd = boardSource.indexOf('function handlePalmPointerMove', palmPointerStart);
const palmPointerDown = boardSource.slice(palmPointerStart, palmPointerEnd);
assert.doesNotMatch(palmPointerDown, /shouldSuppressPenCompatibilityMouse|APP pen pointerdown claimed/,
  'The failed PointerEvent compatibility workaround must not intercept the original touch path');

// The dense-board transform optimization is independent of Fabric's event family and
// must remain in place, so restoring drawing does not restore the former O(all objects)
// scan on every move sample.
assert.match(boardSource, /const suppressTargetFindDuringTransform = \(\) =>/);
assert.match(boardSource, /canvas\.skipTargetFind = true;/);
const beforeTransformStart = boardSource.indexOf("canvas.on('before:transform'");
const beforeTransformEnd = boardSource.indexOf("canvas.on('object:modified'", beforeTransformStart);
assert.match(
  boardSource.slice(beforeTransformStart, beforeTransformEnd),
  /suppressTargetFindDuringTransform\(\);/,
);

// Restoring the browser input family must not bypass the authoritative per-action path.
const commitStart = boardSource.indexOf('function commitAddedObject');
const commitEnd = boardSource.indexOf('// A move/scale/rotate is durable', commitStart);
const commitAddedObject = boardSource.slice(commitStart, commitEnd);
assert.match(commitAddedObject, /sendRecordUpserts\(records\);/);
assert.match(commitAddedObject, /recordAction\(\{ type: 'add', records \}\);/);

console.log('Original Apple Pencil drawing path and fast transform invariants passed.');
