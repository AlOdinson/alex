/** Test-only instrumentation. Never imported by the production entry point. */
import { Path } from 'fabric';

export function makeAuditSnapshot({ boardObjects = 0, pages = 1, pageStrokes = 100, points = 40, visible = false } = {}) {
  const stroke = (id, x, y) => new Path(Array.from({ length: points }, (_, i) =>
    [i ? 'L' : 'M', x + i * .9, y + Math.sin(i * .4) * 3]),
  { boardObjectId: id, objectKind: 'path', stroke: '#111827', strokeWidth: 3, fill: null }).toObject(['boardObjectId', 'objectKind']);
  const objects = Array.from({ length: boardObjects }, (_, i) => stroke(`board-${i}`,
    (visible ? 660 : 2000) + (i % 25) * 8, 100 + Math.floor(i / 25) * 3));
  objects.push({ type: 'BoardNotebook', boardObjectId: 'audit-notebook', left: 70, top: 80,
    width: 520, height: 480, originX: 'left', originY: 'top', notebookPageNumber: pages,
    notebookPages: Array.from({ length: pages }, (_, p) => Array.from({ length: pageStrokes }, (_, i) =>
      stroke(`page-${p}-${i}`, -225 + (i % 5) * 70, -190 + Math.floor(i / 5) * 4))) });
  return { version: 2, background: 'blank', canvas: { objects } };
}

export function installNotebookAuditMetrics(canvas, notebook) {
  const samples = [], longTasks = [], renders = [];
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
    if (active && active.releaseAt != null && current && current._objects.length >= active.expectedChildren && active.pagePaintAt == null) {
      active.pagePaintAt = performance.now();
      active.listReads = listReads - active.startListReads;
      active.childRenders = childRenders - active.startChildRenders;
    }
  };
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
      return { samples, longTasks, fullRenders: renders.length, listReads, childRenders, createdPaths, replacements, createdIds,
        timingMeaning: 'Trusted Playwright input -> Fabric after:render with installed child; not a physical pen/display measurement',
        instrumentation: 'Counters on board list reads and page-child renders; timing includes their overhead' };
    },
    dispose() { observer?.disconnect(); restore.reverse().forEach(fn => fn()); },
  };
}
