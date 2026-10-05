import { chromium, webkit } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const engineName = process.env.VERIFICATION_BROWSER === 'webkit' ? 'webkit' : 'chromium';
const engine = engineName === 'webkit' ? webkit : chromium;
const port = 5211, base = `http://127.0.0.1:${port}/alex/`, output = 'notebook-append-results';
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { stdio: 'ignore' });
let browser;
try {
  await mkdir(output, { recursive: true });
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base)).ok) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready, 'Vite did not start');
  browser = await engine.launch({ headless: true, ...(engineName === 'chromium' ? { args: ['--no-sandbox'],
    ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}) } : {}) });
  const page = await browser.newPage({ viewport: { width: 900, height: 750 }, deviceScaleFactor: 2 });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(base + 'scripts/board-media-fixture.html');
  const results = await page.evaluate(async () => {
    const { StaticCanvas, Path, Rect, util, Point } = await import('/alex/node_modules/.vite/deps/fabric.js');
    const { BoardNotebook } = await import('/alex/src/lib/boardNotebook.js');
    const { createNotebookBoardActions } = await import('/alex/src/lib/notebookBoardActions.js');
    const { applyAuthorityOpsInPlace } = await import('/alex/src/lib/authoritySnapshot.js');
    const results = [];
    for (const addressed of [false, true]) for (const options of [{}, { erased: true }, { scale: .65, zoom: 1.3, opacity: .45 }, { scale: 1.4, zoom: .8, masked: true }]) {
      const canvas = new StaticCanvas(document.createElement('canvas'), { width: 800, height: 700, renderOnAddRemove: false });
      document.body.appendChild(canvas.lowerCanvasEl); canvas.setZoom(options.zoom ?? 1);
      const book = new BoardNotebook({ boardObjectId: 'book', left: 20, top: 20,
        scaleX: options.scale ?? 1, scaleY: options.scale ?? 1, opacity: options.opacity ?? 1 });
      for (let i = 0; i < 100; i++) book.addPageObject(new Path(`M -170 ${-100+i*2} L 130 ${-95+i*2}`, {
        boardObjectId: `old-${i}`, stroke: 'rgba(25,35,45,.6)', strokeWidth: 2, fill: null }));
      if (options.erased) book.addPageObject(new Path('M -120 28 L 150 28', { stroke: 'black', strokeWidth: 32,
        globalCompositeOperation: 'destination-out', isEraserPath: true, fill: null }));
      if (options.masked) book.getPageObjects()[0].clipPath = new Rect({ width: 30, height: 30, originX: 'center', originY: 'center' });
      canvas.add(book); canvas.renderAll();
      let oldRenders = 0;
      for (const child of book.getPageObjects()) { const render = child.render; child.render = function (...args) { oldRenders++; return render.apply(this, args); }; }
      // Exercise both the compatibility path and the canonical append proof. The
      // latter must install through the new address-only method, not silently
      // fall back to the previously tested full-page synchronization.
      const snapshot = { version: 2, canvas: { objects: [book.toObject(['boardObjectId'])] } };
      let addressedInstalls = 0;
      const append = book.appendPreparedPageObject;
      book.appendPreparedPageObject = function (...args) {
        const result = append.apply(this, args); if (result) addressedInstalls++; return result;
      };
      const controller = {
        enqueue: input => {
          if (addressed) applyAuthorityOpsInPlace(snapshot, input.ops);
          return { actionId: input.actionId, inverseOps: [], settled: new Promise(() => {}) };
        },
        ...(addressed ? { getState: () => ({ snapshot, revision: 0 }) } : {}),
        pendingObjectIds: () => new Set(['book'])
      };
      const actions = createNotebookBoardActions({ getCanvas: () => canvas, getController: async () => controller,
        clientId: 'test', acquireLease: async () => true, ownsLease: () => true, releaseLease() {}, recordAction() {},
        getRecords: objects => objects.map(object => ({ object: object.toObject(['boardObjectId']), zIndex: 1 })) });
      try {
        const matrix = book.calcTransformMatrix();
        const points = [[-40,22],[0,55],[45,32]].map(([x,y]) => util.transformPoint(new Point(x,y), matrix));
        const stroke = new Path([['M',points[0].x,points[0].y],['Q',points[1].x,points[1].y,points[2].x,points[2].y]], {
          boardObjectId: 'source', stroke: 'rgba(70,30,20,.6)', opacity: .7, strokeWidth: 4, fill: null,
          strokeUniform: true, strokeLineCap: 'round', strokeLineJoin: 'round', strokeDashArray: [7,3] });
        canvas.add(stroke);
        const captured = await actions.capture(book, stroke); canvas.renderAll();
        const appendRenders = oldRenders;
        const width = canvas.lowerCanvasEl.width, height = canvas.lowerCanvasEl.height;
        const actual = canvas.getContext().getImageData(0,0,width,height).data;
        book.dirty = true; canvas.renderAll();
        const expected = canvas.getContext().getImageData(0,0,width,height).data;
        const fullRenders = oldRenders - appendRenders;
        book.dirty = true; canvas.renderAll();
        const repeated = canvas.getContext().getImageData(0,0,width,height).data;
        let fullRepeatDifferences = 0;
        for (let i = 0; i < expected.length; i++) if (expected[i] !== repeated[i]) fullRepeatDifferences++;
        let differingChannels = 0, maxDifference = 0;
        for (let i = 0; i < actual.length; i++) if (actual[i] !== expected[i]) {
          differingChannels++; maxDifference = Math.max(maxDifference, Math.abs(actual[i]-expected[i]));
        }
        results.push({ options, addressed, addressedInstalls, captured, appendRenders, fullRenders,
          differingChannels, maxDifference, fullRepeatDifferences, width, height });
      } finally { await canvas.dispose(); }
    }
    return results;
  });
  const report = { engine: engineName, results, errors, commit: process.env.GITHUB_SHA || null,
    limitation: 'Direct production drawing functions and browser pixels; not physical pen latency or network transport' };
  await writeFile(`${output}/${engineName}.json`, JSON.stringify(report,null,2));
  for (const result of results) {
    assert.equal(result.captured, true); assert.equal(result.appendRenders, 0, JSON.stringify(result));
    assert.equal(result.addressedInstalls, result.addressed ? 1 : 0, JSON.stringify(result));
    assert.ok(result.fullRenders >= 100); assert.equal(result.differingChannels, 0, JSON.stringify(result));
  }
  assert.deepEqual(errors, []); console.log(JSON.stringify(report));
} finally { await browser?.close(); server.kill(); }
