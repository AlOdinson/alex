import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createTeacherObjectLockAuthority } from '../src/lib/teacherObjectLocks.js';

// Execute the production callback bodies, not a copied model of the fix. Transport
// latency and Fabric's active-gesture identity are controlled by the fixture.
const source = readFileSync(new URL('../src/components/Board.jsx', import.meta.url), 'utf8');
const leaseStart = source.indexOf('  const selectionObjectIds = useCallback(');
const leaseEnd = source.indexOf('  const getLiveTransformObjects = useCallback(', leaseStart);
const transformEnd = source.indexOf('    const broadcastLiveTransform =');
const previousHandlerEnd = '      commitAddedObject(path);\n    });';
const transformStart = source.lastIndexOf(previousHandlerEnd, transformEnd) + previousHandlerEnd.length;
assert.ok(leaseStart > 0 && leaseEnd > leaseStart && transformEnd > transformStart);
const callbacks = source.slice(leaseStart, leaseEnd) + source.slice(transformStart, transformEnd)
  + '\nglobalThis.leaseApi = { acquireLocalSelectionLease, releaseLocalSelectionLease, ownsSelectionLease };';
const noop = () => {};
const ref = (current) => ({ current });

function fixture() {
  let sequence = 0;
  const now = 1_000_000;
  const authority = createTeacherObjectLockAuthority({ now: () => now });
  const target = {
    boardObjectId: 'inserted-image', objectKind: 'image',
    lockMovementX: false, lockMovementY: false, lockScalingX: false,
    lockScalingY: false, lockRotation: false, hasControls: true,
    left: 100, top: 80, scaleX: 1, scaleY: 1,
  };
  const state = { active: target, starts: 0, calls: 0, requests: 0, statuses: [] };
  const handlers = new Map();
  const nativeListeners = new Map();
  const replies = [];
  const canvas = {
    _currentTransform: null,
    on: (name, handler) => handlers.set(name, handler),
    getActiveObject: () => state.active,
    discardActiveObject: () => { state.active = null; },
    requestRenderAll: noop,
  };
  target.canvas = canvas;
  const records = (objects) => objects.map((object) => ({ object: {
    boardObjectId: object.boardObjectId,
    left: object.left, top: object.top, scaleX: object.scaleX, scaleY: object.scaleY,
  } }));
  const context = {
    console: { ...console, warn: noop }, Date: { now: () => now }, canvas, disposed: false,
    useCallback: (fn) => fn,
    flattenTarget: (object) => object ? [object] : [],
    fabricCanvasRef: ref(canvas), activeToolRef: ref('select'),
    selectionLeaseInteractionStateRef: ref(new Map()),
    selectionLeaseRef: ref({ generation: 0, token: null, ids: [], state: 'none', promise: null, expiresAt: 0 }),
    canEditRef: ref(true), applyingRemoteRef: ref(false), applyingHistoryRef: ref(false),
    isBoardScreenShareObject: (object) => Boolean(object?.transientScreenShare),
    randomToken: () => `lease-token-${++sequence}`, localLockIdsRef: ref([]), remoteLocksRef: ref(new Map()),
    realtimeRef: ref({ sendLock: noop }),
    boardId: 'test-board', boardKey: 'test-key', clientIdRef: ref('student'),
    acquireBoardObjectLocks: (_board, _key, clientId, lockToken, objectIds) => {
      state.requests++;
      const result = authority.acquire({ clientId, lockToken, objectIds, ttlMs: 12_000 });
      return new Promise((resolve, reject) => replies.push({ result, resolve, reject }));
    },
    releaseBoardObjectLocks: async (_board, _key, clientId, lockToken) => authority.release({ clientId, lockToken }),
    applyObjectInteractivityToObjects: noop,
    registeredObjectsById: (id) => id === target.boardObjectId ? [target] : [],
    updateSelectionState: noop, updateSelectionStyleState: noop, setRemoteLocks: noop,
    setSaveStatus: (message) => state.statuses.push(message), setSyncTone: noop,
    transientStatusTimerRef: ref(null), window: {
      clearTimeout: noop, setTimeout: () => 1,
      addEventListener(name, handler) {
        if (!nativeListeners.has(name)) nativeListeners.set(name, new Set());
        nativeListeners.get(name).add(handler);
      },
      removeEventListener(name, handler) { nativeListeners.get(name)?.delete(handler); },
    },
    modifiedBeforeRecordsRef: ref([]), modifiedBeforeRef: ref([]),
    currentTransformStartRef: ref(null), currentTransformMovedRef: ref(false),
    suppressTargetFindDuringTransform: noop,
    selectionPenSessionRef: ref({ active: false }), penInputRef: ref({ active: false }),
    transformGestureRef: ref({}), transformViewportPatchRects: () => [],
    beginLiveTransform: () => { state.starts++; return `gesture-${state.starts}`; },
    lastLockBroadcastRef: ref(0),
    transformFramesForObjects: records, getObjectRecords: records, sendLocalLock: noop,
  };
  vm.runInNewContext(callbacks, context, { filename: 'Board.jsx:selection-lease-transform' });
  return {
    target, canvas, state, context, authority, api: context.leaseApi,
    endPointer(type = 'pointercancel', pointerId = 1) {
      for (const handler of [...(nativeListeners.get(type) ?? [])]) handler({ type, pointerId });
    },
    listenerCount: () => [...nativeListeners.values()].reduce((sum, set) => sum + set.size, 0),
    async reply({ reject = false } = {}) {
      assert.ok(replies.length, 'a permission reply must be pending');
      const next = replies.shift();
      if (reject) next.reject(new Error('simulated connection loss'));
      else next.resolve(next.result);
      await new Promise(setImmediate);
    },
    gesture(action = 'drag', pointerType = 'mouse') {
      const original = function (event, transform, x = 140, y = 120) {
        state.calls++;
        assert.equal(transform.target, target);
        if (action === 'drag') {
          if (target.lockMovementX || target.lockMovementY) return false;
          target.left = x; target.top = y;
        } else {
          if (target.lockScalingX || target.lockScalingY) return false;
          target.scaleX = x / 100; target.scaleY = y / 100;
        }
        return true;
      };
      const event = { pointerType, pointerId: 1, buttons: 1 };
      const transform = { target, action, actionHandler: original };
      // Fabric 7.4 assigns this BEFORE firing before:transform.
      canvas._currentTransform = transform;
      handlers.get('before:transform')({ transform, e: event });
      return { transform, original, move: () => transform.actionHandler(event, transform, 140, 120) };
    },
  };
}

for (const pointerType of ['mouse', 'touch', 'pen']) {
  for (const action of ['drag', 'scale']) {
    test(`${pointerType} ${action}: pending grant resumes the SAME held gesture`, async () => {
      const f = fixture();
      f.api.acquireLocalSelectionLease(f.target); // insertion automatically selects the image
      const gesture = f.gesture(action, pointerType);
      assert.equal(gesture.move(), false);
      assert.equal(f.state.starts, 0);
      assert.equal(f.state.requests, 1, 'selection and pointerdown share one request');
      await f.reply();
      assert.equal(f.api.ownsSelectionLease(f.target), true);
      assert.equal(f.state.calls, 0, 'receiving a reply must not synthesize movement');
      assert.equal(gesture.move(), true, 'held gesture must resume after permission');
      assert.equal(gesture.transform.actionHandler, gesture.original);
      assert.equal(f.state.starts, 1, 'history/live-transform initialized exactly once');
      assert.equal(f.context.modifiedBeforeRecordsRef.current[0].object.left, 100);
      assert.equal(f.context.modifiedBeforeRecordsRef.current[0].object.scaleX, 1);
      assert.equal(f.context.transformGestureRef.current.pointerType, pointerType);
      assert.equal(gesture.move(), true);
      assert.equal(f.state.starts, 1);
    });
  }
}

for (const action of ['drag', 'scale']) {
  test(`${action}: already granted lease retains immediate normal behavior`, async () => {
    const f = fixture();
    f.api.acquireLocalSelectionLease(f.target);
    await f.reply();
    const g = f.gesture(action);
    assert.equal(g.transform.actionHandler, g.original);
    assert.equal(g.move(), true);
    assert.equal(f.state.starts, 1);
  });
}

const invalidations = {
  'pointer released/cancelled': (f) => { f.canvas._currentTransform = null; },
  'different object selected': (f) => { f.state.active = {}; },
  'selection cleared': (f) => { f.state.active = null; },
  'tool changed': (f) => { f.context.activeToolRef.current = 'pencil'; },
  'editing permission removed': (f) => { f.context.canEditRef.current = false; },
  'remote application in progress': (f) => { f.context.applyingRemoteRef.current = true; },
  'history application in progress': (f) => { f.context.applyingHistoryRef.current = true; },
  'canvas replaced': (f) => { f.context.fabricCanvasRef.current = { requestRenderAll: noop, getActiveObject: () => null }; },
  'canvas disposed': (f) => { f.context.disposed = true; },
  'image removed': (f) => { f.target.canvas = null; },
};
for (const [reason, invalidate] of Object.entries(invalidations)) {
  test(`late permission cannot restart gesture after ${reason}`, async () => {
    const f = fixture();
    const g = f.gesture();
    invalidate(f);
    await f.reply();
    assert.equal(g.move(), false);
    assert.equal(f.state.starts, 0);
    assert.equal(f.state.calls, 0);
  });
}

test('two rapid gestures: a shared reply revives only the current transform', async () => {
  const f = fixture();
  const first = f.gesture();
  const second = f.gesture('scale');
  await f.reply();
  assert.equal(first.move(), false);
  assert.equal(second.move(), true);
  assert.equal(f.state.starts, 1);
  assert.equal(f.state.requests, 1);
});

test('genuine teacher lock denies a student transform', async () => {
  const f = fixture();
  f.authority.acquire({ clientId: 'teacher', lockToken: 'teacher-lease', objectIds: [f.target.boardObjectId], ttlMs: 12_000 });
  const g = f.gesture();
  await f.reply();
  assert.equal(g.move(), false);
  assert.equal(f.api.ownsSelectionLease(f.target), false);
  assert.equal(f.state.starts, 0);
  assert.equal(f.state.active, null);
});

test('transport rejection does not restore the action handler', async () => {
  const f = fixture();
  const g = f.gesture();
  await f.reply({ reject: true });
  assert.equal(g.move(), false);
  assert.equal(f.state.starts, 0);
});

test('superseded selection lease cannot restart its old gesture', async () => {
  const f = fixture();
  const g = f.gesture();
  f.api.releaseLocalSelectionLease(f.target);
  await f.reply();
  assert.equal(g.move(), false);
  assert.equal(f.state.starts, 0);
});

test('transient screen sharing keeps its existing lease-free behavior', () => {
  const f = fixture();
  f.target.transientScreenShare = true;
  const g = f.gesture();
  assert.equal(g.transform.actionHandler, g.original);
  assert.equal(g.move(), true);
  assert.equal(f.state.requests, 0);
  assert.equal(f.state.starts, 0);
});

for (const type of ['pointerup', 'pointercancel']) {
  test(`native ${type} fences a pending transform even before Fabric clears it`, async () => {
    const f = fixture(); const g = f.gesture();
    f.endPointer(type);
    await f.reply();
    assert.equal(g.move(), false);
    assert.equal(f.state.starts, 0);
    assert.equal(f.listenerCount(), 0);
  });
}
test('ending a different pointer does not cancel the pending image gesture', async () => {
  const f = fixture(); const g = f.gesture();
  f.endPointer('pointercancel', 2);
  await f.reply();
  assert.equal(g.move(), true);
  assert.equal(f.listenerCount(), 0);
});
