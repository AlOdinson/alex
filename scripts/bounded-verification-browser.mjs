import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'node:fs/promises';
import { chromium, webkit } from 'playwright-core';
import { deriveShareKey } from '../src/lib/ids.js';

const engine = process.env.VERIFICATION_BROWSER ?? 'chromium';
const home = process.env.VERIFICATION_TEST_URL ?? 'http://127.0.0.1:5173/alex/';
await mkdir('bounded-browser-results', { recursive: true });
const browser = await (engine === 'webkit' ? webkit.launch({ headless: true })
  : chromium.launch({ channel: 'chrome', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] }));
const testRelay = process.env.VERIFICATION_TEST_TURN === '1';
if (testRelay && !['127.0.0.1', 'localhost'].includes(new URL(home).hostname)) {
  throw new Error('The test-only loopback relay must never run against a production site');
}
const results = [];
const failures = [];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function wait(label, fn, timeout = 45000) {
  const deadline = Date.now() + timeout; let last;
  while (Date.now() < deadline) {
    try { const result = await fn(); if (result) return result; } catch (error) { last = error; }
    await delay(60);
  }
  throw new Error(`${label}: ${last?.message ?? 'timed out'}`);
}
async function installInspection(page) {
  page.on('pageerror', (error) => failures.push(error.message));
  page.on('console', (message) => { if (message.type() === 'warning' || message.type() === 'error') console.log('BROWSER', message.text().replace(/([?&](?:access_token|key|credential)=)[^&\s'"]+/g, '$1[REDACTED]')); });
  await page.addInitScript(() => {
    window.__boundedRefs = () => {
      let canvas = null; let realtime = null; let element = document.querySelector('canvas.upper-canvas');
      while (element) {
        const key = Object.keys(element).find((value) => value.startsWith('__reactFiber$'));
        let fiber = key ? element[key] : null;
        while (fiber) {
          let hook = fiber.memoizedState; let count = 0;
          while (hook && count++ < 900) {
            const current = hook.memoizedState?.current;
            if (current?.getObjects && current?.lowerCanvasEl) canvas = current;
            if (typeof current?.getVerificationStats === 'function' && typeof current?.sendOps === 'function') realtime = current;
            hook = hook.next;
          }
          fiber = fiber.return;
        }
        if (canvas && realtime) return { canvas, realtime };
        element = element.parentElement;
      }
      return { canvas, realtime };
    };
    window.__boundedMessages = [];
    const send = RTCDataChannel.prototype.send;
    RTCDataChannel.prototype.send = function (data) {
      try {
        const message = JSON.parse(data);
        if (message.payload?.verification) window.__boundedMessages.push({ type: message.type,
          size: message.payload.verification.entries?.length, status: message.payload.verification.status });
      } catch { /* binary/ordinary transfer */ }
      return send.call(this, data);
    };
  });
}
async function enter(page, name) {
  await wait('board/name gate', async () => {
    if (await page.locator('canvas.upper-canvas').isVisible()) return true;
    const field = page.getByLabel('Ваше имя');
    if (await field.isVisible()) { await field.fill(name); await page.getByRole('button', { name: 'Войти на доску' }).click(); }
    return false;
  });
  await wait('durable ready', () => page.evaluate(() => document.documentElement.dataset.alexDurableEditState === 'ready'));
  await wait('Canvas/runtime inspection', () => page.evaluate(() => Boolean(window.__boundedRefs().canvas && window.__boundedRefs().realtime)));
}
async function count(page) {
  return page.evaluate(() => window.__boundedRefs().canvas.getObjects().filter((o) => o.boardObjectId && !o.transientPreview && !o.transientScreenShare && !o.transientSelectionProxy).length);
}
async function stroke(page, i = 0) {
  await page.getByRole('button', { name: 'Карандаш', exact: true }).click();
  const box = await page.locator('canvas.upper-canvas').boundingBox();
  const x = box.x + 70 + (i % 10) * 40; const y = box.y + 100 + (Math.floor(i / 10) % 10) * 30;
  await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + 20, y + 10, { steps: 2 }); await page.mouse.up();
}
try {
  const fixture = await browser.newPage();
  await fixture.goto(new URL('scripts/bounded-verification-fixture.html', home).href);
  await fixture.waitForFunction(() => typeof window.runBoundedFabricChecks === 'function');
  results.push({ name: 'native Fabric comparisons and 100-object workloads', engine, ...(await fixture.evaluate(() => window.runBoundedFabricChecks())) });
  await fixture.close();

  // This full-app test uses the existing stateless connection broker only for two
  // fresh synthetic browser contexts. It never opens/migrates a user's old board.
  if (engine === 'chromium' || engine === 'webkit') {
    const ownerContext = await browser.newContext({ viewport: { width: 1280, height: 850 } });
    const studentContext = await browser.newContext({ viewport: { width: 1024, height: 900 }, hasTouch: true });
    if (testRelay) {
      // Only the CI NAT route is substituted; RTC, DataChannel and every app
      // protocol/Canvas/history handler stay native. No production config changes.
      for (const context of [ownerContext, studentContext]) await context.addInitScript(() => {
        const NativePeer = globalThis.RTCPeerConnection;
        globalThis.RTCPeerConnection = class extends NativePeer {
          constructor(configuration = {}) {
            super({ ...configuration, iceTransportPolicy: 'relay', iceServers: [{
              urls: 'turn:127.0.0.1:3478?transport=tcp',
              username: 'bounded-ci', credential: 'bounded-ci-loopback-only-20260925',
            }] });
          }
        };
      });
    }
    results.push({ name: 'native network route', route: testRelay ? 'isolated loopback TURN (CI only)' : 'unchanged production ICE configuration' });
    const owner = await ownerContext.newPage(); const student = await studentContext.newPage();
    await installInspection(owner); await installInspection(student);
    await owner.goto(home);
    // Create a synthetic legacy-format record in this isolated browser only. No
    // user's existing board is opened or migrated during compatibility checks.
    const oldUrl = await owner.evaluate(async (base) => {
      const ids = await import(new URL('src/lib/ids.js', base).href);
      const store = await import(new URL('src/lib/browserAuthorityStore.js', base).href);
      const ownerKey = ids.randomToken(28); const shareKey = await ids.deriveShareKey(ownerKey);
      const boardId = ids.randomToken(12);
      await store.createAuthorityBoard({ boardId, ownerKey, shareKey, realtimeKey: shareKey,
        title: 'Synthetic unmarked legacy board', guestMode: 'edit' });
      return new URL(`board/${boardId}?key=${ownerKey}`, base).href;
    }, home);
    await owner.goto(oldUrl); await enter(owner, 'Synthetic owner');
    assert.equal(await owner.evaluate(() => window.__boundedRefs().realtime.getVerificationStats().enabled), false);
    await stroke(owner, 0);
    await owner.evaluate(() => window.__boundedRefs().realtime.flushPending());
    await owner.reload(); await enter(owner, 'Synthetic owner');
    assert.equal(await owner.evaluate(() => window.__boundedRefs().realtime.getVerificationStats().enabled), false);
    assert.equal(await count(owner), 1);
    results.push({ name: 'legacy board remains unmarked and disabled after edit/reopen', passed: true });
    await owner.goto(home);
    await owner.getByLabel('Название доски').fill('Bounded verification synthetic test');
    await owner.getByRole('button', { name: 'Создать доску', exact: true }).click(); await enter(owner, 'Synthetic owner');
    const guest = new URL(owner.url()); guest.searchParams.set('key', await deriveShareKey(guest.searchParams.get('key')));
    await student.goto(guest.href); await enter(student, 'Synthetic student');
    for (const page of [owner, student]) await wait('new board feature enabled', () => page.evaluate(() => window.__boundedRefs().realtime.getVerificationStats().enabled));
    for (let i = 0; i < 5; i++) await stroke(owner, i);
    await wait('five strokes on both devices', async () => (await count(owner)) === 5 && (await count(student)) === 5);
    const first = await student.evaluate(() => window.__boundedRefs().canvas.getObjects().find((o) => o.boardObjectId && !o.transientPreview).boardObjectId);
    const replicaModule = new URL('src/lib/browserReplicaStore.js', home).href;
    await student.evaluate(async ({ id, module }) => {
      const store = await import(module); const boardId = decodeURIComponent(location.pathname.match(/\/board\/([^/]+)/)[1]);
      const view = store.getReplicaVerificationView(boardId); const record = structuredClone(view.read(id)); record.object.stroke = '#ff00ff';
      store.applyReplicaVerificationRecords(boardId, [record], view.revision());
      window.__boundedRefs().canvas.getObjects().find((o) => o.boardObjectId === id).set({ stroke: '#ff00ff' });
    }, { id: first, module: replicaModule });
    await stroke(owner, 5);
    await wait('same-revision stale color repaired on actual Canvas', () => student.evaluate((id) => {
      const object = window.__boundedRefs().canvas.getObjects().find((o) => o.boardObjectId === id);
      return object && object.stroke !== '#ff00ff';
    }, first));
    results.push({ name: 'same-revision canonical and visible color repaired', passed: true });
    await student.evaluate(async () => {
      const canvas = window.__boundedRefs().canvas;
      const copy = await canvas.getObjects().find((o) => o.boardObjectId && !o.transientPreview).clone(['boardObjectId']);
      copy.boardObjectId = 'synthetic-extra-ghost'; canvas.add(copy);
    });
    await stroke(owner, 6);
    await wait('extra Canvas-only ghost removed', () => student.evaluate(() => !window.__boundedRefs().canvas.getObjects().some((o) => o.boardObjectId === 'synthetic-extra-ghost')));
    results.push({ name: 'Canvas-only lost-delete ghost repaired', passed: true });
    await student.evaluate(async ({ id, module }) => {
      const store = await import(module); const boardId = decodeURIComponent(location.pathname.match(/\/board\/([^/]+)/)[1]);
      store.applyReplicaVerificationRecords(boardId, [{ id, object: null, zIndex: -1 }], store.getReplicaRevision(boardId));
      const canvas = window.__boundedRefs().canvas; canvas.getObjects().filter((o) => o.boardObjectId === id).forEach((o) => canvas.remove(o));
    }, { id: first, module: replicaModule });
    await stroke(owner, 7);
    await wait('missing replica and Canvas object discovered by source membership page', () => student.evaluate((id) => window.__boundedRefs().canvas.getObjects().some((o) => o.boardObjectId === id), first));
    results.push({ name: 'missing canonical and visible object restored', passed: true });
    const initial = await count(owner);
    for (let i = 0; i < 100; i++) await stroke(owner, i);
    await wait('100 fast strokes converge', async () => (await count(owner)) === initial + 100 && (await count(student)) === initial + 100, 90000);
    await owner.getByRole('button', { name: /Отменить —/ }).evaluate((button) => { for (let i = 0; i < 30; i++) button.click(); });
    await wait('30 fast undo commands converge', async () => (await count(owner)) === initial + 70 && (await count(student)) === initial + 70, 90000);
    await owner.getByRole('button', { name: /Вернуть —/ }).evaluate((button) => { for (let i = 0; i < 30; i++) button.click(); });
    await wait('30 fast redo commands converge', async () => (await count(owner)) === initial + 100 && (await count(student)) === initial + 100, 90000);
    await wait('verification queue drains without polling', () => student.evaluate(() => {
      const state = window.__boundedRefs().realtime.getVerificationStats();
      return !state.active && !state.pendingIds && !state.sweepPending;
    }), 90000);
    const messages = await student.evaluate(() => window.__boundedMessages);
    assert.ok(messages.some((m) => m.type === 'head-request'));
    assert.ok(messages.every((m) => m.size == null || m.size <= 100));
    results.push({ name: '100 real strokes + 30 undo + 30 redo; queue drained, requests bounded', passed: true, requests: messages.length });
    // Exercise the real group gesture and history path with more than one batch.
    for (let i = await count(owner); i < 300; i++) await stroke(owner, i);
    await wait('300 objects durable on both devices', async () => await count(owner) === 300 && await count(student) === 300, 90000);
    const positions = (page) => page.evaluate(() => window.__boundedRefs().canvas.getObjects()
      .filter((o) => o.boardObjectId && !o.transientPreview && !o.transientScreenShare)
      .map((o) => ({ id: o.boardObjectId, left: o.left, top: o.top })).sort((a, b) => a.id.localeCompare(b.id)));
    const samePositions = (a, b) => a.length === b.length && a.every((o, i) => o.id === b[i].id
      && Math.abs(o.left - b[i].left) < 0.02 && Math.abs(o.top - b[i].top) < 0.02);
    const beforeMove = await positions(owner);
    const selectAll = async () => {
      await owner.getByRole('button', { name: 'Выделение', exact: true }).click();
      await owner.evaluate(async (url) => (await import(url)).selectTestObjects(window.__boundedRefs().canvas), new URL('scripts/bounded-verification-browser-fixture.js', home).href);
      await wait('group controls ready', () => owner.getByRole('button', { name: 'Удалить выбранное', exact: true }).isEnabled());
    };
    await selectAll();
    // The similarly named .selection-floating-proxy is the COLOR TOOLBAR,
    // not the selection's drag target. Drag the actual Fabric selection center.
    const center = await owner.evaluate(() => {
      const canvas = window.__boundedRefs().canvas;
      const point = canvas.getActiveObject().getCenterPoint();
      const v = canvas.viewportTransform; const rect = canvas.upperCanvasEl.getBoundingClientRect();
      return { x: rect.left + point.x * v[0] + point.y * v[2] + v[4],
        y: rect.top + point.x * v[1] + point.y * v[3] + v[5] };
    });
    // Also exercise an old missing target: its incoming transform must not block
    // the Canvas revision, and the bounded repair must restore the moved object.
    await student.evaluate(async ({ id, module }) => {
      const store = await import(module); const boardId = decodeURIComponent(location.pathname.match(/\/board\/([^/]+)/)[1]);
      store.applyReplicaVerificationRecords(boardId, [{ id, object: null, zIndex: -1 }], store.getReplicaRevision(boardId));
      const canvas = window.__boundedRefs().canvas;
      canvas.getObjects().filter((o) => o.boardObjectId === id).forEach((o) => canvas.remove(o));
    }, { id: first, module: replicaModule });
    await owner.mouse.move(center.x, center.y); await owner.mouse.down();
    await owner.mouse.move(center.x + 35, center.y + 25, { steps: 8 }); await owner.mouse.up();
    await owner.evaluate(() => window.__boundedRefs().canvas.discardActiveObject());
    await wait('group move reaches both devices', async () => {
      const moved = await positions(owner);
      return moved.length === 300 && moved.every((o, i) => Math.abs(o.left - beforeMove[i].left) > 5)
        && samePositions(moved, await positions(student));
    }, 90000);
    const afterMove = await positions(owner);
    await owner.getByRole('button', { name: /Отменить —/ }).click();
    await wait('one undo reverses all 300 moves', async () => samePositions(beforeMove, await positions(owner)) && samePositions(beforeMove, await positions(student)), 90000);
    await owner.getByRole('button', { name: /Вернуть —/ }).click();
    await wait('one redo reapplies all 300 moves', async () => samePositions(afterMove, await positions(owner)) && samePositions(afterMove, await positions(student)), 90000);
    await selectAll(); await owner.getByRole('button', { name: 'Удалить выбранное', exact: true }).click();
    await wait('300-object deletion converges', async () => await count(owner) === 0 && await count(student) === 0, 90000);
    await owner.getByRole('button', { name: /Отменить —/ }).click();
    await wait('one undo restores deleted group', async () => samePositions(afterMove, await positions(owner)) && samePositions(afterMove, await positions(student)), 90000);
    await owner.evaluate(() => window.__boundedRefs().canvas.discardActiveObject());
    await wait('group checks drain', () => student.evaluate(() => {
      const state = window.__boundedRefs().realtime.getVerificationStats();
      return !state.active && !state.pendingIds && !state.sweepPending;
    }), 90000);
    results.push({ name: '300-object real group move, one undo/redo, delete and restore', passed: true });
    await owner.reload(); await enter(owner, 'Synthetic owner');
    await wait('new board opt-in survives reload', () => owner.evaluate(() => window.__boundedRefs().realtime.getVerificationStats().enabled));
    results.push({ name: 'new-board capability survives reload', passed: true });
    await ownerContext.close(); await studentContext.close();
  }
  assert.deepEqual(failures, [], 'unexpected browser page errors');
  await writeFile(`bounded-browser-results/${engine}.json`, JSON.stringify({ passed: true, results }, null, 2));
  console.log(JSON.stringify({ passed: true, engine, results }, null, 2));
} catch (error) {
  await writeFile(`bounded-browser-results/${engine}-failure.json`, JSON.stringify({ message: error.message, stack: error.stack, results, failures }, null, 2));
  for (const [ci, context] of browser.contexts().entries()) for (const [pi, page] of context.pages().entries()) {
    await page.screenshot({ path: `bounded-browser-results/${engine}-${ci}-${pi}.png` }).catch(() => {});
    const info = await page.evaluate(() => ({ text: document.body?.innerText?.slice(0, 3000),
      stats: window.__boundedRefs?.()?.realtime?.getVerificationStats?.(), messages: window.__boundedMessages,
      objects: window.__boundedRefs?.()?.canvas?.getObjects?.()?.filter((o) => o.boardObjectId)
        .map((o) => ({ id: o.boardObjectId, left: o.left, top: o.top, group: o.group?.type, transient: o.transientPreview })),
      selection: window.__boundedRefs?.()?.canvas?.getActiveObject?.()?.type })).catch(() => null);
    await writeFile(`bounded-browser-results/${engine}-${ci}-${pi}.json`, JSON.stringify(info, null, 2));
  }
  throw error;
} finally { await browser.close(); }
