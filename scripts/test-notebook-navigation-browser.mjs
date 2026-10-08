import { chromium, webkit } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { createCanvas, loadImage } from 'canvas';

async function createLegacyNotebook(p) {
  // Screenshot replaced the Notebook button. Wait for the same enabled state
  // that Playwright's old button.click() awaited before invoking the retained
  // notebook creation callback. This keeps legacy coverage without UI clutter.
  await p.waitForFunction(() => {
    const button = document.querySelector('.board-tool-dock .dock-tool-button[title="Screenshot"]');
    return Boolean(button && !button.disabled);
  });
  await p.evaluate(() => {
    const element = document.querySelector('.toolbar-shell');
    let fiber = element?.[Object.keys(element).find(key => key.startsWith('__reactFiber'))];
    while (fiber && !fiber.memoizedProps?.onAddNotebook) fiber = fiber.return;
    if (typeof fiber?.memoizedProps?.onAddNotebook !== 'function') {
      throw new Error('Legacy notebook action is unavailable');
    }
    fiber.memoizedProps.onAddNotebook();
  });
}

const engine = process.env.VERIFICATION_BROWSER === 'webkit' ? 'webkit' : 'chromium';
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1'], { stdio: 'ignore' });
const browser = await (engine === 'webkit' ? webkit : chromium).launch({ headless: true,
  ...(engine === 'chromium' ? { args: ['--no-sandbox'], ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}) } : {}) });
const results = [], errors = [];
let page;
await mkdir('notebook-navigation-results', { recursive: true });
async function openBoard({ touch = false } = {}) {
  const context = await browser.newContext({ viewport: { width: 1200, height: 900 }, hasTouch: touch });
  const p = await context.newPage(); p.on('pageerror', error => errors.push(error.message));
  await p.goto('http://127.0.0.1:5173/alex/scripts/board-media-fixture.html');
  const record = await p.evaluate(async () => { const { createBoard } = await import('/alex/src/lib/boardRepository.js'); return createBoard('Persistent notebook navigation'); });
  await p.goto(`http://127.0.0.1:5173/alex/board/${record.boardId}?key=${record.ownerKey}`);
  await p.getByRole('textbox', { name: 'Ваше имя' }).fill('Navigation test');
  await p.getByRole('button', { name: 'Войти на доску', exact: true }).click();
  await p.waitForFunction(() => document.documentElement.dataset.alexDurableEditState === 'ready' && document.documentElement.dataset.alexDurableEditBlocked !== 'true');
  await createLegacyNotebook(p);
  await p.locator('.notebook-page-controls').waitFor();
  await p.evaluate(() => {
    let f = document.querySelector('.toolbar-shell'); f = f[Object.keys(f).find(k => k.startsWith('__reactFiber'))];
    while (f && f.type?.name !== 'BoardWorkspace') f = f.return;
    for (let h = f.memoizedState; h; h = h.next) { const v = h.memoizedState?.current; if (v?.getObjects && v?.getZoom) { window.c = v; break; } }
    window.toolbar = () => { let n = document.querySelector('.toolbar-shell'), f = n[Object.keys(n).find(k => k.startsWith('__reactFiber'))]; while (f && !f.memoizedProps?.onAddNotebook) f = f.return; return f.memoizedProps; };
    window.book = () => window.c.getObjects().find(o => o.type === 'boardnotebook');
    window.screenPoint = p => { const v = window.c.viewportTransform, r = window.c.upperCanvasEl.getBoundingClientRect(); return { x: r.left + p.x * v[0] + p.y * v[2] + v[4], y: r.top + p.x * v[1] + p.y * v[3] + v[5] }; };
  });
  return p;
}
const next = p => p.locator('.notebook-nav-next button').first();
const previous = p => p.locator('.notebook-nav-previous button').first();
async function choose(p, tool) {
  await p.evaluate(tool => { window.toolbar().setTool(tool); window.c.discardActiveObject(); window.c.requestRenderAll(); }, tool);
  await p.waitForFunction(tool => window.toolbar().tool === tool, tool);
  assert.equal(await p.locator('.notebook-page-controls').count(), 1, 'navigation persists without selection');
}
async function whitePadding(p, selector) {
  const box = await p.locator(selector).first().boundingBox();
  const pixel = { x: Math.round(box.x + 2), y: Math.round(box.y + box.height / 2) };
  const png = await p.screenshot({ clip: { ...pixel, width: 1, height: 1 } });
  const image = await loadImage(png), canvas = createCanvas(1, 1), ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
  const data = [...ctx.getImageData(0, 0, 1, 1).data];
  assert.ok(data.slice(0, 3).every(v => v >= 250), `${selector} must remain opaque white: ${data}`);
  return pixel;
}
async function checkAnchors(p) {
  const frame = await p.evaluate(() => { const n = window.book(), box = n.getBoundingRect(); return { tl: window.screenPoint({ x: box.left, y: box.top }), br: window.screenPoint({ x: box.left + box.width, y: box.top + box.height }) }; });
  const boxes = await Promise.all(['.notebook-nav-previous', '.notebook-page-number', '.notebook-nav-next'].map(selector => p.locator(selector).first().boundingBox()));
  for (const box of boxes) {
    assert.ok(box.x >= frame.tl.x && box.y >= frame.tl.y && box.x + box.width <= frame.br.x + 1 && box.y + box.height <= frame.br.y + 1, 'control stays inside its page');
  }
  assert.ok(boxes[0].x < boxes[1].x && boxes[1].x < boxes[2].x);
  assert.ok(Math.abs(boxes[1].x + boxes[1].width / 2 - (frame.tl.x + frame.br.x) / 2) < 1, 'page number is centred');
  assert.ok(Math.abs(boxes[0].y - boxes[2].y) < 1);
}
try {
  for (let i = 0; i < 100; i++) { try { if ((await fetch('http://127.0.0.1:5173/alex/')).ok) break; } catch {} await new Promise(r => setTimeout(r, 100)); }
  page = await openBoard(); await checkAnchors(page);
  assert.equal(await previous(page).isVisible(), true); assert.equal(await previous(page).isDisabled(), true);
  for (const tool of ['pencil', 'line', 'eraser', 'text', 'shape', 'select']) {
    await choose(page, tool);
    await next(page).click(); await page.waitForFunction(() => window.book().notebookPageNumber === 2);
    await previous(page).click(); await page.waitForFunction(() => window.book().notebookPageNumber === 1);
    await page.locator('.notebook-page-number').click();
    assert.equal(await page.evaluate(() => window.toolbar().tool), tool);
    assert.equal(await page.evaluate(() => window.c.getActiveObject() == null), true);
    assert.equal(await page.evaluate(() => window.c.getObjects().length), 1, 'tap must not add a drawing/text or erase the frame');
    assert.equal(await page.evaluate(() => window.book().getPageObjects().length), 0);
  }
  results.push('native mouse page turns with all six tools, no selection or accidental marks');
  await next(page).focus(); await page.keyboard.press('Enter'); await page.waitForFunction(() => window.book().notebookPageNumber === 2);
  await previous(page).focus(); await page.keyboard.press('Space'); await page.waitForFunction(() => window.book().notebookPageNumber === 1);
  results.push('keyboard Enter and Space turn exactly once');

  await choose(page, 'text');
  const textPoint = await page.evaluate(() => { const b = window.book().getBoundingRect(); return window.screenPoint({ x: b.left + 70, y: b.top + 90 }); });
  await page.mouse.click(textPoint.x, textPoint.y);
  await page.waitForFunction(() => window.c.getActiveObject()?.isEditing === true);
  await page.keyboard.type('Saved before next page');
  await next(page).click();
  await page.waitForFunction(() => window.book().notebookPageNumber === 2 && window.book().notebookPages[0].some(o => o.text === 'Saved before next page'));
  assert.equal(await page.evaluate(() => window.toolbar().tool), 'text');
  await previous(page).click(); await page.waitForFunction(() => window.book().notebookPageNumber === 1);
  results.push('an active typed draft is saved to the old page and the text tool is preserved');

  await choose(page, 'pencil');
  const childCount = await page.evaluate(() => window.book().getPageObjects().length);
  const line = await page.evaluate(() => { const n = window.book(), b = n.getBoundingRect(); window.c.freeDrawingBrush.width = 12; window.c.freeDrawingBrush.color = '#d81640';
    return { start: window.screenPoint({ x: b.left - 75, y: b.top + b.height - 32 }), end: window.screenPoint({ x: b.left + b.width + 75, y: b.top + b.height - 32 }) }; });
  await page.mouse.move(line.start.x, line.start.y); await page.mouse.down();
  await page.mouse.move(line.end.x, line.end.y, { steps: 35 });
  assert.equal(await page.locator('.notebook-navigation-layer').getAttribute('data-gesture-active'), 'true');
  for (const selector of ['.notebook-nav-previous', '.notebook-page-number', '.notebook-nav-next']) await whitePadding(page, selector);
  await page.screenshot({ path: `notebook-navigation-results/${engine}-live-stroke.png` });
  await page.mouse.up();
  await page.waitForFunction(count => window.book().getPageObjects().length > count, childCount);
  assert.equal(await page.evaluate(() => window.book().notebookPageNumber), 1, 'crossing both arrows must not turn');
  const covered = await whitePadding(page, '.notebook-nav-next');
  const underlying = await page.evaluate(p => { const c = window.c, r = c.lowerCanvasEl.getBoundingClientRect(), ratio = c.lowerCanvasEl.width / r.width;
    return [...c.contextContainer.getImageData(Math.round((p.x - r.left) * ratio), Math.round((p.y - r.top) * ratio), 1, 1).data]; }, covered);
  assert.ok(underlying.slice(0, 3).some(v => v < 200), `ink under the navigation must be retained, not deleted: ${underlying}`);
  assert.ok(await page.evaluate(() => window.c.getObjects().length > 1), 'outside stroke fragment remains outside');
  results.push('continuous outside/page stroke passes all islands without turning; screen stays clean and underlying ink remains');

  const endBox = await next(page).boundingBox();
  await page.mouse.move(endBox.x - 90, endBox.y - 50); await page.mouse.down();
  await page.mouse.move(endBox.x + endBox.width / 2, endBox.y + endBox.height / 2, { steps: 10 }); await page.mouse.up();
  await page.waitForTimeout(250); assert.equal(await page.evaluate(() => window.book().notebookPageNumber), 1);
  results.push('stroke ending on arrow does not produce a compatibility-click page turn');

  // These transient render probes deliberately do not modify stored content.
  for (const kind of ['shape', 'text', 'image']) {
    await page.evaluate(async kind => {
      const { Rect, Textbox, FabricImage } = await import('/alex/node_modules/.vite/deps/fabric.js');
      const b = window.book().getBoundingRect(), options = { left: b.left, top: b.top + b.height - 60, originX: 'left', originY: 'top' };
      if (kind === 'shape') window.maskProbe = new Rect({ ...options, width: b.width, height: 70, fill: '#cf1640' });
      else if (kind === 'text') window.maskProbe = new Textbox('MMMMMMMMMMMMMMMM', { ...options, width: b.width, fontSize: 54, backgroundColor: '#cf1640' });
      else { const pixels = document.createElement('canvas'); pixels.width = b.width; pixels.height = 70; const ctx = pixels.getContext('2d'); ctx.fillStyle = '#cf1640'; ctx.fillRect(0, 0, pixels.width, pixels.height); window.maskProbe = new FabricImage(pixels, options); }
      window.c.add(window.maskProbe); window.c.renderAll();
    }, kind);
    for (const selector of ['.notebook-nav-previous', '.notebook-page-number', '.notebook-nav-next']) await whitePadding(page, selector);
    await page.evaluate(() => { window.c.remove(window.maskProbe); window.maskProbe.dispose(); window.c.renderAll(); });
  }
  results.push('top-level shape, text and image cannot cover the three clean fields');

  await choose(page, 'select');
  await page.getByRole('button', { name: 'Выделение', exact: true }).focus();
  const frame = await page.evaluate(() => { const c = window.c, n = window.book(), b = n.getBoundingRect(); c.setActiveObject(n); n.setCoords(); c.requestRenderAll(); return { left: n.left, top: n.top, point: window.screenPoint({ x: b.left + 300, y: b.top + 120 }) }; });
  await page.mouse.move(frame.point.x, frame.point.y); await page.mouse.down();
  await page.waitForFunction(() => window.c._currentTransform?.target?.lockMovementX === false);
  await page.mouse.move(frame.point.x + 40, frame.point.y + 25, { steps: 10 }); await page.mouse.up();
  await page.waitForTimeout(200); await checkAnchors(page);
  await next(page).click(); await page.waitForFunction(() => window.book().notebookPageNumber === 2);
  assert.ok(await page.evaluate(f => Math.abs(window.book().left - f.left - 40) < 0.1 && Math.abs(window.book().top - f.top - 25) < 0.1, frame));
  const handle = await page.evaluate(() => { const c = window.c, n = window.book(); c.setActiveObject(n); n.setCoords(); c.requestRenderAll(); const r = c.upperCanvasEl.getBoundingClientRect(); return { x: r.left + n.oCoords.br.x, y: r.top + n.oCoords.br.y, scale: n.scaleX }; });
  await page.mouse.move(handle.x, handle.y); await page.mouse.down();
  await page.waitForFunction(() => window.c._currentTransform?.target?.lockScalingX === false);
  await page.mouse.move(handle.x + 25, handle.y + 25, { steps: 8 }); await page.mouse.up();
  await page.waitForTimeout(200); assert.ok(await page.evaluate(scale => window.book().scaleX > scale, handle.scale)); await checkAnchors(page);
  for (const zoom of [0.65, 1.2, 1]) { await page.evaluate(z => { window.c.setViewportTransform([z, 0, 0, z, 0, 0]); window.c.requestRenderAll(); }, zoom); await page.waitForTimeout(75); await checkAnchors(page); }
  assert.equal(await page.locator('.notebook-edit-text').count(), 0);
  results.push('native move, page turn, corner resize and zoom preserve in-page anchors without a selection panel');

  await page.evaluate(async () => { const { createBoardNotebook } = await import('/alex/src/lib/boardNotebook.js'); const n = createBoardNotebook({ left: 30, top: 90, width: 260, height: 240 }); n.boardObjectId = 'navigation-second'; window.c.add(n); window.c.fire('path:created', { path: n }); });
  await page.waitForFunction(() => document.querySelectorAll('.notebook-page-controls').length === 2);
  const second = page.locator('[data-notebook-id="navigation-second"]');
  await second.locator('.notebook-nav-next button').click();
  await page.waitForFunction(() => window.c.getObjects().find(o => o.boardObjectId === 'navigation-second').notebookPageNumber === 2);
  assert.equal(await page.evaluate(() => window.book().notebookPageNumber), 2);
  await page.screenshot({ path: `notebook-navigation-results/${engine}-two-notebooks.png` });
  results.push('each unselected notebook owns independent persistent controls');

  page = await openBoard({ touch: true });
  for (const tool of ['pencil', 'eraser', 'text', 'line', 'shape', 'select']) {
    await choose(page, tool); const b = await next(page).boundingBox();
    await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2); await page.waitForFunction(() => window.book().notebookPageNumber === 2);
    const prev = await previous(page).boundingBox(); await page.touchscreen.tap(prev.x + prev.width / 2, prev.y + prev.height / 2); await page.waitForFunction(() => window.book().notebookPageNumber === 1);
    assert.equal(await page.evaluate(() => window.toolbar().tool), tool);
    assert.equal(await page.evaluate(() => window.c.getObjects().length), 1);
    assert.equal(await page.evaluate(() => window.book().getPageObjects().length), 0);
  }
  results.push('native touchscreen taps with all six tools leave no dot, text, erasure or selection');
  assert.deepEqual(errors, []);
} catch (error) {
  if (page) await page.screenshot({ path: `notebook-navigation-results/${engine}-failure.png` }).catch(() => {});
  await writeFile(`notebook-navigation-results/${engine}-failure.json`, JSON.stringify({ message: error.message, stack: error.stack, results, errors,
    state: await page?.evaluate(() => ({ text: document.body.innerText, tool: window.toolbar?.()?.tool, frame: window.book?.()?.getBoundingRect(), controls: document.querySelector('.notebook-navigation-layer')?.outerHTML })).catch(() => null) }, null, 2));
  throw error;
} finally {
  await writeFile(`notebook-navigation-results/${engine}.json`, JSON.stringify({ engine, results, errors }, null, 2));
  await browser.close(); server.kill();
}
console.log(JSON.stringify({ engine, results, errors }, null, 2));
