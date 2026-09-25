import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, webkit } from 'playwright-core';
import { deriveShareKey } from '../src/lib/ids.js';

const engine = process.env.VERIFICATION_BROWSER ?? 'chromium';
const home = process.env.VERIFICATION_TEST_URL ?? 'http://127.0.0.1:5173/alex/';
if (!['127.0.0.1', 'localhost'].includes(new URL(home).hostname)) throw new Error('Fault injection is local CI only');
const browser = await (engine === 'webkit' ? webkit.launch({ headless: true })
  : chromium.launch({ channel: 'chrome', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] }));
const out = 'signaling-assistance-results';
await mkdir(out, { recursive: true });
const results = [];
const pause = ms => new Promise(r => setTimeout(r, ms));
async function wait(label, fn, ms = 40000) {
  const end = Date.now() + ms; let last;
  while (Date.now() < end) { try { if (await fn()) return; } catch (e) { last = e; } await pause(80); }
  throw new Error(`${label}: ${last?.message ?? 'timed out'}`);
}
async function instrument(context, mode, owner) {
  await context.addInitScript(({ mode, owner, relay }) => {
    window.__signalEvidence = { signals: [], pcCount: 0, protocolMismatch: 0 };
    const NativePeer = window.RTCPeerConnection;
    window.RTCPeerConnection = class extends NativePeer {
      constructor(config) {
        super(relay ? { ...config, iceTransportPolicy: 'relay', iceServers: [{
          urls: 'turn:127.0.0.1:3478?transport=udp', username: 'bounded-ci', credential: 'bounded-ci-loopback-only-20260925',
        }] } : config);
        window.__signalEvidence.pcCount++;
      }
    };
    // The actual Ably client/token/channel are retained. Only the selected
    // outgoing bootstrap signal is dropped before publication; no board action,
    // snapshot, WebRTC method or application handler is mocked.
    let ably;
    Object.defineProperty(window, 'Ably', { configurable: true, get: () => ably, set(sdk) {
      // Modern Ably bundles expose Realtime through an export getter. Keep the
      // native constructor and other exports, but replace the outer namespace;
      // assignment to sdk.Realtime itself can silently leave it unchanged.
      const property = Object.getOwnPropertyDescriptor(sdk, 'Realtime');
      window.__signalEvidence.realtimeExport = { getter: Boolean(property?.get), writable: property?.writable ?? null };
      ably = { ...sdk };
      const NativeRealtime = sdk.Realtime;
      ably.Realtime = new Proxy(NativeRealtime, { construct(Target, args) {
        const client = Reflect.construct(Target, args);
        const get = client.channels.get.bind(client.channels);
        const wrapped = new WeakSet();
        client.channels.get = (...args) => {
          const channel = get(...args);
          if (wrapped.has(channel)) return channel;
          wrapped.add(channel);
          const publish = channel.publish.bind(channel);
          let descriptions = 0;
          channel.publish = (name, data, ...rest) => {
            const signal = data?.signal;
            if (data?.protocol === 'alex-board-peer-signal-v1' && signal) {
              if (signal.type === (owner ? 'answer' : 'offer')) descriptions++;
              const drop = (mode === 'offer' && !owner && signal.type === 'offer' && descriptions === 1)
                || (mode === 'answer' && owner && signal.type === 'answer' && descriptions === 1)
                || (mode === 'ice' && signal.type === 'ice' && descriptions < 2);
              window.__signalEvidence.signals.push({ type: signal.type, id: signal.negotiationId,
                dropped: drop, at: performance.now() });
              if (drop) return Promise.resolve();
              if (mode === 'ice' && signal.description) {
                // Remove embedded candidates as well, so lost trickle ICE cannot
                // accidentally succeed via the SDP and disguise a missing repair.
                data = { ...data, signal: { ...signal, description: { ...signal.description,
                  sdp: signal.description.sdp.replace(/^a=candidate:.*\r?\n/gm, '') } } };
              }
            }
            return publish(name, data, ...rest);
          };
          return channel;
        };
        return client;
      } });
    } });
    window.__signalCanvas = () => {
      let element = document.querySelector('canvas.upper-canvas');
      while (element) {
        const key = Object.keys(element).find(k => k.startsWith('__reactFiber$'));
        for (let fiber = key ? element[key] : null; fiber; fiber = fiber.return) {
          let hook = fiber.memoizedState, n = 0;
          while (hook && n++ < 900) {
            const v = hook.memoizedState?.current;
            if (v?.getObjects && v?.lowerCanvasEl) return v;
            hook = hook.next;
          }
        }
        element = element.parentElement;
      }
      return null;
    };
  }, { mode, owner, relay: process.env.VERIFICATION_TEST_TURN === '1' });
}
async function enter(page, name) {
  await wait('name/canvas', async () => {
    if (await page.locator('canvas.upper-canvas').isVisible()) return true;
    const field = page.getByLabel('Ваше имя');
    if (await field.isVisible()) { await field.fill(name); await page.getByRole('button', { name: 'Войти на доску' }).click(); }
    return false;
  });
  await wait('editing ready', () => page.evaluate(() => document.documentElement.dataset.alexDurableEditState === 'ready'));
}
async function state(page) {
  return page.evaluate(() => (window.__signalCanvas()?.getObjects() ?? [])
    .filter(o => o.boardObjectId && !o.transientPreview && !o.transientScreenShare)
    .map(o => ({ id: o.boardObjectId, path: o.path, left: o.left, top: o.top, stroke: o.stroke })));
}
async function stroke(page, i) {
  await page.getByRole('button', { name: 'Карандаш', exact: true }).click();
  const box = await page.locator('canvas.upper-canvas').boundingBox();
  await page.mouse.move(box.x + 150 + 100 * i, box.y + 200);
  await page.mouse.down(); await page.mouse.move(box.x + 195 + 100 * i, box.y + 220, { steps: 4 }); await page.mouse.up();
}
async function equal(owner, student, count) {
  await wait('confirmed same objects', async () => {
    const [a, b] = await Promise.all([state(owner), state(student)]);
    return a.length === count && JSON.stringify(a) === JSON.stringify(b);
  });
}
try {
  for (const mode of ['clean', 'offer', 'answer', 'ice']) {
    const contexts = await Promise.all([0, 1].map(() => browser.newContext({ viewport: { width: 1100, height: 800 } })));
    const pages = await Promise.all(contexts.map(c => c.newPage()));
    const [owner, student] = pages; const errors = [];
    for (let i = 0; i < 2; i++) { await instrument(contexts[i], mode, i === 0); pages[i].on('pageerror', e => errors.push(e.message)); }
    try {
      await owner.goto(home, { waitUntil: 'domcontentloaded' });
      await owner.getByLabel('Название доски').fill(`Signal test ${mode} ${Date.now()}`);
      await owner.getByLabel('Ученик').fill('Synthetic signaling test');
      await owner.getByRole('button', { name: 'Создать доску' }).click(); await enter(owner, 'Signal owner');
      const guest = new URL(owner.url()); guest.searchParams.set('key', await deriveShareKey(guest.searchParams.get('key')));
      const started = Date.now();
      await student.goto(guest.href, { waitUntil: 'domcontentloaded' }); await enter(student, 'Signal student');
      const readyMs = Date.now() - started;
      await stroke(owner, 0); await equal(owner, student, 1);
      await stroke(student, 1); await equal(owner, student, 2);
      await student.getByRole('button', { name: /Отменить —/ }).click(); await equal(owner, student, 1);
      await student.getByRole('button', { name: /Вернуть —/ }).click(); await equal(owner, student, 2);
      const before = await Promise.all(pages.map(p => p.evaluate(() => window.__signalEvidence)));
      await pause(8500); // beyond both bootstrap retry deadlines
      const after = await Promise.all(pages.map(p => p.evaluate(() => window.__signalEvidence)));
      assert.deepEqual(after.map(x => x.signals.length), before.map(x => x.signals.length), 'healthy channel must stop assistance');
      assert.equal(after[1].pcCount, 1, 'must rescue the same student RTCPeerConnection, not wait for recreation');
      assert.equal(after[0].pcCount, 1, 'replay must not replace the answering peer');
      const offers = after[1].signals.filter(s => s.type === 'offer');
      assert.equal(new Set(offers.map(s => s.id)).size, 1);
      if (mode !== 'clean') {
        assert.ok(offers.length >= 2, 'must exercise actual retransmission');
        assert.ok(after.some(e => e.signals.some(s => s.dropped)), 'fault injection must occur');
      }
      assert.deepEqual(errors, []);
      results.push({ mode, engine, readyMs, owner: after[0], student: after[1], passed: true });
      console.log(JSON.stringify({ mode, engine, readyMs, passed: true }));
    } catch (error) {
      await writeFile(`${out}/${engine}-${mode}-failure.json`, JSON.stringify({ error: error.message, errors,
        devices: await Promise.all(pages.map(p => p.evaluate(() => ({ evidence: window.__signalEvidence,
          dataset: { ...document.documentElement.dataset } })).catch(() => null))) }, null, 2));
      throw error;
    } finally { await Promise.allSettled(contexts.map(c => c.close())); }
  }
} finally {
  await writeFile(`${out}/${engine}.json`, JSON.stringify(results, null, 2));
  await browser.close();
}
