import test from 'node:test';
import assert from 'node:assert/strict';
import { installNotebookAuditMetrics } from './notebook-audit-metrics.js';

function emitter(properties = {}) {
  const events = new Map();
  return Object.assign(properties, {
    on(type, fn) { const set = events.get(type) ?? new Set(); set.add(fn); events.set(type, set); },
    off(type, fn) { events.get(type)?.delete(fn); },
    fire(type, data = {}) { for (const fn of events.get(type) ?? []) fn(data); },
  });
}
const child = () => ({ render() {} });
const book = () => emitter({ boardObjectId: 'book', _objects: [child()] });
const fixture = () => {
  const notebook = book();
  const canvas = emitter({ _objects: [notebook], upperCanvasEl: new EventTarget(), getObjects() { return [...this._objects]; } });
  return { canvas, notebook, metrics: installNotebookAuditMetrics(canvas, notebook) };
};

test('audit follows notebook replacement instead of retaining the old initial object', () => {
  const { canvas, notebook, metrics } = fixture();
  const replacement = book(); canvas._objects = [replacement];
  canvas.fire('object:removed', { target: notebook }); canvas.fire('object:added', { target: replacement });
  metrics.begin(2); canvas.upperCanvasEl.dispatchEvent(new Event('mouseup'));
  replacement._objects.push(child()); replacement.fire('object:added', { target: replacement._objects[1] });
  replacement._objects.forEach(o => o.render()); canvas.fire('after:render');
  assert.equal(metrics.painted(), true); assert.equal(metrics.report().childRenders, 2);
  assert.strictEqual(metrics.getNotebook(), replacement); metrics.dispose();
});

test('detached old page cannot satisfy a pending paint measurement', () => {
  const { canvas, notebook, metrics } = fixture();
  metrics.begin(2); canvas.upperCanvasEl.dispatchEvent(new Event('mouseup'));
  canvas._objects = []; canvas.fire('object:removed', { target: notebook });
  notebook._objects.push(child()); canvas.fire('after:render');
  assert.equal(metrics.painted(), false); metrics.dispose();
});

test('diagnostic disposal restores wrapped functions and detaches listeners', () => {
  const { canvas, notebook, metrics } = fixture();
  const original = child().render;
  metrics.dispose();
  const count = metrics.report().childRenders;
  notebook._objects[0].render(); canvas.fire('after:render');
  assert.equal(metrics.report().childRenders, count);
  assert.equal(typeof original, 'function');
});
