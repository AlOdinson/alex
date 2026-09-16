import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium, webkit } from 'playwright-core';
import { deriveShareKey } from '../src/lib/ids.js';
const BASE = process.env.BROWSER_AUTHORITY_PREVIEW_URL ?? 'http://127.0.0.1:4173/alex/';
const ENGINE = process.env.CLOUD_BROWSER ?? 'chromium';
const EDGE = process.env.CLOUD_EDGE_SLUG ?? 'cloudflare-realtime';
const out = 'cloud-browser-results'; fs.mkdirSync(out, { recursive: true });
const browser = ENGINE === 'webkit' ? await webkit.launch({ headless: true })
  : await chromium.launch({ channel: 'chrome', headless: true, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function wait(label, predicate, timeout = 60000) {
  const deadline = Date.now() + timeout; let last;
  while (Date.now() < deadline) {
    try { if (await predicate()) return; } catch (error) { last = error; }
    await pause(150);
  }
  throw new Error(`${label}: ${last?.message ?? 'timed out'}`);
}
const contexts = [], pages = [], events = [], results = [];
async function newPage(profile) {
  const context = await browser.newContext({ ...profile, deviceScaleFactor: 1 }); contexts.push(context);
  const page = await context.newPage(); pages.push(page);
  await page.addInitScript((relay) => {
    window.__cloudState = null; window.__cloudPeers = []; window.__captures = 0;
    window.addEventListener('alex-screen-share-cloud-state', (e) => { window.__cloudState = e.detail; });
    const Peer = window.RTCPeerConnection;
    window.RTCPeerConnection = class extends Peer {
      constructor(config) {
        // Relay only local test peers on WebKit. Cloudflare SFU keeps its actual ICE config.
        const cloud = config?.bundlePolicy === 'max-bundle';
        super(!cloud && relay ? { ...config, iceServers: [relay], iceTransportPolicy: 'relay' } : config);
        if (cloud) window.__cloudPeers.push(this);
      }
    };
    Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', { configurable: true, value: async () => {
      window.__captures++;
      const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
      const ctx = canvas.getContext('2d'); let tick = 0; window.__captureGreen = false;
      const draw = () => {
        ctx.fillStyle = window.__captureGreen ? 'rgb(30,190,80)' : 'rgb(215,50,30)'; ctx.fillRect(0,0,640,360);
        ctx.fillStyle = '#fff'; ctx.fillRect(500 + ((tick++) % 80), 100, 10, 40);
      };
      draw(); const timer = setInterval(draw, 100); const stream = canvas.captureStream(10);
      stream.getVideoTracks()[0].addEventListener('ended', () => clearInterval(timer));
      return stream;
    } });
    window.__boardCanvas = () => {
      let element = document.querySelector('canvas.upper-canvas');
      while (element) {
        const key = Object.keys(element).find((name) => name.startsWith('__reactFiber$'));
        let fiber = key ? element[key] : null;
        while (fiber) {
          let hook = fiber.memoizedState, steps = 0;
          while (hook && steps++ < 900) {
            const value = hook.memoizedState?.current;
            if (value?.lowerCanvasEl && value?.getObjects) return value;
            hook = hook.next;
          }
          fiber = fiber.return;
        }
        element = element.parentElement;
      }
    };
  }, ENGINE === 'webkit' && process.env.CLOUD_TURN_PASSWORD ? {
    urls: 'turn:127.0.0.1:3478?transport=udp', username: 'cloud-ci', credential: process.env.CLOUD_TURN_PASSWORD,
  } : null);
  if (EDGE !== 'cloudflare-realtime') await page.route('**/functions/v1/cloudflare-realtime', (route) =>
    route.continue({ url: route.request().url().replace(/cloudflare-realtime$/, EDGE) }));
  page.on('response', (response) => {
    if (response.url().endsWith(`/functions/v1/${EDGE}`)) {
      let operation; try { operation = response.request().postDataJSON()?.operation; } catch {}
      events.push({ page: pages.indexOf(page), operation, status: response.status() });
      console.log('CLOUD_API', operation, response.status());
    }
  });
  page.on('console', (message) => { if (message.type() === 'error') console.log('BROWSER_ERROR', message.text().slice(0,300)); });
  return page;
}
async function enter(page, name) {
  await wait('board entry', async () => {
    if (await page.locator('canvas.upper-canvas').isVisible()) return true;
    const input = page.getByLabel('Ваше имя');
    if (await input.isVisible()) { await input.fill(name); await page.getByRole('button', { name: 'Войти на доску' }).click(); }
    return false;
  });
  await wait('board ready', () => page.evaluate(() => document.documentElement.dataset.alexDurableEditState === 'ready'));
}
async function videoReady(page, { green = false, requireCloud = true } = {}) {
  return page.evaluate(async ({ green, requireCloud }) => {
    if (requireCloud && window.__cloudState?.transport !== 'cloud') return false;
    const object = window.__boardCanvas()?.getObjects().find((o) => o.transientScreenShare);
    const frame = object?.getElement?.();
    if (!frame?.getContext) return false;
    const [r,g,b] = frame.getContext('2d').getImageData(40,40,1,1).data;
    const correct = green ? g > 140 && r < 85 && b > 30 : r > 160 && g < 100 && b < 90;
    if (!correct || !requireCloud) return correct;
    for (const peer of window.__cloudPeers) {
      if (peer.connectionState !== 'connected') continue;
      const reports = [...(await peer.getStats()).values()];
      if (reports.some((row) => row.type === 'inbound-rtp' && row.bytesReceived > 0
        && (row.kind === 'video' || row.mediaType === 'video'))) return true;
    }
    return false;
  }, { green, requireCloud });
}
try {
  const owner = await newPage({ viewport: { width:1280,height:800 } });
  const editor = await newPage({ viewport: { width:1280,height:800 } });
  const phone = await newPage({ viewport: { width:390,height:844 }, isMobile:true, hasTouch:true });
  const tablet = await newPage({ viewport: { width:820,height:1180 }, isMobile:true, hasTouch:true });
  await owner.goto(BASE);
  await owner.getByLabel('Название доски').fill(`Cloud live regression ${Date.now()}`);
  await owner.getByLabel('Ученик').fill('Synthetic Cloud test');
  await owner.getByRole('button', { name: 'Создать доску' }).click(); await enter(owner,'Cloud teacher');
  const guest = new URL(owner.url()); guest.searchParams.set('key', await deriveShareKey(guest.searchParams.get('key')));
  for (const page of [editor,phone,tablet]) { await page.goto(guest.href); await enter(page,'Cloud student'); }
  for (const actor of [owner,editor]) {
    const viewers = pages.filter((p) => p !== actor);
    console.log('HOST', actor === owner ? 'teacher' : 'student');
    await actor.locator('.desktop-screen-share button').click();
    await wait('screen session reaches peers', async () => {
      const states = await Promise.all(pages.map((p) => p.evaluate(() => window.__cloudState)));
      return states.every((s) => s?.sessionId && s.sessionId === states[0].sessionId);
    });
    const toggle = actor.locator('.screen-share-cloud-toggle'); await toggle.click();
    await wait('Cloud toggle on', () => toggle.getAttribute('data-cloud-phase').then((p) => p === 'on'));
    await wait('actual SFU video on all viewers', async () => (await Promise.all(viewers.map((p) => videoReady(p)))).every(Boolean));
    await actor.evaluate(() => { window.__captureGreen = true; });
    await wait('new live frame after Cloud switch', async () => (await Promise.all(viewers.map((p) => videoReady(p,{green:true})))).every(Boolean));
    await toggle.click(); await wait('Cloud off', () => toggle.getAttribute('data-cloud-phase').then((p) => p === 'off'));
    await wait('warm direct video resumes', async () => (await Promise.all(viewers.map((p) => videoReady(p,{green:true,requireCloud:false})))).every(Boolean));
    await toggle.click(); await wait('Cloud enabled again', () => toggle.getAttribute('data-cloud-phase').then((p) => p === 'on'));
    await wait('resumed SFU video', async () => (await Promise.all(viewers.map((p) => videoReady(p,{green:true})))).every(Boolean));
    assert.equal(await actor.evaluate(() => window.__captures),1,'Cloud switching must reuse the original capture');
    results.push({ engine:ENGINE, host:actor === owner ? 'teacher' : 'student', cloudVideo:true, liveFrame:true, offOn:true, captureRequests:1 });
    await actor.locator('.desktop-screen-share button').click();
    await wait('stopped screen removed', async () => (await Promise.all(pages.map((p) => p.evaluate(() =>
      !window.__boardCanvas()?.getObjects().some((o) => o.transientScreenShare))))).every(Boolean));
  }
  assert.ok(events.some((e) => e.operation === 'authorize-browser-publisher' && e.status === 200));
  assert.ok(events.some((e) => e.operation === 'publish-track' && e.status === 200));
  assert.ok(events.some((e) => e.operation === 'subscribe-track' && e.status === 200));
  assert.ok(!events.some((e) => e.status >= 400), JSON.stringify(events.filter((e) => e.status >= 400)));
  console.log(JSON.stringify(results));
} catch (error) {
  for (const [index,page] of pages.entries()) {
    await page.screenshot({ path:`${out}/${ENGINE}-${index}.png` }).catch(() => {});
    fs.writeFileSync(`${out}/${ENGINE}-${index}.json`, JSON.stringify(await page.evaluate(() => ({
      state:window.__cloudState, text:document.body.innerText, editState:document.documentElement.dataset.alexDurableEditState,
      peers:window.__cloudPeers.map((p) => ({ state:p.connectionState, ice:p.iceConnectionState })),
    })).catch(() => null),null,2));
  }
  throw error;
} finally {
  fs.writeFileSync(`${out}/${ENGINE}-results.json`,JSON.stringify({results,events},null,2));
  await Promise.allSettled(contexts.map((c) => c.close())); await browser.close();
}
