import { chromium, webkit } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { instrumentNotebookControllerSource, notebookAuditEntryState } from './notebook-audit-metrics.js';
const name = process.env.VERIFICATION_BROWSER === 'webkit' ? 'webkit' : 'chromium';
const port = 5265, base = `http://127.0.0.1:${port}/alex/`, output = 'notebook-recovery-results';
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
  { stdio: 'ignore', env: { ...process.env, VITE_NOTEBOOK_OPERATIONS_V1: 'true' } });
let browser, page;
const report = { name, commit: process.env.GITHUB_SHA, results: [], errors: [], limitations: [
  'Native UI interleaving uses a test-only gate at an actual yielded task; not a pen-latency measurement',
  'No physical iPad/Pencil or real remote network',
] };
try {
  await mkdir(output, { recursive: true }); let ready = false;
  for (let i = 0; i < 150; i++) { try { if ((await fetch(base)).ok) { ready = true; break; } } catch {} await new Promise(r => setTimeout(r, 100)); }
  assert.ok(ready, 'Vite did not start');
  browser = await (name === 'webkit' ? webkit : chromium).launch({ headless: true, ...(name === 'chromium' ? {
    args: ['--no-sandbox'], ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}),
  } : {}) });
  page = await browser.newPage({ viewport: { width: 1100, height: 850 }, deviceScaleFactor: 2 });
  page.on('pageerror', e => report.errors.push(e.message));
  await page.goto(base + 'scripts/board-media-fixture.html');
  report.results = await page.evaluate(async () => (await import('/alex/scripts/notebook-recovery-fixture.js')).runNotebookRecoveryCases());
  assert.equal(report.results.length, 5);
  for (const item of report.results) assert.equal(item.error, undefined, JSON.stringify(item));

  const controllerSource = instrumentNotebookControllerSource(await readFile('src/lib/notebookBoardController.js', 'utf8'));
  await page.route(/\/src\/lib\/notebookBoardController\.js(?:\?.*)?$/, route => route.fulfill({ status: 200, contentType: 'text/javascript', body: controllerSource }));
  // Hold only the FIRST real cooperative boundary, never replace preparation,
  // operations, persistence or acknowledgement. Without a yield the test fails.
  const scheduler = (await readFile('src/lib/notebookWorkScheduler.js', 'utf8')).replace('export function createNotebookWorkSlice()', 'function recoveryTestOriginalSlice()') + `
export function createNotebookWorkSlice() {
 const slice = recoveryTestOriginalSlice(), before = slice.beforeWork.bind(slice);
 slice.beforeWork = () => { const pause = before(); const gate = globalThis.__recoveryGate;
  if (pause && gate?.armed) { gate.armed = false; gate.hit = true; return pause.then(() => gate.wait); }
  return pause;
 }; return slice;
}
`;
  await page.route(/\/src\/lib\/notebookWorkScheduler\.js(?:\?.*)?$/, route => route.fulfill({ status: 200, contentType: 'text/javascript', body: scheduler }));
  const board = await page.evaluate(async () => {
    const { createBoard } = await import('/alex/src/lib/boardRepository.js');
    const { saveAuthoritySnapshot } = await import('/alex/src/lib/browserAuthorityStore.js');
    const { makeAuditSnapshot } = await import('/alex/scripts/notebook-audit-metrics.js');
    const board = await createBoard('Cooperative recovery regression');
    await saveAuthoritySnapshot(board.boardId, makeAuditSnapshot({ pageStrokes: 0 }), 0); return board;
  });
  await page.goto(`${base}board/${board.boardId}?key=${board.ownerKey}`);
  await page.waitForFunction(notebookAuditEntryState, undefined, { timeout: 90000 });
  const nameGate = page.getByRole('textbox', { name: 'Ваше имя' });
  if (await nameGate.count()) { await nameGate.fill('Recovery tester'); await page.getByRole('button', { name: 'Войти на доску', exact: true }).click(); }
  await page.waitForFunction(() => document.documentElement.dataset.alexDurableEditState === 'ready'
    && document.documentElement.dataset.alexDurableEditBlocked !== 'true', undefined, { timeout: 90000 });
  await page.evaluate(async () => {
    let fiber = document.querySelector('.toolbar-shell'); fiber = fiber?.[Object.keys(fiber).find(k => k.startsWith('__reactFiber'))];
    while (fiber && fiber.type?.name !== 'BoardWorkspace') fiber = fiber.return;
    for (let hook = fiber?.memoizedState; hook; hook = hook.next) {
      const value = hook.memoizedState?.current;
      if (value?.getObjects && value?.getZoom) window.recoveryCanvas = value;
      if (value?.capture && value?.ensure) window.recoveryHandlers = value;
    }
    if (!window.recoveryCanvas || !window.recoveryHandlers) throw Error('Production Board not found');
    window.recoveryBook = () => window.recoveryCanvas._objects.find(o => o.boardObjectId === 'audit-notebook');
  });
  // Durable-edit readiness precedes Board's complete initial canvas load. The
  // real ensure callback may legitimately return null at that boundary. Retry
  // acquisition, not the test operation, until the actual controller is ready.
  await page.waitForFunction(async () => {
    await window.recoveryHandlers.ensure();
    return !!window.recoveryBook() && !!window.__notebookAuditControllerRef?.current;
  }, undefined, { timeout: 90000 });
  await page.evaluate(async () => {
    const c = window.__notebookAuditControllerRef.current; c.pause('test backlog');
    const handles = Array.from({ length: 128 }, (_, i) => c.enqueue({ actionId: `backlog-${i}`, ops: [{
      type: 'notebook', version: 1, id: 'audit-notebook', pageNumber: 1, changes: [{ type: 'insert', ifAbsent: true,
        object: { type: 'Rect', boardObjectId: `backlog-child-${i}`, left: -200 + i % 16 * 4, top: -180 + Math.floor(i / 16) * 4, width: 2, height: 2, fill: 'black' } }],
    }] }));
    await Promise.all(handles.map(h => h.durable)); await c.whenPainted();
  });
  await page.getByRole('button', { name: 'Карандаш', exact: true }).click();
  const point = await page.evaluate(() => {
    const c = window.recoveryCanvas, b = window.recoveryBook().getBoundingRect(), r = c.upperCanvasEl.getBoundingClientRect(), v = c.viewportTransform;
    return { x: r.left + (b.left + 90) * v[0] + v[4], y: r.top + (b.top + b.height * .6) * v[3] + v[5], zoom: c.getZoom() };
  });
  await page.evaluate(() => {
    const gate = window.__recoveryGate = { armed: true, hit: false, released: false };
    gate.wait = new Promise(resolve => { gate.release = () => { gate.released = true; resolve(); }; });
    window.recoveryDone = false; const c = window.__notebookAuditControllerRef.current;
    window.recoveryTask = c.rebaseAsync(c.getConfirmedState()).then(() => { window.recoveryDone = true; });
  });
  await page.waitForFunction(() => window.__recoveryGate.hit, undefined, { timeout: 30000 });
  assert.ok(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y) === window.recoveryCanvas.upperCanvasEl, point), 'input hidden by controls');
  await page.mouse.move(point.x, point.y); await page.mouse.down();
  await page.mouse.move(point.x + 50 * point.zoom, point.y + 6 * point.zoom, { steps: 8 }); await page.mouse.up();
  await page.waitForFunction(() => window.__notebookAuditControllerRef.current.pendingCount() === 129, undefined, { timeout: 30000 });
  report.interleavedInput = await page.evaluate(() => ({ beforeRecoveryFinish: !window.recoveryDone,
    modelChildren: window.__notebookAuditControllerRef.current.getState().snapshot.canvas.objects.find(o => o.boardObjectId === 'audit-notebook').notebookPages[0].length,
    visibleChildren: window.recoveryBook()._objects.length }));
  assert.equal(report.interleavedInput.beforeRecoveryFinish, true);
  assert.equal(report.interleavedInput.modelChildren, 129);
  await page.evaluate(async () => { window.__recoveryGate.release(); await window.recoveryTask; const c = window.__notebookAuditControllerRef.current;
    await c.whenPainted(); c.resume(); await c.flush(); });
  assert.equal(await page.evaluate(() => window.recoveryBook()._objects.length), 129);
  await page.keyboard.press('Control+z');
  await page.waitForFunction(() => window.recoveryBook()._objects.length === 128, undefined, { timeout: 30000 });
  await page.evaluate(() => window.__notebookAuditControllerRef.current.flush());
  await page.keyboard.press('Control+Shift+z');
  await page.waitForFunction(() => window.recoveryBook()._objects.length === 129, undefined, { timeout: 30000 });
  await page.evaluate(() => window.__notebookAuditControllerRef.current.flush());
  report.persisted = await page.evaluate(() => {
    // Runtime state and zero pending are checked below; existing storage gates
    // additionally exercise restart. This test does not count a cached screenshot.
    const c = window.__notebookAuditControllerRef.current;
    return { revision: c.getConfirmedState().revision, pending: c.pendingCount(), children: window.recoveryBook()._objects.length };
  });
  assert.equal(report.persisted.pending, 0); assert.equal(report.persisted.children, 129);
  assert.deepEqual(report.errors, []);
  console.log(`${name}: five recovery model cases plus real UI writing during recovery and undo/redo passed`);
} catch (error) {
  report.failure = error.stack ?? error.message;
  try { report.uiText = await page?.locator('body').innerText(); await page?.screenshot({ path: `${output}/${name}-failure.png` }); } catch {}
  throw error;
} finally { await writeFile(`${output}/${name}.json`, JSON.stringify(report, null, 2)); await browser?.close(); server.kill(); }
