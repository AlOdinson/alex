import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, webkit } from 'playwright-core';

const engineName = process.env.VERIFICATION_BROWSER === 'webkit' ? 'webkit' : 'chromium';
const engine = engineName === 'webkit' ? webkit : chromium;
const port = 5296;
const base = `http://127.0.0.1:${port}/alex/`;
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { stdio: 'ignore' });
const checks = [], errors = [], signals = [];

// Only replace hosted presence and signaling. Student actions still go over
// the application's actual WebRTC data channel into the owner's IndexedDB.
function createLocalSignaling() {
  const rooms = new Map();
  return async (page) => {
    await page.exposeFunction('repairSignal', (roomId, clientId, event, payload) => {
      if (event !== 'get') signals.push({ event, type: payload?.data?.type, permission: payload?.permission, ready: payload?.authorityReady });
      const room = rooms.get(roomId) ?? new Map();
      rooms.set(roomId, room);
      if (event === 'get') return [...room.values()].map(member => member.data);
      if (event === 'leave') room.delete(clientId);
      if (event === 'presence') room.set(clientId, { page, data: { clientId, data: payload } });
      for (const [id, member] of room) {
        if (member.page.isClosed() || event === 'publish' && id === clientId) continue;
        void member.page.evaluate(({ roomId, event, payload }) => {
          window.repairDeliver?.(roomId, event, payload);
        }, { roomId, event, payload }).catch(() => undefined);
      }
    });
    await page.addInitScript(() => {
      window.repairProgress = [];
      window.addEventListener('alex-board-connection-progress', ({ detail }) => {
        window.repairProgress.push({ step: detail.step, detail: detail.detail, error: detail.error });
      });
      const receivers = new Map();
      window.repairDeliver = (roomId, event, payload) => receivers.get(roomId)?.(event, payload);
      window.Ably = { Realtime: class {
        constructor({ clientId }) {
          this.connection = { state: 'connected', on() {} };
          this.channels = { get: roomId => {
            const send = (event, payload) => window.repairSignal(roomId, clientId, event, payload);
            let message, presence;
            receivers.set(roomId, (event, payload) => {
              if (event === 'publish') message?.(payload);
              else presence?.();
            });
            this.close = () => { void send('leave'); };
            return {
              subscribe: listener => { message = listener; },
              publish: (name, data) => send('publish', { name, data }),
              presence: {
                get: () => send('get'),
                subscribe: listener => { presence = listener; },
                enter: data => send('presence', data),
                update: data => send('presence', data),
              },
            };
          } };
        }
      } };
    });
  };
}

const installSignaling = createLocalSignaling();
async function enterBoard(page, board, key, name) {
  await page.goto(`${base}board/${board.boardId}?key=${key}&webrtcLiveV1=1`);
  if (engineName === 'webkit' && process.env.WEBKIT_LOCAL_ICE === '1') {
    // Match the local-host ICE setting used by the direct-connection CI test.
    const implementation = page._connection.toImpl(page);
    await implementation.delegate._session.send('Page.overrideSetting', {
      setting: 'ICECandidateFilteringEnabled', value: false,
    });
  }
  await page.getByRole('textbox', { name: 'Ваше имя' }).fill(name);
  await page.getByRole('button', { name: 'Войти на доску', exact: true }).click();
  await page.waitForFunction(() => document.documentElement.dataset.alexDurableEditState === 'ready'
    && document.documentElement.dataset.alexDurableEditBlocked !== 'true');
}
const contexts = [], profiles = [];
async function openPage() {
  // Use a normal, persistent profile. WebKit does not store file-backed Blobs
  // in IndexedDB from an ephemeral context. Owner and student stay isolated.
  const profile = await mkdtemp(join(tmpdir(), 'alex-board-repair-'));
  profiles.push(profile);
  const context = await engine.launchPersistentContext(profile, {
    headless: true,
    viewport: { width: 1200, height: 850 },
    acceptDownloads: true,
    ...(engineName === 'chromium' ? {
      executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
      args: ['--no-sandbox', '--allow-loopback-in-peer-connection', '--disable-features=WebRtcHideLocalIpsWithMdns'],
    } : {}),
  });
  contexts.push(context);
  return context.pages()[0] ?? context.newPage();
}

let page;
try {
  let ready = false;
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(base)).ok) { ready = true; break; } } catch { /* server starting */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready, 'Vite repair server starts');
  page = await openPage();
  page.on('pageerror', error => errors.push(error.stack));
  await page.addInitScript(() => {
    navigator.mediaDevices.getDisplayMedia = async () => {
      const bitmap = document.createElement('canvas');
      bitmap.width = 320;
      bitmap.height = 180;
      const stream = bitmap.captureStream(10);
      const context = bitmap.getContext('2d');
      context.fillRect(0, 0, bitmap.width, bitmap.height);
      return stream;
    };
  });
  await installSignaling(page);
  await page.goto(base + 'scripts/board-repairs-fixture.html');
  const board = await page.evaluate(async () => (await import('/alex/src/lib/boardRepository.js')).createBoard('Board repair regression'));
  await enterBoard(page, board, board.ownerKey, 'Repair tester');
  await page.locator('[data-tool="eraser"]').waitFor();
  await page.evaluate(() => {
    let fiber = document.querySelector('.toolbar-shell');
    fiber = fiber?.[Object.keys(fiber).find(key => key.startsWith('__reactFiber'))];
    while (fiber && fiber.type?.name !== 'BoardWorkspace') fiber = fiber.return;
    for (let hook = fiber?.memoizedState; hook; hook = hook.next) {
      const value = hook.memoizedState?.current;
      if (value?.getObjects && value?.getZoom) window.__repairCanvas = value;
      if (value?.removeFromBoard && value?.handleSignal) window.repairScreenRef = hook.memoizedState;
    }
    if (!window.__repairCanvas) throw new Error('Fabric canvas unavailable');
  });

  // The actual popup changes target categories without erasing on selection.
  await page.locator('[data-tool="eraser"]').click();
  await page.getByRole('radiogroup').waitFor();
  assert.equal(await page.getByRole('radio', { name: 'Рисунок', exact: true }).getAttribute('aria-checked'), 'true');
  await page.getByRole('radio', { name: 'Медиа', exact: true }).click();
  assert.equal(await page.getByRole('radio', { name: 'Медиа', exact: true }).getAttribute('aria-checked'), 'true');
  await page.getByRole('radio', { name: 'Рисунок', exact: true }).click();
  await page.keyboard.press('Escape');
  checks.push('three circular eraser modes, safe drawing default, no clear on choice');

  // Real pointer hit: an image over ink must be skipped in Drawing mode.
  await page.evaluate(async () => {
    const {Rect,FabricImage} = await import('/alex/scripts/board-repairs-fixture.js');
    const c = window.__repairCanvas;
    const bitmap = document.createElement('canvas'); bitmap.width=120; bitmap.height=100;
    bitmap.getContext('2d').fillRect(0,0,120,100);
    window.__repairInk = new Rect({left:300,top:220,width:120,height:100,fill:'red',boardObjectId:'repair-ink'});
    window.__repairPhoto = new FabricImage(bitmap,{left:300,top:220,boardObjectId:'repair-photo',objectKind:'image'});
    c.add(window.__repairInk,window.__repairPhoto);c.renderAll();
  });
  const contact = await page.evaluate(() => { const c=window.__repairCanvas,r=c.upperCanvasEl.getBoundingClientRect();return{x:r.left+350,y:r.top+260}; });
  await page.mouse.click(contact.x,contact.y);
  await page.waitForFunction(() => !window.__repairCanvas.getObjects().includes(window.__repairInk));
  assert.equal(await page.evaluate(()=>window.__repairCanvas.getObjects().includes(window.__repairPhoto)),true);
  await page.locator('[data-tool="eraser"]').click();
  await page.getByRole('radio', { name: 'Медиа', exact:true }).click();
  await page.keyboard.press('Escape');
  await page.mouse.click(contact.x,contact.y);
  await page.waitForFunction(()=>!window.__repairCanvas.getObjects().includes(window.__repairPhoto));
  checks.push('actual eraser skips foreground image to erase ink, then media mode erases image');

  await page.evaluate(() => {
    const canvas = window.__repairCanvas;
    canvas.add(window.__repairInk, window.__repairPhoto);
    canvas.renderAll();
  });
  await page.locator('[data-tool="eraser"]').click();
  await page.getByRole('radio', { name: 'Всё', exact: true }).click();
  assert.equal(await page.evaluate(() => window.__repairCanvas.getObjects().length), 2,
    'choosing All must not clear objects');
  await page.keyboard.press('Escape');
  await page.mouse.click(contact.x, contact.y);
  await page.waitForFunction(() => !window.__repairCanvas.getObjects().includes(window.__repairPhoto));
  await page.mouse.click(contact.x, contact.y);
  await page.waitForFunction(() => !window.__repairCanvas.getObjects().includes(window.__repairInk));
  checks.push('All mode erases both categories only when hit');

  const mediaCenter = (kind) => page.evaluate(kind => {
    const canvas = window.__repairCanvas;
    const object = canvas.getObjects().find(o => o.mediaKind === kind || o.objectKind === kind);
    const point = object.getCenterPoint();
    const [a, b, c, d, e, f] = canvas.viewportTransform;
    const rect = canvas.upperCanvasEl.getBoundingClientRect();
    return { x: rect.left + point.x * a + point.y * c + e, y: rect.top + point.x * b + point.y * d + f };
  }, kind);
  async function eraserMode(name) {
    await page.locator('[data-tool="eraser"]').click();
    await page.getByRole('radio', { name, exact: true }).click();
    await page.keyboard.press('Escape');
  }
  await page.locator('.image-file-input').setInputFiles('scripts/fixtures/media/pages.pdf');
  await page.locator('.board-upload-item.done').waitFor();
  const pdf = await mediaCenter('pdf');
  await eraserMode('Рисунок');
  await page.mouse.click(pdf.x, pdf.y);
  assert.equal(await page.evaluate(() => window.__repairCanvas.getObjects().some(o => o.mediaKind === 'pdf')), true);
  await eraserMode('Медиа');
  await page.mouse.click(pdf.x, pdf.y);
  await page.waitForFunction(() => !window.__repairCanvas.getObjects().some(o => o.mediaKind === 'pdf'));
  checks.push('Drawing preserves a real PDF and Media erases it');

  await page.locator('.alex-settings-gear').click();
  await page.locator('.alex-settings-item[data-action="screenShare"]').click();
  await page.waitForFunction(() => window.__repairCanvas.getObjects().some(o => o.transientScreenShare)
    && window.repairScreenRef.current.stream?.getVideoTracks().length);
  await page.evaluate(() => {
    window.repairScreenTrack = window.repairScreenRef.current.stream.getVideoTracks()[0];
  });
  const screen = await mediaCenter('screen-share');
  await eraserMode('Рисунок');
  await page.mouse.click(screen.x, screen.y);
  assert.equal(await page.evaluate(() => window.repairScreenTrack.readyState), 'live');
  await eraserMode('Медиа');
  await page.mouse.click(screen.x, screen.y);
  await page.waitForFunction(() => window.repairScreenTrack.readyState === 'ended'
    && !window.__repairCanvas.getObjects().some(o => o.transientScreenShare));
  checks.push('Drawing preserves a live share and Media stops the host capture');

  // Real PNG/PDF download through settings gear, not a direct handler call.
  await page.evaluate(async()=>{
    const {Rect}=await import('/alex/scripts/board-repairs-fixture.js');
    const c=window.__repairCanvas,object=new Rect({left:250,top:200,width:80,height:60,fill:'red',boardObjectId:'export-object'});
    c.add(object);c.setActiveObject(object);c.renderAll();window.__exportSelected=object;
  });
  for (const [label,signature] of [['PNG текущей области','PNG'],['PNG всей доски','PNG'],['PDF всей доски','PDF']]) {
    await page.locator('.alex-settings-gear').click();
    await page.locator('.alex-settings-item[data-action="export"]').click();
    await page.locator('.board-export-menu').waitFor({state:'visible'});
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button',{name:label,exact:true}).click();
    const download=await downloadPromise;
    assert.equal(await download.failure(),null);
    const bytes=await readFile(await download.path());
    assert.ok(bytes.length>100);
    if(signature==='PNG') assert.equal(bytes.subarray(1,4).toString(),'PNG');
    else assert.equal(bytes.subarray(0,5).toString(),'%PDF-');
    assert.equal(await page.evaluate(()=>window.__repairCanvas.getActiveObject()===window.__exportSelected),true);
  }
  checks.push('settings gear downloads viewport PNG, full PNG and valid PDF without clearing selection');

  const bounded=await page.evaluate(async()=>{
    const {Canvas,Rect}=await import('/alex/scripts/board-repairs-fixture.js');
    const {renderFabricCanvas,canvasToPngBlob}=await import('/alex/src/lib/exportBoard.js');
    const el=document.createElement('canvas'),c=new Canvas(el,{width:300,height:200});
    c.add(new Rect({left:0,top:0,width:100,height:100,fill:'red'}),new Rect({left:100_000,top:50_000,width:100,height:100,fill:'blue'}));
    try {const out=renderFabricCanvas(c,'blank',{wholeBoard:true});const blob=await canvasToPngBlob(out);return {width:out.width,height:out.height,size:blob.size};}
    finally {await c.dispose();}
  });
  assert.ok(bounded.width<=4096&&bounded.height<=4096&&bounded.width*bounded.height<=8_000_000&&bounded.size>0);
  checks.push('widely separated objects produce a bounded nonempty image');

  // An export failure must be visible even though the old toolbar status is hidden.
  await page.evaluate(()=>{const c=window.__repairCanvas;window.__oldExport=c.toCanvasElement;c.toCanvasElement=()=>{throw new Error('Injected export failure');};});
  await page.locator('.alex-settings-gear').click();
  await page.locator('[data-action="export"]').click();
  await page.getByRole('button',{name:'PNG всей доски',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'Injected export failure'}).waitFor({state:'visible'});
  await page.evaluate(()=>{window.__repairCanvas.toCanvasElement=window.__oldExport;});
  checks.push('export failure is a visible dismissible alert');

  // Isolate the student in a second browser context with its own storage.
  const owner = page;
  const uploadsBoard = await owner.evaluate(async () => {
    return (await import('/alex/src/lib/boardRepository.js')).createBoard('Upload reconnect regression');
  });
  await owner.goto(`${base}board/${uploadsBoard.boardId}?key=${uploadsBoard.ownerKey}&webrtcLiveV1=1`);
  await owner.waitForFunction(() => document.documentElement.dataset.alexDurableEditState === 'ready');
  page = await openPage();
  page.on('pageerror', error => errors.push(error.stack));
  await installSignaling(page);
  await page.route('**/src/lib/imageStorage.js*', async route => {
    const response = await route.fetch();
    const body = await response.text();
    const marker = 'async function storeBoardImage(boardId, file) {';
    assert.ok(body.includes(marker), 'upload hook insertion point');
    await route.fulfill({ response, body: body.replace(marker, marker + `
      if (file.name === 'two.png' && !window.__repairDisconnectInjected) {
        window.__repairDisconnectInjected = true;
        window.dispatchEvent(new CustomEvent('alex-board-runtime-state', {
          detail: { boardId, state: 'waiting', permission: 'edit' }
        }));
        throw new Error('peer connection closed (injected test)');
      }
    `) });
  });
  await enterBoard(page, uploadsBoard, uploadsBoard.shareKey, 'Student');
  const png = await page.evaluate(() => {
    const bitmap = document.createElement('canvas');
    bitmap.width = bitmap.height = 32;
    bitmap.getContext('2d').fillRect(0, 0, 32, 32);
    return bitmap.toDataURL().split(',')[1];
  });
  const files = ['one.png', 'two.png', 'three.png'].map(name => ({
    name, mimeType: 'image/png', buffer: Buffer.from(png, 'base64'),
  }));
  await page.locator('.image-file-input').setInputFiles(files);
  await page.locator('.board-upload-item.waiting').first().waitFor();
  assert.equal(await page.locator('.board-upload-item.done').count(), 1);
  assert.equal(await page.locator('.board-upload-item').count(), 3);
  await page.evaluate(boardId => window.dispatchEvent(new CustomEvent('alex-board-runtime-state', {
    detail: { boardId, state: 'ready', permission: 'edit' },
  })), uploadsBoard.boardId);
  await page.waitForFunction(() => document.querySelectorAll('.board-upload-item.done').length === 3);
  const readImageIds = (browserPage, key) => browserPage.evaluate(async ({ boardId, key }) => {
    const { getBoardRecovery } = await import('/alex/src/lib/boardRepository.js');
    const recovery = await getBoardRecovery(boardId, key);
    return recovery.snapshot.canvas.objects.filter(object => object.objectKind === 'image')
      .map(object => object.boardObjectId);
  }, { boardId: uploadsBoard.boardId, key });
  const saved = await readImageIds(owner, uploadsBoard.ownerKey);
  assert.equal(saved.length, 3);
  assert.equal(new Set(saved).size, 3);
  assert.deepEqual(await readImageIds(page, uploadsBoard.shareKey), saved);
  checks.push('student upload pauses after first file and all three reach the owner over WebRTC exactly once');
  assert.deepEqual(errors,[],'unexpected uncaught browser errors');
  console.log(JSON.stringify({engine:engineName,checks,bounded},null,2));
} catch (error) {
  const progress = await page?.evaluate(() => ({
    state: document.documentElement.dataset.alexDurableEditState,
    progress: window.repairProgress,
    text: document.body.innerText.slice(0, 500),
  })).catch(() => null);
  console.error(JSON.stringify({ checks, progress, signals, errors }, null, 2));
  if(page) {await mkdir('board-repair-results',{recursive:true});await page.screenshot({path:`board-repair-results/${engineName}-failure.png`,fullPage:true}).catch(()=>{});await writeFile(`board-repair-results/${engineName}-failure.txt`,String(error.stack)+'\n'+JSON.stringify(errors));}
  throw error;
} finally {
  await Promise.allSettled(contexts.map(context => context.close()));
  await Promise.allSettled(profiles.map(profile => rm(profile, { recursive: true, force: true })));
  server.kill('SIGTERM');
}
