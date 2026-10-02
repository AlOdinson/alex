import { chromium, webkit } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const receiverEngine = process.env.VERIFICATION_BROWSER === 'webkit' ? 'webkit' : 'chromium';
const senderEngine = process.env.RECEIVER_CROSS_ENGINE === '1' ? (receiverEngine === 'webkit' ? 'chromium' : 'webkit') : receiverEngine;
const baseline = process.env.RECEIVER_BASELINE === '1';
const label = `${senderEngine}-to-${receiverEngine}-${baseline ? 'baseline' : 'fixed'}`;
const output = 'screen-share-receiver-results';
const port = 5197, base = `http://127.0.0.1:${port}/alex/`, sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port',String(port),'--strictPort'], {stdio:'ignore'});
const pages = {}, browsers = [], reports = [], errors = [];
await mkdir(output, {recursive:true});
try {
  for (let i = 0; i < 100; i++) { try { if ((await fetch(base)).ok) break; } catch {} await sleep(100); }
  for (const role of ['host','viewer']) {
    const engine = role === 'host' ? senderEngine : receiverEngine;
    const browser = await ({chromium,webkit}[engine]).launch({headless:true,...(engine === 'chromium' ? {
      args: ['--no-sandbox','--autoplay-policy=no-user-gesture-required','--disable-features=WebRtcHideLocalIpsWithMdns','--allow-loopback-in-peer-connection'],
      ...(process.env.CHROMIUM_EXECUTABLE ? {executablePath:process.env.CHROMIUM_EXECUTABLE} : {}),
    } : {})}); browsers.push(browser);
    const context = await browser.newContext({ viewport: {width:1920,height:1080}, deviceScaleFactor:2 });
    const page = pages[role] = await context.newPage();
    if (engine === 'webkit' && process.env.WEBKIT_LOCAL_ICE === '1') {
      const implementation = page._connection.toImpl(page);
      await implementation.delegate._session.send('Page.overrideSetting', {setting:'ICECandidateFilteringEnabled',value:false});
    }
    page.on('pageerror', error => errors.push({role,error:error.message}));
    await page.exposeFunction('routeSignal', async message => {
      const target = pages[role === 'host' ? 'viewer' : 'host'];
      if (target) await target.evaluate(m => window.receiverTest?.receive(m), message);
    });
    await page.goto(base + 'scripts/screen-share-receiver-fixture.html');
    await page.evaluate(async role => (await import('./screen-share-receiver-fixture.jsx')).install(role), role);
    await page.waitForFunction(() => Boolean(window.receiverTest?.share?.start));
  }
  await pages.host.evaluate(() => window.receiverTest.share.start());
  await pages.viewer.waitForFunction(() => window.receiverTest.media?.video.readyState >= 2, null, {timeout:25000});
  // Keep the ordinary sender's activity profile at its real motion setting.
  await pages.host.evaluate(() => { window.receiverTest.activity = setInterval(() => window.dispatchEvent(new Event('pointermove')), 200); });
  async function measure(name, {fault = '', quiet = false} = {}) {
    if (name !== 'offscreen' && name !== 'back-onscreen') {
      await pages.viewer.evaluate(fault => window.receiverTest.setFault(fault), fault);
    }
    await sleep(800);
    const before = await pages.viewer.evaluate(() => window.receiverTest.sample());
    await sleep(3000);
    const after = await pages.viewer.evaluate(() => window.receiverTest.sample());
    const sender = await pages.host.evaluate(() => window.receiverTest.sample());
    const seconds = (after.time - before.time) / 1000;
    const inbound = value => value.stats.find(s => s.type === 'inbound-rtp' && (s.kind === 'video' || s.mediaType === 'video')) ?? {};
    const a = inbound(after), b = inbound(before);
    const times = after.presentationTimes.filter(t => t >= before.time);
    const gaps = [before.time, ...times, after.time].slice(1).map((t,i) => t - [before.time,...times][i]);
    const result = {name, fault, seconds, decodedFps:(a.framesDecoded-b.framesDecoded)/seconds,
      copiesFps:(after.copies-before.copies)/seconds, uniqueFps:(after.uniqueFrames-before.uniqueFrames)/seconds,
      notificationsFps:(after.notifications-before.notifications)/seconds, maxGapMs:Math.max(...gaps),
      packetLossDelta:(a.packetsLost??0)-(b.packetsLost??0), decodedDroppedDelta:(a.framesDropped??0)-(b.framesDropped??0),
      width:after.width,height:after.height,objects:after.objects,pump:after.pump,before,after,sender};
    reports.push(result); console.log(label, name, JSON.stringify({...result,before:undefined,after:undefined,sender:undefined}));
    await writeFile(`${output}/${label}.json`, JSON.stringify({senderEngine,receiverEngine,baseline,reports,errors},null,2));
    assert.equal(after.objects,1,'receiving board must contain only the video');
    assert.ok(result.decodedFps >= (name.startsWith('standard') ? 6 : 10),'test connection must actually deliver video');
    if (!baseline) {
      assert.equal(after.pump?.errors, 0, 'frame pump must not hide render errors');
      if (quiet) assert.equal(result.copiesFps,0,'offscreen receiver must not stage frames');
      else {
        assert.ok(result.uniqueFps >= (name.startsWith('standard') ? 5 : 8),`insufficient distinct received frames: ${result.uniqueFps}`);
        assert.ok(result.uniqueFps >= result.decodedFps * .45,`renderer loses most decoded frames: ${result.uniqueFps}/${result.decodedFps}`);
        assert.ok(result.maxGapMs < 450,`receiver presentation stalls for ${result.maxGapMs}ms`);
      }
    }
    return result;
  }
  await measure('standard-motion');
  await pages.host.evaluate(() => window.receiverTest.share.setUltraEnabled(true));
  await measure('ultra1080');
  await pages.host.evaluate(() => window.receiverTest.share.setResolution720Enabled(true));
  await measure('ultra720');
  await measure('ultra720-callback-2hz', {fault:'slow'});
  await pages.host.evaluate(() => window.receiverTest.share.setResolution720Enabled(false));
  await measure('ultra1080-callback-2hz', {fault:'slow'});
  await measure('ultra1080-no-callback-api', {fault:'no-api'});
  await measure('ultra1080-counterless-callback-2hz', {fault:'counterless-slow'});
  await pages.viewer.evaluate(() => {const d=window.receiverTest;d.setFault('');d.media.setLayout({left:10000,top:40,width:900,height:506.25});d.canvas.requestRenderAll();});
  await measure('offscreen', {quiet:true});
  await pages.viewer.evaluate(() => {const d=window.receiverTest;d.media.setLayout({left:40,top:40,width:900,height:506.25});d.canvas.requestRenderAll();});
  await measure('back-onscreen');
  assert.deepEqual(errors,[],'no page errors in receiver or sender');
  if (!baseline) {
    // Compare the labelled fault with the identical test against production.
    let previous;
    try {previous=JSON.parse(await readFile(`${output}/${senderEngine}-to-${receiverEngine}-baseline.json`,'utf8'));} catch {}
    if (previous) for (const name of ['ultra720-callback-2hz','ultra1080-callback-2hz']) {
      const old=previous.reports.find(r=>r.name===name), fixed=reports.find(r=>r.name===name);
      assert.ok(old.uniqueFps <= 3,'baseline fault did not reproduce the old low cadence');
      assert.ok(fixed.uniqueFps > old.uniqueFps * 2,'receiver did not recover from the diagnosed failure mode');
    }
  }
} catch (error) {
  errors.push({error:error.stack}); console.error(error); process.exitCode=1;
} finally {
  await writeFile(`${output}/${label}.json`,JSON.stringify({senderEngine,receiverEngine,baseline,reports,errors},null,2));
  for (const page of Object.values(pages)) {try {await page.evaluate(()=>{clearInterval(window.receiverTest.activity);return window.receiverTest.close();});} catch {}}
  for (const browser of browsers) await browser.close(); server.kill();
}
