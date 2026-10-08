import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium, webkit } from 'playwright-core';

const engine = process.env.VERIFICATION_BROWSER === 'webkit' ? webkit : chromium;
const port = 5288;
const base = 'http://127.0.0.1:' + port + '/alex/';
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js',
  '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { stdio: 'ignore' });
let browser;
let page;
try {
  let ready = false;
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(base)).ok) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready, 'Vite board test server must start');
  browser = await engine.launch({ headless: true, ...(engine === chromium
    ? { args: ['--no-sandbox'] } : {}) });
  page = await browser.newPage({ viewport: { width: 1220, height: 850 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));

  await page.goto(base + 'scripts/board-media-fixture.html');
  const board = await page.evaluate(async () => {
    const { createBoard } = await import('/alex/src/lib/boardRepository.js');
    return createBoard('Rapid stylus menu / immediate Pencil regression');
  });
  await page.goto(base + 'board/' + board.boardId + '?key=' + board.ownerKey);
  const name = page.getByRole('textbox', { name: 'Ваше имя' });
  // BoardWorkspace's name gate mounts asynchronously after route hydration.
  // count() immediately after goto can be zero while the gate is still loading.
  await name.waitFor({ state: 'visible', timeout: 20_000 });
  await name.fill('Rapid Pencil tester');
  await page.getByRole('button', { name: 'Войти на доску', exact: true }).click();
  await page.waitForFunction(() => (
    document.documentElement.dataset.alexDurableEditState === 'ready'
    && document.documentElement.dataset.alexDurableEditBlocked !== 'true'
    && Boolean(document.querySelector('.board-tool-dock .dock-tool-button'))
  ), null, { timeout: 60_000 });
  // The dock uses native listeners registered by React's passive useEffect.
  // Wait for initial mount effects, not for any delay between later Pencil taps.
  await page.waitForTimeout(600);

  await page.evaluate(() => {
    let fiber = document.querySelector('.toolbar-shell');
    fiber = fiber?.[Object.keys(fiber).find(key => key.startsWith('__reactFiber'))];
    while (fiber && fiber.type?.name !== 'BoardWorkspace') fiber = fiber.return;
    if (!fiber) throw new Error('BoardWorkspace React fiber unavailable for regression');
    for (let hook = fiber.memoizedState; hook; hook = hook.next) {
      const value = hook.memoizedState?.current;
      if (value?.getObjects && value?.getZoom) {
        window.__stylusTestCanvas = value;
        break;
      }
    }
    if (!window.__stylusTestCanvas) throw new Error('Fabric canvas not yet mounted');

    window.__stylusTouch = (button, type, identifier, touchType = 'stylus') => {
      const touch = { identifier, touchType };
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'changedTouches', { value: [touch] });
      Object.defineProperty(event, 'touches', {
        value: type === 'touchend' || type === 'touchcancel' ? [] : [touch],
      });
      button.dispatchEvent(event);
      return event.defaultPrevented;
    };
    window.__tapTool = (name, identifier) => {
      const button = document.querySelector(
        '.board-tool-dock button[aria-label="' + name + '"]');
      if (!button || button.disabled) throw new Error('Missing enabled tool ' + name);
      const canvas = window.__stylusTestCanvas;
      const beforeMode = canvas.isDrawingMode;
      const beforePointer = canvas.enablePointerEvents;
      const preventedStart = window.__stylusTouch(button, 'touchstart', identifier);
      if (preventedStart) throw new Error('Pencil touchstart was cancelled by a menu button');
      if (canvas.isDrawingMode !== beforeMode || canvas.enablePointerEvents !== beforePointer) {
        throw new Error('Tool reconfigured Fabric during physical Pencil down');
      }
      const preventedEnd = window.__stylusTouch(button, 'touchend', identifier);
      if (preventedEnd) throw new Error('Pencil touchend was cancelled by a menu button');
      const expectedDrawing = name === 'Карандаш';
      const expectedPointer = name === 'Выделение';
      if (Boolean(canvas.isDrawingMode) !== expectedDrawing
        || Boolean(canvas.enablePointerEvents) !== expectedPointer) {
        throw new Error('First stroke input mode not ready after Pencil-up: '
          + JSON.stringify({ name, identifier, beforeMode, beforePointer,
            actualDrawing:canvas.isDrawingMode, actualPointer:canvas.enablePointerEvents,
            expectedDrawing, expectedPointer, buttonActive:button.classList.contains('active'),
            buttonConnected:button.isConnected }));
      }
      const ghost = new MouseEvent('click', { bubbles: true, cancelable: true });
      button.dispatchEvent(ghost);
      return { ghostSuppressed: ghost.defaultPrevented };
    };
  });
  const rapid = await page.evaluate(async () => {
    const canvas = window.__stylusTestCanvas;
    const original = canvas.requestRenderAll;
    let renderRequests = 0;
    canvas.requestRenderAll = function (...args) {
      renderRequests++;
      return original.apply(this, args);
    };
    const labels = ['Карандаш', 'Выделение', 'Прямая', 'Ластик', 'Текст'];
    const begun = performance.now();
    let suppressed = 0;
    try {
      for (let i = 0; i < 100; i++) {
        const result = window.__tapTool(labels[i % labels.length], i + 1);
        if (result.ghostSuppressed) suppressed++;
        // Allow actual React commits, DOM mutation observers and Fabric frames
        // to interleave. A runaway interaction loop will time out here.
        if (i % 5 === 4) await new Promise(resolve => requestAnimationFrame(resolve));
      }
      return { taps: 100, suppressed, renderRequests,
        elapsedMs: Math.round(performance.now() - begun) };
    } finally {
      canvas.requestRenderAll = original;
    }
  });
  assert.equal(rapid.taps, 100);
  assert.equal(rapid.suppressed, 100, 'synthetic compatibility clicks cannot reactivate tools');
  assert.ok(rapid.renderRequests < 18,
    'rapid tool switching on an empty selection must not schedule full-board paints: '
      + rapid.renderRequests);

  // Safari can suppress stylus TouchEvents on the second very fast tap, while
  // PointerEvents still arrive. Reproduce 120 alternating Cursor/Pencil taps
  // without requestAnimationFrame, 300ms gesture gap or synthetic TouchEvents.
  const pointerOnly = await page.evaluate(() => {
    const canvas = window.__stylusTestCanvas;
    const sequence = ['Выделение','Карандаш'];
    const start = performance.now();
    for (let n = 0; n < 120; n++) {
      const name = sequence[n % 2];
      const button = document.querySelector(
        '.board-tool-dock button[aria-label="' + name + '"]');
      if (!button || button.disabled) throw new Error('Missing enabled ' + name);
      const id = n + 4000;
      const init = new PointerEvent('pointerdown', {
        pointerType: 'pen', pointerId: id, bubbles: true, cancelable: true,
        isPrimary: true, buttons: 1, pressure: 0.5,
      });
      button.dispatchEvent(init);
      const last = new PointerEvent('pointerup', {
        pointerType: 'pen', pointerId: id, bubbles: true, cancelable: true,
        isPrimary: true, buttons: 0,
      });
      button.dispatchEvent(last);
      if (Boolean(canvas.isDrawingMode) !== (name === 'Карандаш')
        || Boolean(canvas.enablePointerEvents) !== (name === 'Выделение')) {
        throw new Error('Lost rapid pen selection at tap ' + n + ': '
          + name + ' drawing=' + canvas.isDrawingMode
          + ' pointer=' + canvas.enablePointerEvents);
      }
      const ghost = new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 });
      button.dispatchEvent(ghost);
      if (!ghost.defaultPrevented) {
        throw new Error('Unfiltered compatibility click after pointerup: ' + n);
      }
    }
    return { taps: 120, elapsedMs: performance.now() - start };
  });
  assert.equal(pointerOnly.taps, 120);

  // Test a REAL browser mouse stroke with no additional wait/frame after
  // the Pencil selects the brush: the contact-end handler already changed
  // Fabric's input mode synchronously.
  const before = await page.evaluate(() => window.__stylusTestCanvas.getObjects().length);
  const pencilReady = await page.evaluate(() => {
    window.__tapTool('Карандаш', 901);
    const canvas = window.__stylusTestCanvas;
    return { drawing: canvas.isDrawingMode, pointerMode: canvas.enablePointerEvents };
  });
  assert.equal(pencilReady.drawing, true);
  assert.equal(pencilReady.pointerMode, false);
  const rect = await page.locator('.canvas-host .upper-canvas').boundingBox();
  assert.ok(rect, 'Fabric upper canvas is visible');
  const x = rect.x + Math.min(340, rect.width * 0.4);
  const y = rect.y + Math.min(290, rect.height * 0.35);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 135, y + 55, { steps: 10 });
  await page.mouse.up();
  await page.waitForFunction(count => window.__stylusTestCanvas.getObjects().length > count,
    before, { timeout: 15_000 });

  // A shape button toggles a mounted/unmounted palette. One physical Pencil
  // contact must open it only once even if WebKit emits a compatibility click.
  const shape = await page.evaluate(() => window.__tapTool('Фигуры', 902));
  assert.equal(shape.ghostSuppressed, true);
  await page.locator('.shape-palette').waitFor({ state: 'visible' });
  await page.evaluate(() => window.__tapTool('Карандаш', 903));
  await page.locator('.shape-palette').waitFor({ state: 'hidden' });

  // A finger click immediately after Pencil is an intentional second action,
  // not the older Pencil's ghost event.
  const fingerWorked = await page.evaluate(() => {
    const button = document.querySelector('.board-tool-dock button[aria-label="Выделение"]');
    window.__stylusTouch(button, 'touchstart', 777, 'direct');
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return window.__stylusTestCanvas.enablePointerEvents === true;
  });
  assert.equal(fingerWorked, true);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({
    browser: engine === webkit ? 'webkit' : 'chromium',
    rapidMenu: rapid,
    rapidPointerOnlyCursorPencil: pointerOnly,
    immediatePostSwitchStroke: 'passed',
    doubleActionOnShape: false,
    fingerStillWorks: true,
    limitation: 'Browser-simulated stylus TouchEvents plus real mouse stroke; physical Apple Pencil needs device verification.',
  }));
} finally {
  await browser?.close();
  server.kill();
}
