import { Canvas, Path, Line, Rect, Circle, Ellipse, Triangle, Textbox, Group, FabricImage, util } from 'fabric';
import { createBoundedCanvasVerifier } from '../src/lib/boundedCanvasVerifier.js';
import { createVerificationBudget, verificationDigest } from '../src/lib/boundedVerificationDigest.js';

window.runBoundedFabricChecks = async () => {
  const element = document.createElement('canvas'); document.body.append(element);
  const canvas = new Canvas(element, { width: 900, height: 600 });
  const cases = [
    new Path('M 1 2 Q 20 30 40 50', { left: 20, top: 30, stroke: '#123456', fill: null }),
    new Line([80, 30, 110, 90], { stroke: '#111827', strokeWidth: 3 }),
    new Rect({ left: 120, top: 30, width: 30, height: 40, rx: 4, fill: '#111111' }),
    new Circle({ left: 160, top: 30, radius: 15, fill: '#445566' }),
    new Ellipse({ left: 200, top: 30, rx: 10, ry: 20 }),
    new Triangle({ left: 240, top: 30, width: 30, height: 20 }),
    new Textbox('Русский\ntext 😀', { left: 280, top: 30, width: 150, fontSize: 18,
      styles: { 0: { 0: { fill: '#ff0000' }, 1: { fill: '#ff0000' } } } }),
    new Group([new Path('M 0 0 L 20 40', { stroke: '#111111' }), new Rect({ width: 10, height: 10, left: 30 })], { left: 460, top: 40 }),
  ];
  const imageSource = document.createElement('canvas'); imageSource.width = 8; imageSource.height = 8;
  imageSource.getContext('2d').fillRect(0, 0, 8, 8);
  const image = await FabricImage.fromURL(imageSource.toDataURL());
  image.set({ left: 510, top: 30 }); image.storagePath = 'synthetic/image'; cases.push(image);
  const registry = new Map(); const repairs = [];
  cases.forEach((object, i) => { object.boardObjectId = `fixture-${i}`; canvas.add(object); registry.set(object.boardObjectId, new Set([object])); });
  const adapter = createBoundedCanvasVerifier({ getCanvas: () => canvas, getRegistry: () => registry, getRevision: () => 1,
    getBackground: () => 'grid', stylesToArray: util.stylesToArray,
    placementMatches: (actual, expected) => ['left', 'top', 'angle', 'scaleX', 'scaleY', 'skewX', 'skewY']
      .every((key) => expected[key] == null || Math.abs(Number(actual[key]) - expected[key]) <= 0.002),
    apply: async (records) => { repairs.push(...records); return true; },
  });
  const results = [];
  for (const [i, object] of cases.entries()) {
    const expected = object.toObject(['boardObjectId', 'storagePath']);
    const before = repairs.length;
    const result = await adapter.check([{ id: object.boardObjectId, object: expected, zIndex: i }], {
      revision: 1, background: 'grid', isCurrent: () => true, budget: createVerificationBudget(),
    });
    if (!result || repairs.length !== before) {
      throw new Error(`Correct Fabric ${object.type} requested repair/inconclusive: ${JSON.stringify({ expected,
        raw: Object.fromEntries(Object.keys(expected).filter((key) => key !== 'objects').map((key) => [key,
          ['path', 'styles'].includes(key) ? object[key] : (typeof object[key] === 'object' ? String(object[key]) : object[key])])) })}`);
    }
    results.push({ shape: object.type, passed: true });
  }
  const expected = cases[0].toObject(['boardObjectId']);
  cases[0].set({ stroke: '#ff00ff' });
  await adapter.check([{ id: cases[0].boardObjectId, object: expected, zIndex: 0 }], {
    revision: 1, background: 'grid', isCurrent: () => true, budget: createVerificationBudget(),
  });
  if (repairs.length !== 1 || repairs[0].id !== cases[0].boardObjectId) throw new Error('Visible corruption was not detected');
  const timings = [];
  for (const count of [100, 1000, 5000]) {
    const objects = Array.from({ length: count }, (_, i) => ({ id: `bench-${i}`, path: Array.from({ length: 100 }, (_, j) => ['L', j, i + j]) }));
    const selected = objects.slice(-100); let yields = 0; let maximumSlice = 0;
    let began = performance.now(); const start = began;
    const budget = createVerificationBudget({ yieldControl: async () => {
      maximumSlice = Math.max(maximumSlice, performance.now() - began); yields++;
      await new Promise((resolve) => setTimeout(resolve, 0)); began = performance.now();
    } });
    for (const object of selected) await verificationDigest(object, { budget });
    timings.push({ totalBoardObjects: count, checkedObjects: selected.length, elapsedMs: performance.now() - start, yields, maximumSlice });
  }
  canvas.dispose(); element.remove(); return { results, timings, stylesToArray: typeof util.stylesToArray };
};
