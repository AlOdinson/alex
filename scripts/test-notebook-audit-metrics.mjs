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

test('served-module probe observes the actual controller factory without changing results or calls', async () => {
 const { instrumentNotebookControllerSource } = await import('./notebook-audit-metrics.js');
 const source = 'let calls=0; export function createNotebookBoardController(value) { calls++; return { value, calls, enqueue(x){return x;} }; } export const unaffected=7;';
 assert.equal(typeof instrumentNotebookControllerSource, 'function', 'factory probe is missing');
 const patched = instrumentNotebookControllerSource(source);
 const module = await import('data:text/javascript;base64,' + Buffer.from(patched).toString('base64'));
 try {
  const first = module.createNotebookBoardController('first'); assert.equal(first.calls,1);
  assert.strictEqual(globalThis.__notebookAuditControllerRef.current, first);
  const next = module.createNotebookBoardController('next'); assert.equal(next.calls,2); assert.equal(next.value,'next');
  assert.strictEqual(globalThis.__notebookAuditControllerRef.current,next);
  assert.equal(module.unaffected,7); assert.equal(next.enqueue(5),5);
 } finally { delete globalThis.__notebookAuditControllerRef; }
});

test('served-module probe fails closed when the expected factory is absent', async () => {
 const { instrumentNotebookControllerSource } = await import('./notebook-audit-metrics.js');
 assert.equal(typeof instrumentNotebookControllerSource, 'function', 'factory probe is missing');
 assert.throws(()=>instrumentNotebookControllerSource('export const wrong=1;'),/factory/);
});

test('factory probe attaches CPU metrics to the real controller used for notebook enqueue', async () => {
 const { instrumentNotebookControllerSource } = await import('./notebook-audit-metrics.js');
 const { readFile } = await import('node:fs/promises');
 const url = new URL('../src/lib/notebookBoardController.js', import.meta.url);
 const source = (await readFile(url, 'utf8')).replace(/from (['"])(\.\/[^'"]+)\1/g,
  (_match, _quote, path) => `from '${new URL(path, url).href}'`);
 const module = await import('data:text/javascript;base64,' + Buffer.from(instrumentNotebookControllerSource(source)).toString('base64'));
 const controller = module.createNotebookBoardController({ confirmedState: { revision: 0, snapshot: { canvas: { objects: [
  {type:'BoardNotebook',boardObjectId:'book',notebookPages:[[]],notebookPageNumber:1}
 ] } } }, publish: () => new Promise(() => {}), paint: async () => true });
 controller.pause('test'); const notebook=book(),canvas=emitter({_objects:[notebook],upperCanvasEl:new EventTarget(),getObjects(){return [...this._objects];}});
 const metrics=installNotebookAuditMetrics(canvas,notebook,{controllerRef:globalThis.__notebookAuditControllerRef});
 try {
  controller.enqueue({type:'notebook',version:1,id:'book',pageNumber:1,changes:[{type:'insert',object:{type:'Path',boardObjectId:'actual-ink',path:[['M',0,0],['L',1,2]]}}]});
  await controller.whenPainted();
  assert.equal(metrics.report().controllerStages.filter(x=>x.stage==='enqueue').length,1);
  assert.equal(controller.getState().snapshot.canvas.objects[0].notebookPages[0].length,1);
 } finally { metrics.dispose(); controller.dispose(); delete globalThis.__notebookAuditControllerRef; }
});

test('browser readiness and revision waits use synchronous predicates that really poll', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('./benchmark-notebook-real-input.mjs', import.meta.url), 'utf8');
  // Playwright's poller treats a returned Promise as truthy before it resolves.
  // Async setup belongs in page.evaluate; waitForFunction must check ready state.
  assert.equal(/\.waitForFunction\(\s*async\b/.test(source), false,
    'Async wait predicate may resolve false once without polling the readiness boundary');
});

test('entry readiness observes a late name form or actual edit readiness instead of elapsed time', async () => {
  const { notebookAuditEntryState } = await import('./notebook-audit-metrics.js');
  assert.equal(typeof notebookAuditEntryState, 'function', 'missing state-based entry predicate');
  const { getEnv } = await import('fabric/node');
  const doc = getEnv().document.implementation.createHTMLDocument('late board entry');
  assert.equal(notebookAuditEntryState(doc), null);
  await new Promise(resolve => setTimeout(resolve, 0));
  doc.body.innerHTML = '<main class="gate-page"><section class="gate-card"><label>Ваше имя<input></label></section></main>';
  assert.equal(notebookAuditEntryState(doc), 'name');
  doc.body.innerHTML = ''; doc.documentElement.dataset.alexDurableEditState = 'loading';
  assert.equal(notebookAuditEntryState(doc), null);
  doc.documentElement.dataset.alexDurableEditState = 'ready'; doc.documentElement.dataset.alexDurableEditBlocked = 'true';
  assert.equal(notebookAuditEntryState(doc), null);
  doc.documentElement.dataset.alexDurableEditBlocked = 'false';
  assert.equal(notebookAuditEntryState(doc), 'ready');
});

test('real input runner waits for the tested entry state rather than a one-shot 700ms form check', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('./benchmark-notebook-real-input.mjs', import.meta.url), 'utf8');
  assert.ok(source.includes('page.waitForFunction(notebookAuditEntryState'), 'state predicate is not wired into browser entry');
  assert.equal(source.includes('waitForTimeout(700)'), false);
});
