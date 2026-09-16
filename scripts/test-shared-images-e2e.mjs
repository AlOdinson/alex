import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium, webkit } from 'playwright-core';
import { deriveShareKey } from '../src/lib/ids.js';

const BASE = process.env.BROWSER_AUTHORITY_PREVIEW_URL ?? 'http://127.0.0.1:4173/alex/';
const ENGINE = process.env.HISTORY_BROWSER ?? 'chromium';
const profiles = [
  { name: 'computer', viewport: { width: 1280, height: 800 }, hasTouch: false, isMobile: false },
  { name: 'phone', viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true },
  { name: 'tablet', viewport: { width: 820, height: 1180 }, hasTouch: true, isMobile: true },
];
const out = 'shared-images-results';
fs.mkdirSync(out, { recursive: true });
const browser = ENGINE === 'webkit' ? await webkit.launch({ headless: true })
  : await chromium.launch({ channel: 'chrome', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function wait(label, check, timeout = 60000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try { if (await check()) return; } catch (error) { last = error; }
    await pause(100);
  }
  throw new Error(`${label}: ${last?.message ?? 'timed out'}`);
}
async function instrument(page) {
  await page.addInitScript((relay) => {
    window.__imageCanvas = () => {
      let element = document.querySelector('canvas.upper-canvas');
      while (element) {
        const key = Object.keys(element).find((value) => value.startsWith('__reactFiber$'));
        let fiber = key ? element[key] : null;
        while (fiber) {
          let hook = fiber.memoizedState, count = 0;
          while (hook && count++ < 800) {
            const current = hook.memoizedState?.current;
            if (current?.lowerCanvasEl && typeof current.getObjects === 'function') return current;
            hook = hook.next;
          }
          fiber = fiber.return;
        }
        element = element.parentElement;
      }
      return null;
    };
    if (relay) {
      const Peer = window.RTCPeerConnection;
      window.RTCPeerConnection = class extends Peer {
        constructor(config) { super({ ...config, iceServers: [relay], iceTransportPolicy: 'relay' }); }
      };
    }
    window.__imageLoads = [];
    const src = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
    Object.defineProperty(HTMLImageElement.prototype, 'src', {
      ...src, set(value) {
        const entry = { prefix: String(value).slice(0, 48), chars: String(value).length, state: 'loading' };
        window.__imageLoads.push(entry);
        // Test-only failure injection: exactly one receiver gets neither load nor
        // error for its first image. Its later retry must recover actual pixels.
        if (window.__imageBlockOnce && String(value).startsWith('data:image/')) {
          window.__imageBlockOnce = false; entry.state = 'blocked'; return;
        }
        this.addEventListener('load', () => { entry.state = 'loaded'; entry.width = this.naturalWidth; }, { once: true });
        this.addEventListener('error', () => { entry.state = 'error'; }, { once: true });
        return src.set.call(this, value);
      },
    });
  }, ENGINE === 'webkit' && process.env.HISTORY_TURN_PASSWORD ? {
    urls: 'turn:127.0.0.1:3478?transport=udp', username: 'history', credential: process.env.HISTORY_TURN_PASSWORD,
  } : null);
}
async function enter(page, name) {
  await wait('enter board', async () => {
    if (await page.locator('canvas.upper-canvas').isVisible()) return true;
    const input = page.getByLabel('Ваше имя');
    if (await input.isVisible()) { await input.fill(name); await page.getByRole('button', { name: 'Войти на доску' }).click(); }
    return false;
  });
  await wait('editing ready', () => page.evaluate(() => document.documentElement.dataset.alexDurableEditState === 'ready'));
}
async function state(page) {
  return page.evaluate(async () => Promise.all((window.__imageCanvas()?.getObjects() ?? [])
    .filter((o) => o.boardObjectId && !o.transientScreenShare)
    .map(async (o) => {
      const element = o.getElement?.();
      const src = o.getSrc?.() ?? o.pendingImageSerialized?.src ?? '';
      const digest = src ? Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(src))))
        .map((byte) => byte.toString(16).padStart(2, '0')).join('') : null;
      const round = (value) => Math.round(Number(value) * 1e6) / 1e6;
      return { id: o.boardObjectId, type: o.type, kind: o.objectKind, pending: Boolean(o.pendingImage),
        transient: Boolean(o.transientPreview), loaded: Boolean(element?.complete && element?.naturalWidth),
        width: element?.naturalWidth ?? 0, height: element?.naturalHeight ?? 0,
        srcChars: src.length, digest, angle: round(o.angle), scaleX: round(o.scaleX), scaleY: round(o.scaleY) };
    })));
}
async function imagesEqual(pages, count) {
  return wait(`all ${pages.length} devices must display ${count} actual images`, async () => {
    const states = await Promise.all(pages.map(state));
    if (states.some((items) => items.length !== count || items.some((o) => !o.loaded || o.pending || o.transient))) return false;
    return states.every((items) => JSON.stringify(items) === JSON.stringify(states[0]));
  });
}
async function press(page, pattern, profile) {
  await page.bringToFront();
  const button = page.getByRole('button', { name: pattern });
  if (profile.hasTouch) await button.tap(); else await button.click();
}
const results = [];
try {
  for (let ownerIndex = 0; ownerIndex < profiles.length; ownerIndex++) {
    const contexts = await Promise.all(profiles.map(({ name, ...options }) => browser.newContext({ ...options, deviceScaleFactor: 1 })));
    const pages = await Promise.all(contexts.map((context) => context.newPage()));
    const errors = [];
    for (const [index, page] of pages.entries()) {
      await instrument(page);
      page.on('pageerror', (error) => errors.push({ device: profiles[index].name, error: error.message }));
      page.on('console', (message) => { if (['error', 'warning'].includes(message.type())) console.log(profiles[index].name, message.text().slice(0, 1000)); });
    }
    const owner = pages[ownerIndex];
    try {
      await owner.goto(BASE, { waitUntil: 'domcontentloaded' });
      await owner.getByLabel('Название доски').fill(`Image regression ${ENGINE} ${ownerIndex} ${Date.now()}`);
      await owner.getByLabel('Ученик').fill('Synthetic image regression');
      await owner.getByRole('button', { name: 'Создать доску' }).click();
      await enter(owner, 'Image owner');
      const guest = new URL(owner.url()); guest.searchParams.set('key', await deriveShareKey(guest.searchParams.get('key')));
      for (const [index, page] of pages.entries()) if (index !== ownerIndex) {
        await page.goto(guest.href, { waitUntil: 'domcontentloaded' }); await enter(page, `Image student ${index}`);
      }
      const data = await owner.evaluate(() => {
        const canvas = document.createElement('canvas'); canvas.width = 1000; canvas.height = 700;
        const ctx = canvas.getContext('2d'); const pixels = ctx.createImageData(1000, 700);
        let seed = 1789;
        for (let i = 0; i < pixels.data.length; i++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; pixels.data[i] = i % 4 === 3 ? 255 : seed >>> 24; }
        ctx.putImageData(pixels, 0, 0); return canvas.toDataURL('image/png').split(',')[1];
      });
      assert.ok(data.length > 2000000, 'fixture must require multi-megabyte durable transfer');
      const blockedReceiver = pages[(ownerIndex + 1) % pages.length];
      await blockedReceiver.evaluate(() => { window.__imageBlockOnce = true; });
      for (const [index, page] of pages.entries()) {
        console.log(`INSERT owner=${ownerIndex} actor=${index}`);
        await page.locator('.image-file-input').setInputFiles({ name: `shared-${index}.png`, mimeType: 'image/png', buffer: Buffer.from(data, 'base64') });
        await imagesEqual(pages, index + 1);
        console.log(`UNDO owner=${ownerIndex} actor=${index}`);
        await press(page, /Отменить —/, profiles[index]); await imagesEqual(pages, index);
        console.log(`REDO owner=${ownerIndex} actor=${index}`);
        await press(page, /Вернуть —/, profiles[index]); await imagesEqual(pages, index + 1);
      }
      assert.equal(await blockedReceiver.evaluate(() => window.__imageLoads.filter((entry) => entry.state === 'blocked').length), 1);
      // Exercise the clipboard event path with real PNG bytes, without using the
      // test runner host's OS clipboard or changing native text input behavior.
      await owner.evaluate((base64) => {
        const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
        const transfer = new DataTransfer(); transfer.items.add(new File([bytes], 'clipboard.png', { type: 'image/png' }));
        const event = new Event('paste', { bubbles: true, cancelable: true });
        Object.defineProperty(event, 'clipboardData', { value: transfer });
        document.dispatchEvent(event);
      }, data);
      await imagesEqual(pages, 4);
      for (const [index, page] of pages.entries()) if (index !== ownerIndex) { await page.reload(); await enter(page, `Image student ${index}`); }
      await imagesEqual(pages, 4);
      const lateContext = await browser.newContext({ viewport: profiles[(ownerIndex + 1) % 3].viewport });
      try {
        const late = await lateContext.newPage(); await instrument(late);
        await late.goto(guest.href); await enter(late, 'Late image student'); await imagesEqual([...pages, late], 4);
      } finally { await lateContext.close(); }
      assert.deepEqual(errors, []);
      results.push({ engine: ENGINE, owner: profiles[ownerIndex].name, actors: profiles.map((p) => p.name), fixtureBase64Chars: data.length, stalledReceiverRecovered: true, clipboard: true, passed: true });
      console.log(JSON.stringify(results.at(-1)));
    } catch (error) {
      for (const [index, page] of pages.entries()) {
        const diagnostic = { objects: await state(page).catch(() => null), errors,
          details: await page.evaluate(() => ({ loads: window.__imageLoads, dataset: { ...document.documentElement.dataset }, text: document.body.innerText })).catch(() => null) };
        fs.writeFileSync(`${out}/${ENGINE}-${ownerIndex}-${index}.json`, JSON.stringify(diagnostic, null, 2));
        await page.screenshot({ path: `${out}/${ENGINE}-${ownerIndex}-${index}.png` }).catch(() => {});
      }
      throw error;
    } finally { await Promise.allSettled(contexts.map((context) => context.close())); }
  }
} finally { fs.writeFileSync(`${out}/${ENGINE}-results.json`, JSON.stringify(results, null, 2)); await browser.close(); }
