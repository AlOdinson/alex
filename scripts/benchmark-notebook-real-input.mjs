import { instrumentNotebookControllerSource, notebookAuditEntryState } from './notebook-audit-metrics.js';
import { chromium, webkit } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const port = 5193, base = `http://127.0.0.1:${port}/alex/`;
const engineName = process.env.VERIFICATION_BROWSER === 'webkit' ? 'webkit' : 'chromium';
const engine = engineName === 'webkit' ? webkit : chromium;
const output = process.env.NOTEBOOK_AUDIT_OUTPUT || 'notebook-audit-results';
const source = JSON.parse(await readFile('package.json', 'utf8')).version;
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
  { stdio: 'ignore', env: { ...process.env, VITE_NOTEBOOK_OPERATIONS_V1: 'true' } });
let browser;
const results = [], errors = [], consoleMessages = [];
const burst = process.argv.includes('--burst');
const cases = process.argv.includes('--focused') ? [
  { boardObjects: 0, pages: 1, pageStrokes: 100 },
  { boardObjects: 5000, pages: 1, pageStrokes: 100 },
  { boardObjects: 0, pages: 6, pageStrokes: 300 },
  { boardObjects: 1000, pages: 6, pageStrokes: 300, visible: true, points: 200 },
] : process.argv.includes('--smoke') ? [
  { boardObjects: 0, pages: 1, pageStrokes: 100 },
  { boardObjects: 1000, pages: 6, pageStrokes: 300 },
] : [
  { boardObjects: 0, pages: 1, pageStrokes: 100 },
  { boardObjects: 1000, pages: 1, pageStrokes: 100 },
  { boardObjects: 5000, pages: 1, pageStrokes: 100 },
  { boardObjects: 0, pages: 6, pageStrokes: 300 },
  { boardObjects: 0, pages: 12, pageStrokes: 300 },
  { boardObjects: 0, pages: 20, pageStrokes: 300 },
  { boardObjects: 0, pages: 1, pageStrokes: 1000 },
  { boardObjects: 1000, pages: 6, pageStrokes: 300, visible: true, points: 200 },
  { boardObjects: 0, pages: 1, pageStrokes: 100, points: 1000 },
];
try {
  await mkdir(output, { recursive: true });
  let ready = false;
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(base)).ok) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready, 'Vite did not start');
  browser = await engine.launch({ headless: true, ...(engineName === 'chromium' ? { args: ['--no-sandbox'],
    ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}) } : {}) });
  for (const [index, scenario] of cases.entries()) {
    const context = await browser.newContext({ viewport: { width: 1100, height: 850 }, deviceScaleFactor: 2 });
    const page = await context.newPage();
    // Same diagnostic wrapper on both revisions. The unmodified factory and its
    // returned methods run exactly once; no editor behavior or persistence bypass.
    const controllerSource = instrumentNotebookControllerSource(await readFile('src/lib/notebookBoardController.js', 'utf8'));
    await page.route(/\/src\/lib\/notebookBoardController\.js(?:\?.*)?$/, route =>
      route.fulfill({ status: 200, contentType: 'text/javascript', body: controllerSource }));
    page.on('pageerror', error => errors.push({ scenario, error: error.message }));
    page.on('console', message => { if (['error', 'warning'].includes(message.type())) consoleMessages.push({ type: message.type(), text: message.text() }); });
    let stage = 'fixture';
    try {
      await page.goto(base + 'scripts/board-media-fixture.html');
      const board = await page.evaluate(async scenario => {
        const { createBoard } = await import('/alex/src/lib/boardRepository.js');
        const { saveAuthoritySnapshot } = await import('/alex/src/lib/browserAuthorityStore.js');
        const { makeAuditSnapshot } = await import('/alex/scripts/notebook-audit-metrics.js');
        const board = await createBoard('Ink performance fixture');
        await saveAuthoritySnapshot(board.boardId, makeAuditSnapshot(scenario), 0);
        return board;
      }, scenario);
      await page.goto(`${base}board/${board.boardId}?key=${board.ownerKey}`);
      stage = 'entry';
      const gate = page.getByRole('textbox', { name: 'Ваше имя' });
      await page.waitForFunction(notebookAuditEntryState, undefined, { timeout: 90000 });
      if (await gate.count()) { await gate.fill('Performance tester'); await page.getByRole('button', { name: 'Войти на доску', exact: true }).click(); }
      await page.waitForFunction(() => document.documentElement.dataset.alexDurableEditState === 'ready'
        && document.documentElement.dataset.alexDurableEditBlocked !== 'true', undefined, { timeout: 90000 });
      stage = 'controller';
      await page.evaluate(async () => {
        let fiber = document.querySelector('.toolbar-shell');
        fiber = fiber?.[Object.keys(fiber).find(key => key.startsWith('__reactFiber'))];
        while (fiber && fiber.type?.name !== 'BoardWorkspace') fiber = fiber.return;
        for (let hook = fiber?.memoizedState; hook; hook = hook.next) {
          const value = hook.memoizedState?.current;
          if (value?.getObjects && value?.getZoom) window.auditCanvas = value;
          if (value?.capture && value?.ensure) window.auditHandlers = value;
        }
        if (!window.auditCanvas) throw new Error('Production canvas not found');
      });
      // This fixture measures a loaded lesson, not cold startup. Use the real
      // notebook readiness boundary before the first timed native contact.
      await page.evaluate(async () => { await window.auditHandlers?.ensure(); });
      await page.waitForFunction(() => Boolean(window.__notebookAuditControllerRef?.current), undefined, { timeout: 90000 });
      await page.evaluate(() => { window.auditControllerRef = window.__notebookAuditControllerRef; });
      // Runtime edit permission can arrive before Fabric finishes page hydration.
      await page.waitForFunction(() => {
        window.auditBook = window.auditCanvas?._objects.find(o => o.boardObjectId === 'audit-notebook');
        return Boolean(window.auditBook);
      }, undefined, { timeout: 90000 });
      await page.evaluate(async () => {
        const { installNotebookAuditMetrics } = await import('/alex/scripts/notebook-audit-metrics.js');
        window.auditMetrics = installNotebookAuditMetrics(window.auditCanvas, window.auditBook, { controllerRef: window.auditControllerRef });
        window.auditBookNow = () => window.auditMetrics.getNotebook();
      });
      await page.getByRole('button', { name: 'Карандаш', exact: true }).click();
      const startRevision = await page.evaluate(async id => {
        window.auditRuntime = (await import('/alex/src/lib/browserBoardRuntimeRegistry.js')).getBoardRuntime(id);
        return window.auditRuntime.getRevision();
      }, board.boardId);
      const points = await page.evaluate(() => {
        const c = window.auditCanvas, b = window.auditBookNow().getBoundingRect(), r = c.upperCanvasEl.getBoundingClientRect(), v = c.viewportTransform;
        return { x: r.left + (b.left + 35) * v[0] + v[4], y: r.top + (b.top + b.height * .55) * v[3] + v[5], zoom: c.getZoom(), initial: window.auditBookNow()._objects.length };
      });
      stage = 'input';
      for (let stroke = 0; stroke < 16; stroke++) {
        await page.evaluate(expected => window.auditMetrics.begin(expected), points.initial + stroke + 1);
        const x = points.x + (stroke % 4) * 100 * points.zoom, y = points.y + Math.floor(stroke / 4) * 12 * points.zoom;
        assert.ok(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y) === window.auditCanvas.upperCanvasEl, { x, y }),
          `Stroke ${stroke} starts on a control, not on the drawing canvas`);
        await page.mouse.move(x, y); await page.mouse.down();
        await page.mouse.move(x + 55 * points.zoom, y + 4 * points.zoom, { steps: 12 });
        await page.mouse.up();
        try {
          if (!burst) await page.waitForFunction(() => window.auditMetrics.painted(), undefined, { timeout: 30000 });
        } catch (error) {
          const diagnostic = await page.evaluate(({ x, y }) => ({
            metrics: window.auditMetrics.report(), body: document.body.innerText,
            pending: window.auditControllerRef?.current?.pendingCount(),
            modelChildren: window.auditControllerRef?.current?.getState().snapshot.canvas.objects.find(o => o.boardObjectId === 'audit-notebook')?.notebookPages.at(-1)?.length,
            atContact: document.elementsFromPoint(x, y).slice(0, 6).map(e => ({ tag: e.tagName, class: e.className })),
            canvas: { drawing: window.auditCanvas.isDrawingMode, activeDrawing: window.auditCanvas._isCurrentlyDrawing,
              viewport: window.auditCanvas.viewportTransform, objects: window.auditCanvas._objects.map(o => ({
                id: o.boardObjectId, type: o.type, children: o._objects?.length, left: o.left, top: o.top })).slice(-5) },
          }), { x, y });
          console.error('INK DIAGNOSTIC', JSON.stringify({ scenario, points, stroke, diagnostic, consoleMessages, errors }));
          await writeFile(`${output}/${engineName}-failure.json`, JSON.stringify({ diagnostic, consoleMessages, errors }, null, 2));
          await page.screenshot({ path: `${output}/${engineName}-failure.png` });
          throw error;
        }
      }
      await page.waitForFunction(() => window.auditMetrics.report().samples.every(s => s.pagePaintAt != null), undefined, { timeout: 30000 });
      stage = 'confirmation';
      // Let the REAL outbox/authority finish; publish is never replaced by a stub.
      await page.waitForFunction(floor => window.auditRuntime.getRevision() >= floor,
        startRevision + 16, { timeout: 90000 });
      const report = await page.evaluate(() => ({ ...window.auditMetrics.report(), children: window.auditBookNow()?._objects.length,
        environment: { browser: navigator.userAgent, dpr: devicePixelRatio, cores: navigator.hardwareConcurrency } }));
      await writeFile(`${output}/${engineName}-${index}-diagnostic.json`, JSON.stringify({ scenario, ...report }, null, 2));
      assert.equal(report.children, points.initial + 16);
      assert.equal(report.createdPaths, 16);
      assert.ok(report.controllerStages.filter(x=>x.stage==='enqueue').length >= 16, 'Missing controller CPU samples');
      if (!process.argv.includes('--baseline') && !burst) assert.equal(report.childRenders, 16,
        'Ready-page handwriting must paint only its 16 new strokes, not the earlier page geometry');
      assert.equal(report.samples.filter(s => s.pagePaintAt != null).length, 16);
      report.releaseToPagePaintMs = report.samples.map(s => s.pagePaintAt - s.releaseAt);
      const sorted = [...report.releaseToPagePaintMs].sort((a, b) => a - b);
      report.p50 = sorted[Math.floor(sorted.length * .5)]; report.p95 = sorted[Math.ceil(sorted.length * .95) - 1];
      results.push({ scenario, ...report });
      await page.screenshot({ path: `${output}/${engineName}-${index}.png` });
      console.log(JSON.stringify({ scenario, p50: report.p50, p95: report.p95, listReads: report.listReads, childRenders: report.childRenders }));
    } catch (error) {
      // Preserve startup failures too. Previously an early name/permission gate
      // timeout left no screenshot or state and was indistinguishable from ink.
      let state = null;
      try { state = await page.evaluate(() => ({ body: document.body.innerText,
        durable: document.documentElement.dataset.alexDurableEditState,
        blocked: document.documentElement.dataset.alexDurableEditBlocked,
        controllerReady: Boolean(window.__notebookAuditControllerRef?.current) })); } catch {}
      await writeFile(`${output}/${engineName}-${index}-stage-failure.json`, JSON.stringify({
        stage, scenario, error: error.stack ?? String(error), state, errors, consoleMessages: consoleMessages.slice(-20)
      }, null, 2));
      try { await page.screenshot({ path: `${output}/${engineName}-${index}-stage-failure.png` }); } catch {}
      throw error;
    } finally { await context.close(); }
  }
  assert.deepEqual(errors, [], 'Production page errors during input');
} finally {
  await writeFile(`${output}/${engineName}.json`, JSON.stringify({ source, commit: process.env.GITHUB_SHA || null,
    baseline: process.argv.includes('--baseline'), burst, results, errors, consoleMessages, generatedAt: new Date().toISOString(),
    limitations: ['No physical iPad/Pencil', 'after:render is not physical display presentation', 'Loaded lesson; cold startup not measured', 'Network delay not injected in this fixture', 'Counters add diagnostic overhead'] }, null, 2));
  await browser?.close(); server.kill();
}
