import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, webkit } from 'playwright-core';
import { deriveShareKey } from '../src/lib/ids.js';

const engine = process.env.VERIFICATION_BROWSER ?? 'chromium';
const home = process.env.VERIFICATION_TEST_URL ?? 'http://127.0.0.1:5173/alex/';
if (!['127.0.0.1', 'localhost'].includes(new URL(home).hostname)) throw new Error('Synthetic test boards only on local CI');
const out = 'student-offline-results'; await mkdir(out, { recursive: true });
const browser = engine === 'webkit' ? await webkit.launch({ headless: true })
  : await chromium.launch({ channel: 'chrome', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const results = [], errors = [];
const pause = ms => new Promise(r => setTimeout(r, ms));
async function wait(label, check, ms = 60000) {
  const end = Date.now() + ms; let last;
  while (Date.now() < end) { try { if (await check()) return; } catch(e) { last = e; } await pause(80); }
  throw new Error(`${label}: ${last?.message ?? 'timed out'}`);
}
async function instrument(context) {
  await context.addInitScript((relay) => {
    if (relay) {
      const Peer = window.RTCPeerConnection;
      window.RTCPeerConnection = class extends Peer {
        constructor(config) { super({ ...config, iceTransportPolicy: 'relay', iceServers: [{
          urls: 'turn:127.0.0.1:3478?transport=udp', username: 'bounded-ci', credential: 'bounded-ci-loopback-only-20260925',
        }] }); }
      };
    }
    window.__offlineCanvas = () => {
      let e = document.querySelector('canvas.upper-canvas');
      while (e) {
        const k = Object.keys(e).find(k => k.startsWith('__reactFiber$'));
        for (let f = k ? e[k] : null; f; f = f.return) {
          let h = f.memoizedState, n = 0;
          while (h && n++ < 900) { const v = h.memoizedState?.current;
            if (v?.lowerCanvasEl && v?.getObjects) return v; h = h.next; }
        }
        e = e.parentElement;
      }
      return null;
    };
  }, process.env.VERIFICATION_TEST_TURN === '1');
}
async function enter(page, name, ready = true) {
  await wait('enter board', async () => {
    if (await page.locator('canvas.upper-canvas').isVisible()) return true;
    const field = page.getByLabel('Ваше имя');
    if (await field.isVisible()) { await field.fill(name); await page.getByRole('button', { name: 'Войти на доску' }).click(); }
    return false;
  });
  if (ready) await wait('real runtime ready', () => page.evaluate(() => document.documentElement.dataset.alexDurableEditState === 'ready'));
}
async function state(page) {
  return page.evaluate(() => (window.__offlineCanvas()?.getObjects() ?? []).filter(o => o.boardObjectId && !o.transientPreview)
    .map(o => ({ id: o.boardObjectId, type: o.type, path: o.path, left: o.left, top: o.top, src: o.getSrc?.(), stroke: o.stroke })));
}
async function equal(a, b, count) {
  await wait(`matching ${count} records`, async () => { const [x,y] = await Promise.all([state(a), state(b)]);
    return x.length === count && JSON.stringify(x) === JSON.stringify(y); });
}
async function stroke(page, i) {
  await page.bringToFront(); await page.getByRole('button', { name: 'Карандаш', exact: true }).click();
  const r = await page.locator('canvas.upper-canvas').boundingBox();
  await page.mouse.move(r.x + 140 + i * 85, r.y + 230); await page.mouse.down();
  await page.mouse.move(r.x + 190 + i * 85, r.y + 260, { steps: 5 }); await page.mouse.up();
}
async function cache(page, boardId, key) {
  return page.evaluate(async ([id,key]) => {
    const { readStudentOfflineSnapshot } = await import('/alex/src/lib/studentOfflineCache.js');
    return readStudentOfflineSnapshot(id, key);
  }, [boardId, key]);
}
async function assertBrowsing(page, touch) {
  await wait('read-only navigation fence', () => page.evaluate(() =>
    document.querySelector('canvas.upper-canvas')?.dataset.readonlyNavigation === 'true'));
  const original = await state(page);
  const before = await page.evaluate(() => window.__offlineCanvas().viewportTransform.slice());
  await page.mouse.move(400, 390); await page.mouse.down(); await page.mouse.move(550, 460, { steps: 8 }); await page.mouse.up();
  const after = await page.evaluate(() => window.__offlineCanvas().viewportTransform.slice());
  assert.ok(before[4] !== after[4] || before[5] !== after[5], 'ordinary left-button dragging pans the read-only board');
  const oldZoom = after[0]; await page.mouse.wheel(0, -40);
  await wait('read-only wheel zoom', () => page.evaluate(z => window.__offlineCanvas().getZoom() !== z, oldZoom));
  await page.keyboard.press('ArrowRight'); await page.keyboard.press('Delete'); await page.keyboard.press('Control+z');
  await page.evaluate(() => {
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: { files: [], items: [], getData: () => 'MUST NOT INSERT' } });
    document.dispatchEvent(event);
  });
  assert.deepEqual(await state(page), original, 'navigation, delete, undo and paste cannot mutate offline notes');
  assert.equal(await page.getByRole('button', { name: 'Карандаш', exact: true }).isDisabled(), true);
  assert.equal(await page.evaluate(() => window.__offlineCanvas().isDrawingMode), false);
  if (touch && engine === 'chromium') {
    const cd = await page.context().newCDPSession(page);
    const start = await page.evaluate(() => window.__offlineCanvas().viewportTransform.slice());
    await cd.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 320, y: 500 }] });
    for (let x = 340; x <= 480; x += 20) await cd.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: 550 }] });
    await cd.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    const end = await page.evaluate(() => window.__offlineCanvas().viewportTransform.slice());
    assert.ok(start[4] !== end[4] || start[5] !== end[5], 'one finger pans while offline');
    const z = end[0];
    await cd.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 300, y: 500 }, { x: 400, y: 500 }] });
    for (let i = 1; i <= 5; i++) { await cd.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 300-i*10, y: 500 }, { x: 400+i*10, y: 500 }] }); await pause(40); }
    await cd.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    assert.notEqual(await page.evaluate(() => window.__offlineCanvas().getZoom()), z, 'pinch zoom works offline');
    assert.deepEqual(await state(page), original);
  }
}
try {
  for (const touch of [false, true]) {
    const ownerContext = await browser.newContext({ viewport: { width: 1280, height: 850 } });
    const studentContext = await browser.newContext({ viewport: { width: touch ? 820 : 1100, height: touch ? 1180 : 850 }, hasTouch: touch });
    await instrument(ownerContext); await instrument(studentContext);
    let owner = await ownerContext.newPage(); const student = await studentContext.newPage();
    let stage = 'setup';
    const observe = (name, page) => page.on('pageerror', e => errors.push({ name, touch, stage, message:e.message, stack:e.stack, at:Date.now() }));
    observe('owner', owner); observe('student', student);
    try {
      await owner.goto(home); await owner.getByLabel('Название доски').fill(`Offline review ${engine} ${touch} ${Date.now()}`);
      await owner.getByLabel('Ученик').fill('Synthetic offline review');
      await owner.getByRole('button', { name: 'Создать доску' }).click(); await enter(owner, 'Owner');
      const ownerUrl = owner.url(); const guestUrl = new URL(ownerUrl);
      const roomKey = await deriveShareKey(guestUrl.searchParams.get('key')); guestUrl.searchParams.set('key', roomKey);
      const boardId = decodeURIComponent(guestUrl.pathname.split('/board/')[1]);
      await stroke(owner, 0);
      await student.goto(guestUrl.href); await enter(student, 'Student'); await equal(owner, student, 1);
      await stroke(student, 1); await equal(owner, student, 2);
      const data = await owner.evaluate(() => { const c=document.createElement('canvas'); c.width=40; c.height=30;
        c.getContext('2d').fillRect(0,0,40,30); return c.toDataURL('image/png').split(',')[1]; });
      await owner.locator('.image-file-input').setInputFiles({ name: 'notes.png', mimeType: 'image/png', buffer: Buffer.from(data, 'base64') });
      await equal(owner, student, 3);
      await wait('confirmed archive is durable', async () => (await cache(student, boardId, roomKey))?.snapshot?.canvas?.objects?.length === 3);
      const expected = await state(student);
      stage = 'owner-close'; await owner.close();
      await wait('owner absence revokes editing', () => student.evaluate(() => document.documentElement.dataset.alexDurableEditState !== 'ready'));
      await assertBrowsing(student, touch);
      if (!touch) {
        // A persisted archive is not a causal authority. Emulate an owner restored
        // from an older backup and ensure the real baseline can replace this head.
        await student.evaluate(async ([id,key]) => {
          const api = await import('/alex/src/lib/studentOfflineCache.js');
          const data = await api.readStudentOfflineSnapshot(id,key);
          await api.studentOfflineStorage.replace(await api.studentOfflineScope(id,key),
            { snapshot:data.snapshot, revision:data.revision+1000, savedAt:Date.now() });
        }, [boardId,roomKey]);
      }
      stage = 'offline-reload'; await student.reload(); await enter(student, 'Student', false);
      await wait('cached notes survive page reload', async () => JSON.stringify(await state(student)) === JSON.stringify(expected));
      await assertBrowsing(student, touch);
      assert.equal(await student.evaluate(() => window.__offlineCanvas().getObjects().filter(o=>o.type==='image').every(o=>o.getElement()?.complete && o.getElement()?.naturalWidth > 0)), true);
      await student.screenshot({ path: `${out}/${engine}-${touch ? 'touch' : 'desktop'}-offline.png` });
      // Fresh device: there is no authority and no local cache. Do not invent a copy.
      const freshContext = await browser.newContext(); await instrument(freshContext); const fresh=await freshContext.newPage();
      await fresh.goto(guestUrl.href); await enter(fresh, 'New device', false); await pause(300);
      assert.equal((await state(fresh)).length, 0); assert.equal(await fresh.getByRole('button', { name: 'Карандаш', exact: true }).isDisabled(), true);
      await freshContext.close();
      // Real reconnect: the owner's stored data is still the only writable authority.
      owner = await ownerContext.newPage(); observe('owner-reconnected', owner); stage = 'reconnect';
      await owner.goto(ownerUrl); await enter(owner, 'Owner'); await enter(student, 'Student'); await equal(owner, student, 3);
      await stroke(owner, 2); await equal(owner, student, 4);
      await stroke(student, 3); await equal(owner, student, 5);
      await wait('updated archive', async () => (await cache(student, boardId, roomKey))?.snapshot?.canvas?.objects?.length === 5);
      const wrong = new URL(guestUrl); wrong.searchParams.set('key', 'wrong-read-key');
      assert.equal(await cache(student, boardId, 'wrong-read-key'), null);
      results.push({ engine, profile: touch ? 'touch' : 'desktop', cachedRecords: 3, ownerClosed: true, reload: true,
        pan: true, zoom: true, nativeTouchPanAndPinch: touch && engine === 'chromium', imageDecodedOffline: true,
        lowerOwnerBaselineAccepted: !touch, offlineMutationsBlocked: true, freshDeviceEmpty: true, wrongKeyDenied: true, realReconnectEditing: true });
      console.log(JSON.stringify(results.at(-1)));
    } catch(error) {
      for (const [name, page] of [['owner',owner],['student',student]]) if (!page.isClosed()) {
        await page.screenshot({ path: `${out}/${engine}-${touch}-${name}-failure.png` }).catch(()=>{});
        await writeFile(`${out}/${engine}-${touch}-${name}-failure.json`, JSON.stringify({error:String(error),errors,state:await state(page).catch(()=>null), details:await page.evaluate(()=>({data:{...document.documentElement.dataset},text:document.body.innerText})).catch(()=>null)},null,2));
      }
      throw error;
    } finally { stage = 'context-teardown'; await Promise.allSettled([ownerContext.close(),studentContext.close()]); }
  }
  assert.deepEqual(errors, [], 'no uncaught application errors');
} finally { await writeFile(`${out}/${engine}.json`, JSON.stringify({ results, errors }, null, 2)); await browser.close(); }
