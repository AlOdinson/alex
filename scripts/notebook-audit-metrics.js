/** Test-only instrumentation. Never imported by the production entry point. */
import { Path } from 'fabric';
import { createBoardNotebook } from '../src/lib/boardNotebook.js';

export function makeAuditSnapshot({ boardObjects = 0, pages = 1, pageStrokes = 100, points = 40, visible = false } = {}) {
  const stroke = (id, x, y) => new Path(Array.from({ length: points }, (_, i) =>
    [i ? 'L' : 'M', x + i * .9, y + Math.sin(i * .4) * 3]),
  { boardObjectId: id, objectKind: 'path', stroke: '#111827', strokeWidth: 3, fill: null }).toObject(['boardObjectId', 'objectKind']);
  const objects = Array.from({ length: boardObjects }, (_, i) => stroke(`board-${i}`,
    (visible ? 660 : 2000) + (i % 25) * 8, 100 + Math.floor(i / 25) * 3));
  const notebook = createBoardNotebook({ boardObjectId: 'audit-notebook', left: 70, top: 80,
    width: 520, height: 480, originX: 'left', originY: 'top', notebookPageNumber: pages,
    notebookPages: Array.from({ length: pages }, (_, p) => Array.from({ length: pageStrokes }, (_, i) =>
      stroke(`page-${p}-${i}`, -225 + (i % 5) * 70, -190 + Math.floor(i / 5) * 4))) });
  // A saved lesson contains the production serializer's defaults too. A sparse
  // test-only frame made confirmation unset scale/opacity and poisoned input.
  objects.push(notebook.toObject(['boardObjectId']));
  notebook.dispose();
  return { version: 2, background: 'blank', canvas: { objects } };
}

// Test-only owner lookup: the host node may retain an alternate fiber and a
// component function name is not a stable identity. Match the ensured instance
// synchronously, before a later readiness task can retire it.
export function findNotebookAuditControllerRef(element, controller) {
  if (!element || !controller) return null;
  const root = element[Object.keys(element).find(key => key.startsWith('__reactFiber'))];
  const visited = new Set(), pending = root ? [root] : [];
  while (pending.length) {
    const fiber = pending.pop();
    if (!fiber || visited.has(fiber)) continue;
    visited.add(fiber);
    for (let hook = fiber.memoizedState; hook; hook = hook.next) {
      const ref = hook.memoizedState;
      if (ref && Object.hasOwn(ref, 'current') && ref.current === controller) return ref;
    }
    pending.push(fiber.return, fiber.alternate);
  }
  return null;
}

export function installNotebookAuditMetrics(canvas, notebook, { controller = null, controllerRef = null } = {}) {
  const samples = [], longTasks = [], renders = [], controllerStages = [];
  let active = null, listReads = 0, childRenders = 0, createdPaths = 0, current = notebook;
  const notebookId = String(notebook.boardObjectId), replacements = [], createdIds = [];
  const restore = [], instrumented = new WeakSet();
  const originalGetObjects = canvas.getObjects;
  canvas.getObjects = function (...args) { listReads++; return originalGetObjects.apply(this, args); };
  restore.push(() => { canvas.getObjects = originalGetObjects; });
  function instrument(child) {
    if (!child || instrumented.has(child)) return;
    instrumented.add(child);
    const original = child.render;
    child.render = function (...args) { childRenders++; return original.apply(this, args); };
    restore.push(() => { child.render = original; });
  }
  const watched = new WeakSet();
  function watch(root) {
    current = root;
    if (watched.has(root)) return;
    watched.add(root);
    for (const child of root._objects) instrument(child);
    const onAdded = ({ target }) => instrument(target);
    root.on('object:added', onAdded);
    restore.push(() => root.off('object:added', onAdded));
  }
  watch(notebook);
  const added = ({ target }) => {
    if (String(target?.boardObjectId) !== notebookId) return;
    replacements.push({ at: performance.now(), children: target._objects?.length }); watch(target);
  };
  const removed = ({ target }) => { if (target === current) current = null; };
  canvas.on('object:added', added); canvas.on('object:removed', removed);
  restore.push(() => { canvas.off('object:added', added); canvas.off('object:removed', removed); });
  const created = ({ path } = {}) => {
    createdPaths++; createdIds.push(path?.boardObjectId ?? null);
    if (active) active.pathCreatedAt = performance.now();
  };
  const before = () => { renders.push(performance.now()); };
  const after = () => {
    for (const sample of samples) if (sample.releaseAt != null && current
      && current._objects.length >= sample.expectedChildren && sample.pagePaintAt == null) {
      sample.pagePaintAt = performance.now();
      sample.listReads = listReads - sample.startListReads;
      sample.childRenders = childRenders - sample.startChildRenders;
    }
  };
  const seenControllers = new WeakSet();
  function watchController(value) {
    if (!value || seenControllers.has(value)) return;
    seenControllers.add(value);
    for (const stage of ['enqueue', 'ack']) {
      const original = value[stage];
      if (typeof original !== 'function') continue;
      const wrapped = function(...args) {
        const start = performance.now();
        try { return original.apply(this, args); }
        finally { controllerStages.push({ stage, start, durationMs: performance.now() - start }); }
      };
      value[stage] = wrapped;
      restore.push(() => { if (value[stage] === wrapped) value[stage] = original; });
    }
  }
  watchController(controller);
  if (controllerRef) {
    const descriptor = Object.getOwnPropertyDescriptor(controllerRef, 'current');
    if (!descriptor?.configurable || !descriptor.writable || !Object.hasOwn(descriptor, 'value')) {
      throw new TypeError('CPU instrumentation requires a writable controller ref');
    }
    let value = controllerRef.current;
    watchController(value);
    const set = next => { value = next; watchController(next); };
    Object.defineProperty(controllerRef, 'current', { configurable:true, enumerable:descriptor.enumerable, get:()=>value, set });
    restore.push(() => {
      if (Object.getOwnPropertyDescriptor(controllerRef, 'current')?.set === set) {
        Object.defineProperty(controllerRef, 'current', { ...descriptor, value });
      }
    });
  }
  canvas.on('path:created', created); canvas.on('before:render', before); canvas.on('after:render', after);
  restore.push(() => { canvas.off('path:created', created); canvas.off('before:render', before); canvas.off('after:render', after); });
  const pointer = event => {
    if (!active) return;
    if (/down$/.test(event.type) && active.downAt == null) active.downAt = performance.now();
    if (/up$/.test(event.type)) active.releaseAt = performance.now();
  };
  for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup']) {
    canvas.upperCanvasEl.addEventListener(type, pointer, true);
    restore.push(() => canvas.upperCanvasEl.removeEventListener(type, pointer, true));
  }
  let observer;
  if (globalThis.PerformanceObserver?.supportedEntryTypes?.includes('longtask')) {
    observer = new PerformanceObserver(list => longTasks.push(...list.getEntries().map(e => ({ start: e.startTime, duration: e.duration }))));
    observer.observe({ type: 'longtask' });
  }
  return {
    begin(expectedChildren) {
      active = { expectedChildren, started: performance.now(), downAt: null, releaseAt: null, pagePaintAt: null,
        startListReads: listReads, startChildRenders: childRenders };
      samples.push(active);
    },
    painted: () => active?.pagePaintAt != null,
    getNotebook: () => current,
    report() {
      return { samples, longTasks, fullRenders: renders.length, listReads, childRenders, createdPaths, replacements, createdIds, controllerStages,
        timingMeaning: 'Trusted Playwright input -> Fabric after:render with installed child; not a physical pen/display measurement',
        instrumentation: 'Counters on board list reads and page-child renders; timing includes their overhead' };
    },
    dispose() { observer?.disconnect(); restore.reverse().forEach(fn => fn()); },
  };
}

// Applied only by the Playwright response interceptor, never by production Vite.
// Observe factory results instead of guessing which React ref owns live input.
export function instrumentNotebookControllerSource(source) {
  const declaration = 'export function createNotebookBoardController(';
  if (source.split(declaration).length !== 2) throw new Error('Notebook controller factory not found uniquely');
  return source.replace(declaration, 'function createNotebookBoardControllerForAudit(') + `
export function createNotebookBoardController(...args) {
  const result = Reflect.apply(createNotebookBoardControllerForAudit, this, args);
  (globalThis.__notebookAuditControllerRef ??= { current: null }).current = result;
  return result;
}
`;
}
