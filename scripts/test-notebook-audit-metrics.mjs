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

test('overlapping native strokes all get a paint sample rather than losing earlier releases',()=>{
 const {canvas,notebook,metrics}=fixture();
 metrics.begin(2);canvas.upperCanvasEl.dispatchEvent(new Event('mouseup'));
 metrics.begin(3);canvas.upperCanvasEl.dispatchEvent(new Event('mouseup'));
 notebook._objects.push(child(),child());canvas.fire('after:render');
 assert.equal(metrics.report().samples.filter(s=>s.pagePaintAt!=null).length,2);metrics.dispose();
});

test('controller CPU instrumentation preserves values, thrown errors and disposal',()=>{
 const notebook=book(),canvas=emitter({_objects:[notebook],upperCanvasEl:new EventTarget(),getObjects(){return [...this._objects];}});
 const problem=new Error('original');
 const controller={enqueue(value){return value;},ack(){throw problem;}};
 const enqueue=controller.enqueue,ack=controller.ack;
 const metrics=installNotebookAuditMetrics(canvas,notebook,{controller});
 const input={ops:[]};assert.strictEqual(controller.enqueue(input),input);
 assert.throws(()=>controller.ack(),error=>error===problem);
 assert.deepEqual(metrics.report().controllerStages.map(s=>s.stage),['enqueue','ack']);
 assert.ok(metrics.report().controllerStages.every(s=>s.durationMs>=0));metrics.dispose();
 assert.strictEqual(controller.enqueue,enqueue);assert.strictEqual(controller.ack,ack);
});

test('CPU instrumentation follows a replaced controller reference and restores its latest value', () => {
 const notebook=book(),canvas=emitter({_objects:[notebook],upperCanvasEl:new EventTarget(),getObjects(){return [...this._objects];}});
 const first={enqueue(x){return x;},ack(){return true;}}, second={enqueue(x){return x;},ack(){return false;}};
 const ref={current:first},descriptor=Object.getOwnPropertyDescriptor(ref,'current'),enqueue=second.enqueue;
 const metrics=installNotebookAuditMetrics(canvas,notebook,{controllerRef:ref});
 first.enqueue('one'); ref.current=second; second.enqueue('two'); second.ack();
 assert.deepEqual(metrics.report().controllerStages.map(s=>s.stage),['enqueue','enqueue','ack']);
 metrics.dispose(); assert.strictEqual(ref.current,second); assert.strictEqual(second.enqueue,enqueue);
 assert.deepEqual(Object.getOwnPropertyDescriptor(ref,'current'),{...descriptor,value:second});
});

test('CPU instrumentation can attach after a controller is created lazily', () => {
 const notebook=book(),canvas=emitter({_objects:[notebook],upperCanvasEl:new EventTarget(),getObjects(){return [...this._objects];}});
 const ref={current:null},metrics=installNotebookAuditMetrics(canvas,notebook,{controllerRef:ref});
 ref.current={enqueue(){return 3;},ack(){return true;}};
 assert.equal(ref.current.enqueue(),3);assert.equal(metrics.report().controllerStages.length,1);metrics.dispose();
});

test('audit resolves the exact controller ref through current or alternate owner fibers', async () => {
 const { findNotebookAuditControllerRef } = await import('./notebook-audit-metrics.js');
 const controller={enqueue(){},ack(){}},ref={current:controller},other={current:{enqueue(){},ack(){}}};
 const owner={type:{name:'MemoizedOwner'},memoizedState:{memoizedState:other,next:null},return:null};
 owner.alternate={memoizedState:{memoizedState:ref,next:null},return:null};
 const element={__reactFiberFixture:{memoizedState:null,return:owner}};
 assert.strictEqual(findNotebookAuditControllerRef(element,controller),ref);
 assert.equal(findNotebookAuditControllerRef(element,other.current),other);
 assert.equal(findNotebookAuditControllerRef(element,{enqueue(){},ack(){}}),null);
 assert.equal(findNotebookAuditControllerRef(element,null),null);
});
