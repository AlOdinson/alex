import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../src/components/Board.jsx', import.meta.url), 'utf8');
function section(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `Missing production section: ${start}`);
  return source.slice(from, to);
}

// Execute the production finish handler, identity helpers, event dispatch, claim,
// and reset. Only the browser PointerEvent/target boundary is replaced.
const production = [
  section('function isStylusTouch', 'function isStylusFallbackPointerEvent'),
  section('function findChangedStylusTouch', 'function stylusTouchMatchesNativePointer'),
  section('function touchId', 'function suppressTouchContacts'),
  section('function finishStylusTouchFallback', 'function shouldRejectNativePenAfterTouchFallback'),
].join('\n');

function harness(mode, { nativeClosed = false } = {}) {
  const initial = {
    active: true, mode, touchId: 42, pointerId: 7, contactSerial: 1,
    lastClientX: 100, lastClientY: 110,
  };
  const dispatched = [];
  const claims = [];
  const context = vm.createContext({
    stylusTouchFallbackRef: { current: initial },
    penInputRef: { current: { active: !nativeClosed, contactSerial: 1, pointerId: 7 } },
    pencilDiagnosticsRef: { current: null },
    rejectedPointerIdsRef: { current: new Set() },
    PointerEvent: class {
      constructor(type, init) { this.type = type; Object.assign(this, init); }
    },
    touchTarget: { dispatchEvent(event) { dispatched.push(event); return true; } },
  });
  vm.runInContext(production, context);
  return {
    initial, context, dispatched, claims,
    finish(changedTouches, touches, cancelled = false) {
      return context.finishStylusTouchFallback({
        type: cancelled ? 'touchcancel' : 'touchend',
        changedTouches, touches, cancelable: true,
        preventDefault() { claims.push('preventDefault'); },
        stopPropagation() { claims.push('stopPropagation'); },
        stopImmediatePropagation() { claims.push('stopImmediatePropagation'); },
      }, cancelled);
    },
  };
}

const stylus = (identifier = 42) => ({
  identifier, touchType: 'stylus', clientX: 120, clientY: 130, force: 0,
});
const finger = { identifier: 99, touchType: 'direct', clientX: 80, clientY: 90 };

function assertFinished(h, type, { recovered = false, dispatched = true } = {}) {
  assert.equal(h.context.stylusTouchFallbackRef.current.active, false);
  assert.equal(h.context.stylusTouchFallbackRef.current.touchId, null);
  assert.equal(h.dispatched.length, dispatched ? 1 : 0);
  assert.deepEqual(h.claims, h.initial.mode === 'synthetic'
    ? ['preventDefault', 'stopPropagation', 'stopImmediatePropagation'] : []);
  assert.deepEqual([...h.context.rejectedPointerIdsRef.current],
    h.initial.mode === 'native' && dispatched ? [7] : []);
  if (!dispatched) return;
  const event = h.dispatched[0];
  assert.equal(event.type, type);
  assert.equal(event.pointerId, 7);
  assert.equal(event.pointerType, 'pen');
  assert.equal(event.pressure, 0);
  assert.equal(event.buttons, 0);
  assert.equal(event.clientX, recovered ? 100 : 120);
  assert.equal(event.clientY, recovered ? 110 : 130);
  assert.equal(event.alexStylusNativeBridge, h.initial.mode === 'native' ? true : undefined);
  assert.equal(event.alexStylusTouchFallback, h.initial.mode === 'synthetic' ? true : undefined);
}

for (const mode of ['native', 'synthetic']) {
  for (const cancelled of [false, true]) {
    // Removing the ownership guard must fail: finger 99 cannot finish stylus 42.
    test(`${mode}: unrelated finger ${cancelled ? 'cancel' : 'end'} preserves the active Pencil`, () => {
      const h = harness(mode);
      assert.equal(h.finish([finger], [stylus('42')], cancelled), false);
      assert.equal(h.context.stylusTouchFallbackRef.current, h.initial);
      assert.equal(h.initial.active, true);
      assert.equal(h.context.penInputRef.current.active, true);
      assert.deepEqual(h.claims, []);
      assert.deepEqual(h.dispatched, []);
      assert.equal(h.context.rejectedPointerIdsRef.current.size, 0);
    });

    // An overbroad guard would lose matching endings, including cancellation.
    test(`${mode}: matching stylus ${cancelled ? 'cancel' : 'end'} finishes exactly once`, () => {
      const h = harness(mode);
      assert.equal(h.finish([stylus('42')], [finger], cancelled), true);
      assertFinished(h, cancelled ? 'pointercancel' : 'pointerup');
      assert.equal(h.finish([stylus(42)], [], cancelled), false);
      assert.equal(h.dispatched.length, 1);
    });
  }

  for (const changedTouches of [[], [finger]]) {
    // Requiring a changed stylus unconditionally would break omitted-contact recovery.
    test(`${mode}: missing changed stylus recovers when tracked contact is absent (${changedTouches.length} changed)`, () => {
      const h = harness(mode);
      assert.equal(h.finish(changedTouches, []), true);
      assertFinished(h, 'pointerup', { recovered: true });
    });
  }
}

test('native: native pointerup already closed produces no duplicate bridge or rejection', () => {
  const h = harness('native', { nativeClosed: true });
  assert.equal(h.finish([stylus(42)], []), true);
  assertFinished(h, 'pointerup', { dispatched: false });
});
