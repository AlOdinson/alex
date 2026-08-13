import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { ActiveSelection, Canvas, Rect } from 'fabric/node';

const OBJECT_COUNT = 3000;
const GESTURES = 30;
const MOVES_PER_GESTURE = 12;

function pointer(type, x, y, pointerId, buttons = 1) {
  return {
    type,
    clientX: x,
    clientY: y,
    button: 0,
    buttons,
    isPrimary: true,
    pointerId,
    pointerType: 'pen',
    preventDefault() {},
    stopPropagation() {},
  };
}

function createDenseCanvas({ suppressRepeatedTargetFind, groupSize }) {
  const canvas = new Canvas(null, {
    width: 1400,
    height: 900,
    enablePointerEvents: true,
    enableRetinaScaling: false,
    preserveObjectStacking: true,
    perPixelTargetFind: false,
  });

  // Put the draggable object(s) at the bottom of the stack. Without the transform
  // guard, Fabric must inspect every other object on every accepted move.
  const targetMembers = [];
  for (let index = 0; index < groupSize; index += 1) {
    const member = new Rect({
      left: 8 + (index % 8) * 18,
      top: 8 + Math.floor(index / 8) * 18,
      width: 12,
      height: 12,
      fill: '#2563eb',
      objectCaching: false,
    });
    targetMembers.push(member);
    canvas.add(member);
  }
  for (let index = groupSize; index < OBJECT_COUNT; index += 1) {
    const column = index % 65;
    const row = Math.floor(index / 65);
    canvas.add(new Rect({
      left: 220 + column * 18,
      top: 40 + row * 18,
      width: 12,
      height: 12,
      fill: index % 2 ? '#94a3b8' : '#cbd5e1',
      objectCaching: false,
    }));
  }
  const target = groupSize > 1
    ? new ActiveSelection(targetMembers, { canvas, objectCaching: false })
    : targetMembers[0];
  canvas.setActiveObject(target);

  // This benchmark isolates the input hot path. Browser rendering is separately
  // requestAnimationFrame-coalesced by Fabric and is not executed per raw sample.
  canvas.requestRenderAll = () => canvas;
  let targetSearches = 0;
  const originalSearch = canvas.searchPossibleTargets.bind(canvas);
  canvas.searchPossibleTargets = (...args) => {
    targetSearches += 1;
    return originalSearch(...args);
  };

  if (suppressRepeatedTargetFind) {
    let previousSkipTargetFind = null;
    canvas.on('before:transform', () => {
      if (previousSkipTargetFind != null) return;
      previousSkipTargetFind = canvas.skipTargetFind;
      canvas.skipTargetFind = true;
    });
    canvas.on('mouse:up:before', () => {
      if (previousSkipTargetFind == null) return;
      canvas.skipTargetFind = previousSkipTargetFind;
      previousSkipTargetFind = null;
    });
  }

  return { canvas, target, getTargetSearches: () => targetSearches };
}

async function runScenario(suppressRepeatedTargetFind, groupSize) {
  const { canvas, target, getTargetSearches } = createDenseCanvas({
    suppressRepeatedTargetFind,
    groupSize,
  });
  const startedAt = performance.now();
  for (let gesture = 0; gesture < GESTURES; gesture += 1) {
    const pointerId = gesture + 1;
    const center = target.getCenterPoint();
    let x = center.x;
    let y = center.y;
    canvas._onMouseDown(pointer('pointerdown', x, y, pointerId));
    assert.equal(canvas.getActiveObject() === target, true, `Target was not selected in gesture ${gesture + 1}`);
    for (let move = 0; move < MOVES_PER_GESTURE; move += 1) {
      x += 0.1;
      y += 0.05;
      canvas._onMouseMove(pointer('pointermove', x, y, pointerId));
    }
    canvas._onMouseUp(pointer('pointerup', x, y, pointerId, 0));
    assert.equal(canvas._currentTransform, null);
  }
  const elapsedMs = performance.now() - startedAt;
  const targetSearches = getTargetSearches();
  await canvas.dispose();
  return { elapsedMs, targetSearches };
}

function assertGuardedScenario(baseline, guarded) {
  assert.ok(
    baseline.targetSearches >= guarded.targetSearches + GESTURES * MOVES_PER_GESTURE,
    `Expected move-time target searches to be removed (${baseline.targetSearches} vs ${guarded.targetSearches})`,
  );
  assert.ok(
    guarded.targetSearches <= GESTURES * 2,
    `Only pointerdown may search for a target during guarded transforms (${guarded.targetSearches})`,
  );
  assert.ok(
    guarded.elapsedMs < baseline.elapsedMs,
    `Expected guarded hot path to be faster (${guarded.elapsedMs.toFixed(1)} vs ${baseline.elapsedMs.toFixed(1)} ms)`,
  );
}

function report(baseline, guarded) {
  return {
    baseline: {
      elapsedMs: Number(baseline.elapsedMs.toFixed(1)),
      targetSearches: baseline.targetSearches,
    },
    guarded: {
      elapsedMs: Number(guarded.elapsedMs.toFixed(1)),
      targetSearches: guarded.targetSearches,
    },
    speedup: Number((baseline.elapsedMs / guarded.elapsedMs).toFixed(1)),
  };
}

const singleBaseline = await runScenario(false, 1);
const singleGuarded = await runScenario(true, 1);
const groupBaseline = await runScenario(false, 48);
const groupGuarded = await runScenario(true, 48);
assertGuardedScenario(singleBaseline, singleGuarded);
assertGuardedScenario(groupBaseline, groupGuarded);

console.log(JSON.stringify({
  objects: OBJECT_COUNT,
  gestures: GESTURES,
  movesPerGesture: MOVES_PER_GESTURE,
  single: report(singleBaseline, singleGuarded),
  group48: report(groupBaseline, groupGuarded),
}));
