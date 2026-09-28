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

    let offerDescriptions = 0;
    let answerDescriptions = 0;
    let ownerPathIce = 0;
    window.__alexBoardSignalingTestHook = (payload) => {
      const signal = payload?.signal;
      if (payload?.protocol !== 'alex-board-peer-signal-v1' || !signal) return { payload };

      const path = String(signal.path ?? '');
      if (signal.type === 'offer' && path === 'owner-initiated' && owner) offerDescriptions += 1;
      if (signal.type === 'answer' && path === 'owner-initiated' && !owner) answerDescriptions += 1;
      if (signal.type === 'ice' && path === 'owner-initiated') ownerPathIce += 1;

      const bootstrapSignal = signal.type === 'offer' || signal.type === 'answer' || signal.type === 'ice';
      const drop = (mode === 'offer' && owner && signal.type === 'offer'
          && path === 'owner-initiated' && offerDescriptions === 1)
        || (mode === 'answer' && !owner && signal.type === 'answer'
          && path === 'owner-initiated' && answerDescriptions === 1)
        || (mode === 'ice' && signal.type === 'ice'
          && path === 'owner-initiated' && ownerPathIce <= 2)
        || (mode === 'owner-path-dead' && path === 'owner-initiated' && bootstrapSignal)
        || (mode === 'student-path-dead' && path === 'student-initiated' && bootstrapSignal);

      window.__signalEvidence.signals.push({
        type: signal.type,
        path,
        id: signal.negotiationId ?? '',
        dropped: drop,
        at: performance.now(),
      });

      if (drop) return { drop: true };

      if (mode === 'ice' && path === 'owner-initiated' && signal.description?.sdp) {
        const nextSignal = {
          ...signal,
          description: {
            ...signal.description,
            sdp: signal.description.sdp.replace(/^a=candidate:.*\r?\n/gm, ''),
          },
        };
        return { payload: { ...payload, signal: nextSignal } };
      }
      return { payload };
    };

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
  for (const mode of ['clean', 'offer', 'answer', 'ice', 'owner-path-dead', 'student-path-dead']) {
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
      // Allow bounded path-select and signaling-assistance replays to settle, then
      // prove a healthy selected channel becomes quiet.
      await pause(2500);
      const before = await Promise.all(pages.map(p => p.evaluate(() => window.__signalEvidence)));
      await pause(6000);
      const after = await Promise.all(pages.map(p => p.evaluate(() => window.__signalEvidence)));
      assert.deepEqual(after.map(x => x.signals.length), before.map(x => x.signals.length),
        'healthy selected channel must stop bootstrap signaling');

      for (const evidence of after) {
        assert.ok(evidence.pcCount >= 1 && evidence.pcCount <= 2,
          'sequential two-path bootstrap must never run more than one path at a time');
        assert.equal(evidence.protocolMismatch, 0);
      }

      const allSignals = after.flatMap((evidence) => evidence.signals);
      assert.ok(allSignals.some((signal) => signal.path === 'owner-initiated'),
        'owner-initiated path must be tested');
      assert.ok(allSignals.some((signal) => signal.path === 'student-initiated'),
        'student-initiated path must be tested');

      if (mode !== 'clean') {
        assert.ok(allSignals.some((signal) => signal.dropped), 'fault injection must occur');
      }
      if (mode === 'offer') {
        const offers = allSignals.filter((signal) => signal.type === 'offer'
          && signal.path === 'owner-initiated');
        assert.ok(offers.length >= 2, 'lost preferred-path offer must be retried');
        assert.equal(new Set(offers.map((signal) => signal.id)).size, 1,
          'offer assistance must retry the same negotiation');
      }
      if (mode === 'answer') {
        const answers = allSignals.filter((signal) => signal.type === 'answer'
          && signal.path === 'owner-initiated');
        assert.ok(answers.length >= 2, 'lost preferred-path answer must be retried');
      }
      const selectedPaths = allSignals
        .filter((signal) => signal.type === 'path-select')
        .map((signal) => signal.path);
      if (mode === 'owner-path-dead') {
        assert.ok(selectedPaths.includes('student-initiated'),
          'a completely dead owner path must fall back to the student-initiated path');
      }
      if (mode === 'student-path-dead') {
        assert.ok(selectedPaths.includes('owner-initiated'),
          'a completely dead student path must keep the owner-initiated path');
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
