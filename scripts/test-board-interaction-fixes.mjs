import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
  hasTeacherCameraMoved,
  enableContinuousRotation,
  clearSelectionsForNewStroke,
} from '../src/lib/boardInteractionFixes.js';

test('autopilot ignores teacher heartbeat and reconnect response with unchanged view', () => {
  const previous = { centerX: 151.123, centerY: -40.004, zoom: 0.9567, clientId: 'owner' };
  assert.equal(hasTeacherCameraMoved(null, previous), true);
  assert.equal(hasTeacherCameraMoved(previous, { ...previous, receivedAt: 123, force: true }), false);
  assert.equal(hasTeacherCameraMoved(previous, { ...previous, centerX: 151.12301 }), false);
  assert.equal(hasTeacherCameraMoved(previous, { ...previous, centerY: -40.003 }), true);
  assert.equal(hasTeacherCameraMoved(previous, { ...previous, zoom: 0.9568 }), true);
  assert.equal(hasTeacherCameraMoved(previous, { ...previous, centerX: 151.123, zoom: NaN }), false);
});

test('smooth rotation removes 90-degree snapping only for active rotation gestures', () => {
  const target = { snapAngle: 90, snapThreshold: 45, lockRotation: false };
  assert.equal(enableContinuousRotation({ action: 'scale', corner: 'br', target }), false);
  assert.equal(target.snapAngle, 90);
  assert.equal(enableContinuousRotation({ action: 'rotate', corner: 'mtr', target }), true);
  assert.equal(target.snapAngle, 0);
  assert.equal(target.snapThreshold, 0);
  const locked = { lockRotation: true, snapAngle: 90, snapThreshold: 45 };
  assert.equal(enableContinuousRotation({ action: 'rotate', target: locked }), true);
  assert.equal(locked.snapAngle, 0);
  assert.equal(locked.snapThreshold, 0);
  assert.equal(locked.lockRotation, true, 'clearing snap must not unlock the object');
});

test('starting a pencil, line or shape clears both Fabric selection and native menu text', () => {
  const events = [];
  const canvas = {
    active: { id: 'selected-path' },
    getActiveObject() { return this.active; },
    discardActiveObject() { events.push('discard'); this.active = null; },
  };
  const browserSelection = {
    rangeCount: 2,
    removeAllRanges() { events.push('clearNative'); this.rangeCount = 0; },
  };
  assert.deepEqual(clearSelectionsForNewStroke(canvas, browserSelection),
    { clearedNative: true, clearedObject: true });
  assert.deepEqual(events, ['clearNative', 'discard']);
  assert.deepEqual(clearSelectionsForNewStroke(canvas, browserSelection),
    { clearedNative: false, clearedObject: false });
});

test('Board applies free rotation on Fabric transform, follows teacher movement only and clears selection on strokes', () => {
  const board = readFileSync(new URL('../src/components/Board.jsx', import.meta.url), 'utf8');
  assert.match(board, /enableContinuousRotation\(transform\)/);
  assert.match(board, /const beginLeasedTransform = \(\) => \{[\s\S]*?enableContinuousRotation\(transform\)/);
  assert.match(board, /installContinuousCornerRotation\(active\)/);
  assert.match(board, /actionName: 'rotate',\s*actionHandler: controlsUtils\.rotationWithSnapping/);
  assert.match(board, /hasTeacherCameraMoved\(previousView, message\)/);
  assert.match(board, /if \(!isOwner && autopilotRef\.current\) stopAutopilotAnimation\(\)/);
  assert.match(board, /function clearSelectionsOnDrawingContact\(event\)/);
  assert.match(board, /clearSelectionsForNewStroke\(canvas, window\.getSelection\?\.\(\)\)/);
  assert.match(board, /clearSelectionsOnDrawingContact\(event\)/);
  assert.match(board, /clearSelectionsOnDrawingContact\(nativeEvent\)/);
  assert.match(board, /clearNativeBoardSelection\(\{ anywhere: Boolean\(drawingNow\) \}\)/);
  assert.match(board, /if \(hasMoved && autopilotRef\.current\)/);
});
