import assert from 'node:assert/strict';
import test from 'node:test';
import { createVerificationBudget } from '../src/lib/boundedVerificationDigest.js';
const impl = await import('../src/lib/boundedCanvasVerifier.js').catch((e) => { if(e.code === 'ERR_MODULE_NOT_FOUND') return null; throw e; });
test('bounded Canvas verifier exists', () => assert.equal(typeof impl?.createBoundedCanvasVerifier, 'function'));
const feature = (name, fn) => test(name, { skip: !impl }, fn);
const object = (id, extra = {}) => ({ boardObjectId: id, type: 'Path', left: 0, top: 0, stroke: 'black', path: [['M', 0, 0], ['L', 1, 1]], ...extra });
function fixture(objects) {
  const canvas = { _objects: objects }; const registry = new Map();
  for(const o of objects) { if(!registry.has(o.boardObjectId)) registry.set(o.boardObjectId, new Set()); registry.get(o.boardObjectId).add(o); }
  const calls = []; let revision = 3; let background = 'grid'; let busy = false;
  const adapter = impl.createBoundedCanvasVerifier({ getCanvas: () => canvas, getRegistry: () => registry,
    getRevision: () => revision, getBackground: () => background, canCheck: () => !busy,
    placementMatches: (actual, expected) => actual.left === expected.left && actual.top === expected.top,
    apply: async (records, context) => { if (!context.isCurrent()) return false; calls.push(records); background = context.background; return true; },
  });
  return { adapter, calls, registry, canvas, setBusy: (value) => { busy = value; }, setRevision: (value) => { revision = value; },
    getBackground: () => background,
    context: (options = {}) => ({ revision: 3, background: 'grid', isCurrent: () => true, budget: createVerificationBudget(), ...options }) };
}
feature('correct raw path is compared without calling expensive toObject', async () => {
  const raw = object('a'); raw.toObject = () => { throw new Error('Full serialization forbidden'); };
  const h = fixture([raw]);
  assert.equal(await h.adapter.check([{ id: 'a', object: object('a'), zIndex: 0 }], h.context()), true);
  assert.equal(h.calls.length, 0);
});
feature('same-version wrong visible color and position trigger targeted repair', async () => {
  const h = fixture([object('a', { stroke: 'red', left: 99 }), object('keep')]);
  await h.adapter.check([{ id: 'a', object: object('a'), zIndex: 0 }], h.context());
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].length, 1); assert.equal(h.calls[0][0].id, 'a');
});
feature('two durable copies of one id are repaired but transient drawing previews are excluded', async () => {
  const h = fixture([object('a'), object('a')]);
  await h.adapter.check([{ id: 'a', object: object('a'), zIndex: 0 }], h.context());
  assert.equal(h.calls.length, 1);
  const other = fixture([object('a', { transientPreview: true }), object('a')]);
  await other.adapter.check([{ id: 'a', object: object('a'), zIndex: 0 }], other.context());
  assert.equal(other.calls.length, 0);
});
feature('a Canvas-only ghost is removed even when expected model object is absent', async () => {
  const h = fixture([object('ghost')]);
  await h.adapter.check([{ id: 'ghost', object: null, zIndex: -1 }], h.context());
  assert.deepEqual(h.calls[0], [{ id: 'ghost', object: null, zIndex: -1 }]);
});
feature('durable layer position excludes temporary preview and screen-share objects', async () => {
  const h = fixture([object('preview', { transientPreview: true }), object('screen', { transientScreenShare: true }), object('b'), object('a')]);
  await h.adapter.check([{ id: 'a', object: object('a'), zIndex: 0 }], h.context());
  assert.equal(h.calls.length, 1);
});
feature('paused gesture and mismatching Canvas revision are never overwritten', async () => {
  const h = fixture([object('a', { left: 50 })]); h.setBusy(true);
  assert.equal(await h.adapter.check([{ id: 'a', object: object('a'), zIndex: 0 }], h.context()), false);
  h.setBusy(false); h.setRevision(4);
  assert.equal(await h.adapter.check([{ id: 'a', object: object('a'), zIndex: 0 }], h.context()), false);
  assert.equal(h.calls.length, 0);
});
feature('large raw paths yield and cancellation prevents applying a stale repair', async () => {
  const points = Array.from({ length: 5000 }, (_, i) => ['L', i, i]);
  const raw = object('a', { path: points }); const h = fixture([raw]); let ticks = 0; let yielded = 0;
  const expected = object('a', { path: structuredClone(points) });
  const budget = createVerificationBudget({ now: () => ticks++, yieldControl: async () => { yielded++; } });
  assert.equal(await h.adapter.check([{ id: 'a', object: expected, zIndex: 0 }], h.context({ budget })), true);
  assert.ok(yielded > 10); assert.equal(h.calls.length, 0);
});
feature('new edit during comparison makes the final apply guard fail', async () => {
  const h = fixture([object('a')]); let current = true;
  const budget = createVerificationBudget({ now: () => 5, isCurrent: () => current });
  // A simulated side-effect-free placement callback cannot be injected here; use
  // a changing raw field to emulate an event during property comparison.
  Object.defineProperty(h.canvas._objects[0], 'stroke', { get() { current = false; return 'red'; } });
  assert.equal(await h.adapter.check([{ id: 'a', object: object('a'), zIndex: 0 }], h.context({ budget, isCurrent: () => current })), false);
  assert.equal(h.calls.length, 0);
});
feature('images compare stable asset identity instead of device-local blob URL', async () => {
  const expected = { boardObjectId: 'image', type: 'Image', left: 0, top: 0, storagePath: 'asset/1', src: 'blob:teacher', crossOrigin: null };
  const h = fixture([{ ...expected, src: 'blob:student', getSrc: () => 'blob:student' }]);
  await h.adapter.check([{ id: 'image', object: expected, zIndex: 0 }], h.context());
  assert.equal(h.calls.length, 0);
});
feature('pending image placeholder is inconclusive rather than repeatedly reconstructed', async () => {
  const expected = { boardObjectId: 'image', type: 'Image', left: 0, top: 0, storagePath: 'asset/1', src: 'blob:teacher' };
  const h = fixture([{ boardObjectId: 'image', pendingImage: true, pendingImageSerialized: expected }]);
  assert.equal(await h.adapter.check([{ id: 'image', object: expected, zIndex: 0 }], h.context()), false);
  assert.equal(h.calls.length, 0);
});
feature('Canvas registry sweep is bounded and finite even when ids are deleted during iteration', () => {
  const h = fixture(Array.from({ length: 300 }, (_, i) => object(`p${i}`)));
  const first = h.adapter.readIds(100, { fullSweep: true, reset: true });
  assert.equal(first.ids.length, 100); assert.equal(first.done, false);
  for(let i=100;i<200;i++) h.registry.delete(`p${i}`);
  const next = h.adapter.readIds(100, { fullSweep: true });
  assert.equal(next.ids.length, 100);
  const last = h.adapter.readIds(100, { fullSweep: true });
  assert.equal(last.done, true);
});
feature('background repair does not manufacture object operations', async () => {
  const h = fixture([]);
  await h.adapter.check([], h.context({ background: 'blank' }));
  assert.deepEqual(h.calls[0], []); assert.equal(h.getBackground(), 'blank');
});
feature('raw group children are checked without cloning nested path arrays', async () => {
  const expected = { boardObjectId: 'g', type: 'Group', left: 0, top: 0, objects: [object('child')] };
  const raw = { boardObjectId: 'g', type: 'group', left: 0, top: 0, _objects: [object('child')] };
  const h = fixture([raw]);
  await h.adapter.check([{ id: 'g', object: expected, zIndex: 0 }], h.context());
  assert.equal(h.calls.length, 0);
  raw._objects[0].stroke = 'blue';
  await h.adapter.check([{ id: 'g', object: expected, zIndex: 0 }], h.context());
  assert.equal(h.calls.length, 1);
});
