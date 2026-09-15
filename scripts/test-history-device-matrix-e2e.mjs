import { deriveShareKey } from '../src/lib/ids.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium, webkit } from 'playwright-core';

const URL = process.env.BROWSER_AUTHORITY_PREVIEW_URL ?? 'http://127.0.0.1:4173/alex/';
const ENGINE = process.env.HISTORY_BROWSER ?? 'chromium';
const profiles = [
  { name: 'computer', viewport: { width: 1280, height: 800 }, hasTouch: false, isMobile: false },
  { name: 'phone', viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true },
  { name: 'tablet', viewport: { width: 820, height: 1180 }, hasTouch: true, isMobile: true },
];
const browser = await (ENGINE === 'webkit' ? webkit.launch({ headless: true }) : chromium.launch({ channel: 'chrome', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] }));
fs.mkdirSync('history-e2e-results', { recursive: true });
const results = [];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function wait(label, check, timeout = 45000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try { const value = await check(); if (value) return value; } catch (error) { last = error; }
    await delay(80);
  }
  throw new Error(`${label}${last ? ': ' + last.message : ': timed out'}`);
}
async function attach(page) {
  await page.addInitScript((relay) => {
    // Read-only inspection of the actual Fabric instance held by React. This is
    // injected by the test, not shipped as an application debug API.
    window.__historyCanvas = () => {
      let element = document.querySelector('canvas.upper-canvas');
      while (element) {
        const key = Object.keys(element).find((value) => value.startsWith('__reactFiber$'));
        let fiber = key ? element[key] : null;
        while (fiber) {
          let hook = fiber.memoizedState;
          let count = 0;
          while (hook && count++ < 800) {
            const current = hook.memoizedState?.current;
            if (current && typeof current.getObjects === 'function' && current.lowerCanvasEl) return current;
            hook = hook.next;
          }
          fiber = fiber.return;
        }
        element = element.parentElement;
      }
      throw new Error('Fabric instance not found');
    };
    window.__historyPeerStates = [];
    const NativePeer = window.RTCPeerConnection;
    if (NativePeer) window.RTCPeerConnection = class extends NativePeer {
      constructor(...args) {
        super(relay ? { ...args[0], iceServers: [relay], iceTransportPolicy: 'relay' } : args[0]);
        this.__historyCandidates = [];
        this.addEventListener('icecandidate', (event) => { if (event.candidate) this.__historyCandidates.push(event.candidate.type); });
        window.__historyPeerStates.push(this);
      }
    };
    // Reproducible acknowledgement latency makes queued touch/keyboard commands
    // overlap a real network wait, while retaining normal durable commit delivery.
    const send = RTCDataChannel.prototype.send;
    RTCDataChannel.prototype.send = function (data) {
      let ack = false;
      try { ack = typeof data === 'string' && JSON.parse(data).type === 'ack'; } catch {}
      if (ack) {
        const channel = this;
        setTimeout(() => { if (channel.readyState === 'open') send.call(channel, data); }, 120);
        return;
      }
      return send.call(this, data);
    };
  }, ENGINE === 'webkit' && process.env.HISTORY_TURN_PASSWORD ? {
    urls: 'turn:127.0.0.1:3478?transport=udp', username: 'history', credential: process.env.HISTORY_TURN_PASSWORD,
  } : null);
}
async function enter(page, name) {
  await wait('canvas or participant name', async () => {
    if (await page.locator('canvas.upper-canvas').isVisible()) return true;
    const input = page.getByLabel('Ваше имя');
    if (await input.isVisible()) {
      await input.fill(name);
      await page.getByRole('button', { name: 'Войти на доску' }).click();
    }
    return false;
  });
  await wait('durable editing ready', () => page.evaluate(() => document.documentElement.dataset.alexDurableEditState === 'ready'));
  await wait('real Fabric canvas', () => page.evaluate(() => Boolean(window.__historyCanvas())));
}
async function state(page) {
  return page.evaluate(() => {
    const clean = (value) => {
      if (typeof value === 'number') return Math.round(value * 1e6) / 1e6;
      if (Array.isArray(value)) return value.map(clean);
      if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort()
        .filter((key) => !['updatedAt', 'updatedBy', 'version', 'createdBy'].includes(key))
        .filter((key) => !(['transientPreview', 'transientLiveDraw', 'transientAwaitingCommit'].includes(key) && value[key] === false))
        .map((key) => [key, clean(value[key])]));
      return value;
    };
    return window.__historyCanvas().getObjects()
      .filter((object) => object.boardObjectId && !object.transientPreview && !object.transientScreenShare && !object.transientSelectionProxy)
      .map((object) => clean(object.toObject(['boardObjectId', 'objectKind'])));
  });
}
async function revision(owner) {
  return owner.evaluate(() => new Promise((resolve, reject) => {
    const id = decodeURIComponent(location.pathname.match(/\/board\/([^/]+)/)[1]);
    const request = indexedDB.open('alex-board-authority');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const get = db.transaction('boards').objectStore('boards').get(id);
      get.onerror = () => { db.close(); reject(get.error); };
      get.onsuccess = () => { db.close(); resolve(get.result.revision); };
    };
  }));
}
async function converge(pages, expected, label) {
  return wait(label, async () => {
    const states = await Promise.all(pages.map(state));
    const serialized = states.map((value) => JSON.stringify(value));
    if (!serialized.every((value) => value === serialized[0])) return false;
    if (typeof expected === 'number' && states[0].length !== expected) return false;
    if (Array.isArray(expected) && serialized[0] !== JSON.stringify(expected)) return false;
    return states[0];
  });
}
async function button(page, name, profile) {
  await page.bringToFront();
  const locator = page.getByRole('button', { name, exact: typeof name === 'string' });
  if (profile.hasTouch) await locator.tap(); else await locator.click();
}
async function stroke(page, profile, index = 0) {
  await button(page, 'Карандаш', profile);
  await page.evaluate(() => {
    window.__historyInput = [];
    for (const type of ['pointerdown','pointermove','pointerup','mousedown','mouseup']) document.addEventListener(type, (event) => {
      if (window.__historyInput.length < 60) window.__historyInput.push({type, pointerType:event.pointerType, target:event.target?.className, trusted:event.isTrusted, drawing:window.__historyCanvas().isDrawingMode});
    }, {capture:true, once:true});
  });
  await delay(50);
  const box = await page.locator('canvas.upper-canvas').boundingBox();
  const a = { x: box.x + 90, y: box.y + 180 + index * 23 };
  const b = { x: a.x + 120, y: a.y + 36 };
  if (!profile.hasTouch) {
    await page.mouse.move(a.x, a.y); await page.mouse.down();
    for (let i=1;i<=8;i++) { await page.mouse.move(a.x+(b.x-a.x)*i/8, a.y+(b.y-a.y)*i/8); await delay(16); }
    await page.mouse.up();
  } else if (ENGINE === 'chromium') {
    const cdp = await page.context().newCDPSession(page);
    if (profile.name === 'tablet') {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: a.x, y: a.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'pen', force: 0.5 });
      for (let i = 1; i <= 8; i++) await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: a.x + (b.x-a.x)*i/8, y: a.y + (b.y-a.y)*i/8, buttons: 1, pointerType: 'pen', force: 0.5 });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'pen' });
    } else {
      const touch = (x, y) => [{ x, y, radiusX: 3, radiusY: 3, force: 0.8, id: 1 }];
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: touch(a.x, a.y) });
      for (let i = 1; i <= 8; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: touch(a.x+(b.x-a.x)*i/8, a.y+(b.y-a.y)*i/8) });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    }
    await cdp.detach();
  } else {
    // Scripted finger TouchEvents exercise WebKit's actual free-drawing path
    // for both mobile profiles. Chromium covers native CDP pen input separately.
    // Pointer-only and stylus-only injection are not faithful Apple Pencil
    // emulation here; those probes did not produce a stroke and are NOT PASS.
    await page.locator('canvas.upper-canvas').evaluate((canvas, { a, b }) => {
      const send = (type, x, y) => {
        const touch = { identifier: 71, target: canvas, clientX:x, clientY:y,
          pageX:x+scrollX, pageY:y+scrollY, screenX:x, screenY:y,
          radiusX:1, radiusY:1, rotationAngle:0, force:0.5, touchType:'direct' };
        const active = type === 'touchend' ? [] : [touch];
        const event = new Event(type, { bubbles:true, cancelable:true });
        Object.defineProperties(event, {
          touches:{value:active}, targetTouches:{value:active}, changedTouches:{value:[touch]},
        });
        canvas.dispatchEvent(event);
      };
      send('touchstart',a.x,a.y);
      for(let i=1;i<=8;i++) send('touchmove',a.x+(b.x-a.x)*i/8,a.y+(b.y-a.y)*i/8);
      send('touchend',b.x,b.y);
    }, { a, b });
  }
}
async function selectLast(page, profile) {
  await button(page, 'Выделение', profile);
  await page.evaluate(() => {
    const canvas = window.__historyCanvas();
    canvas.setActiveObject(canvas.getObjects().filter((object) => object.boardObjectId).at(-1));
    canvas.requestRenderAll();
  });
}
async function run(ownerIndex) {
  const contexts = await Promise.all(profiles.map(({ name, ...options }) => browser.newContext({ ...options, deviceScaleFactor: 1 })));
  const pages = await Promise.all(contexts.map((context) => context.newPage()));
  const errors = [];
  for (const [index, page] of pages.entries()) {
    page.on('pageerror', (error) => errors.push(`${profiles[index].name}: ${error.message}`));
    page.on('console', (message) => { if (['warning', 'error'].includes(message.type())) console.log('BROWSER', profiles[index].name, message.text()); });
    await attach(page);
  }
  const owner = pages[ownerIndex];
  try {
    await owner.goto(URL, { waitUntil: 'domcontentloaded' });
    await owner.getByLabel('Название доски').fill(`History matrix ${ENGINE} ${profiles[ownerIndex].name} ${Date.now()}`);
    await owner.getByLabel('Ученик').fill('Synthetic regression only');
    await owner.getByRole('button', { name: 'Создать доску' }).click();
    await enter(owner, `Owner ${profiles[ownerIndex].name}`);
    // Use the application's real share-key derivation for the synthetic board;
    // menu animation/clipboard behavior is not part of the history assertion.
    const guestURL = new globalThis.URL(owner.url());
    guestURL.searchParams.set('key', await deriveShareKey(guestURL.searchParams.get('key')));
    const share = guestURL.href;
    for (const [index, page] of pages.entries()) if (index !== ownerIndex) {
      await page.goto(share, { waitUntil: 'domcontentloaded' });
      await enter(page, `Student ${profiles[index].name}`);
    }
    await converge(pages, 0, 'initial empty board');
    let checks = 0;
    for (const [index, page] of pages.entries()) {
      const profile = profiles[index];
      const snapshots = [await state(owner)];
      let head = await revision(owner);
      await stroke(page, profile);
      await wait('stroke durable', async () => await revision(owner) > head);
      snapshots.push(await converge(pages, 1, `${profile.name} stroke`)); checks++;
      await selectLast(page, profile);
      const input = page.locator('.selection-floating-proxy input[data-selection-proxy-input="color"]');
      await input.waitFor({ state: 'visible' });
      await wait('selection color control enabled', () => input.isEnabled());
      head = await revision(owner);
      await input.evaluate((element) => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(element, '#ef233c');
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await wait('color durable', async () => await revision(owner) > head);
      const colored = await converge(pages, 1, `${profile.name} color`);
      assert.notDeepEqual(colored, snapshots.at(-1)); snapshots.push(colored); checks++;
      head = await revision(owner);
      await button(page, 'Повернуть вправо на 90°', profile);
      await wait('rotation durable', async () => await revision(owner) > head);
      const rotated = await converge(pages, 1, `${profile.name} rotation`);
      assert.notDeepEqual(rotated, snapshots.at(-1)); snapshots.push(rotated); checks++;
      head = await revision(owner);
      await button(page, 'Удалить выбранное', profile);
      await wait('delete durable', async () => await revision(owner) > head);
      snapshots.push(await converge(pages, 0, `${profile.name} delete`)); checks++;
      for (let cycle = 0; cycle < 3; cycle++) {
        for (let step = 3; step >= 0; step--) {
          await button(page, /Отменить —/, profile);
          await converge(pages, snapshots[step], `${profile.name} undo ${cycle}/${step}`); checks++;
        }
        for (let step = 1; step <= 4; step++) {
          await button(page, /Вернуть —/, profile);
          await converge(pages, snapshots[step], `${profile.name} redo ${cycle}/${step}`); checks++;
        }
      }
      head = await revision(owner);
      for (let i = 0; i < 6; i++) await stroke(page, profile, i);
      await wait('six strokes durable', async () => await revision(owner) >= head + 6);
      const six = await converge(pages, 6, `${profile.name} six strokes`);
      for (let i = 0; i < 6; i++) await button(page, /Отменить —/, profile);
      await converge(pages, 0, `${profile.name} rapid undo`); checks++;
      for (let i = 0; i < 6; i++) await button(page, /Вернуть —/, profile);
      await converge(pages, six, `${profile.name} rapid redo`); checks++;
      for (let i = 0; i < 6; i++) await button(page, /Отменить —/, profile);
      await converge(pages, 0, `${profile.name} final empty`);
      console.log(JSON.stringify({ engine: ENGINE, owner: profiles[ownerIndex].name, actor: profile.name, checks, passed: true }));
    }
    assert.deepEqual(errors, [], 'unexpected browser runtime errors');
    results.push({ transport: process.env.HISTORY_TURN_PASSWORD ? 'ci-loopback-turn' : 'production-default-ice', engine: ENGINE, owner: profiles[ownerIndex].name, participants: profiles.map((p) => p.name), checks, passed: true });
  } catch (error) {
    fs.writeFileSync(`history-e2e-results/${ENGINE}-failure.json`, JSON.stringify({ ownerIndex, message: error.message, stack: error.stack, errors }, null, 2));
    for (const [index, page] of pages.entries()) {
      await page.screenshot({ path: `history-e2e-results/${ENGINE}-${ownerIndex}-${index}.png`, fullPage: true }).catch(() => {});
      const diagnostic = await page.evaluate(() => ({ state: window.__historyCanvas ? window.__historyCanvas().getObjects().map((o) => o.toObject(['boardObjectId'])) : null, dataset: { ...document.documentElement.dataset }, inputEvents: window.__historyInput, drawing:window.__historyCanvas().isDrawingMode, pointerEvents:window.__historyCanvas().enablePointerEvents, text: document.body.innerText, peers: (window.__historyPeerStates ?? []).map((p) => ({ state: p.connectionState, ice: p.iceConnectionState, gathering: p.iceGatheringState, signaling: p.signalingState, local: p.localDescription?.type, remote: p.remoteDescription?.type, candidates: p.__historyCandidates })) })).catch((e) => ({ error: e.message }));
      fs.writeFileSync(`history-e2e-results/${ENGINE}-${ownerIndex}-${index}.json`, JSON.stringify(diagnostic, null, 2));
    }
    throw error;
  } finally {
    fs.writeFileSync(`history-e2e-results/${ENGINE}-results.json`, JSON.stringify(results, null, 2));
    await Promise.allSettled(contexts.map((context) => context.close()));
  }
}
try { for (let i = 0; i < profiles.length; i++) await run(i); }
finally { await browser.close(); }
