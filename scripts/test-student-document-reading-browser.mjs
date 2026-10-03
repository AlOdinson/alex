import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, webkit } from 'playwright-core';

// This fixture uses real IndexedDB, PDF decoding, React and native browser input.
// It deliberately has no teacher and no network transport; reconnect protocol is
// covered separately by test-student-offline-e2e and runtime transition tests.
const engine = process.env.VERIFICATION_BROWSER === 'webkit' ? 'webkit' : 'chromium';
const base = 'http://127.0.0.1:5173/alex';
const out = 'student-document-reading-results';
await mkdir(out, { recursive: true });
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1'], { stdio: 'ignore' });
const browser = await (engine === 'webkit' ? webkit : chromium).launch({ headless: true,
  ...(engine === 'chromium' ? { args: ['--no-sandbox'], ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}) } : {}) });
const results = [], errors = []; let page;
async function bindCanvas(p) {
  await p.waitForFunction(() => document.querySelector('canvas.upper-canvas')?.dataset.readonlyNavigation === 'true');
  await p.evaluate(() => {
    let e = document.querySelector('canvas.upper-canvas');
    while (e) {
      const key = Object.keys(e).find(k => k.startsWith('__reactFiber'));
      for (let f = key ? e[key] : null; f; f = f.return) {
        for (let h = f.memoizedState; h; h = h.next) {
          const v = h.memoizedState?.current;
          if (v?.lowerCanvasEl && v?.getObjects) { window.c = v; break; }
        }
      }
      e = e.parentElement;
    }
    window.object = id => window.c.getObjects().find(o => o.boardObjectId === id);
    window.point = id => { const o = window.object(id), p = o.getCenterPoint(), v = window.c.viewportTransform, r = window.c.upperCanvasEl.getBoundingClientRect();
      return { x:r.left + p.x*v[0]+p.y*v[2]+v[4], y:r.top + p.x*v[1]+p.y*v[3]+v[5] }; };
  });
  await p.waitForFunction(() => window.c?.getObjects().length === 3);
}
async function enter(p) {
  await p.locator('canvas.upper-canvas, input').first().waitFor();
  const name = p.getByLabel('Ваше имя');
  if (await name.isVisible()) { await name.fill('Offline reader'); await p.getByRole('button', {name:'Войти на доску',exact:true}).click(); }
  await bindCanvas(p);
}
async function clickDocument(p, id, touch = false) {
  const at = await p.evaluate(id => window.point(id), id);
  if (touch) await p.touchscreen.tap(at.x, at.y); else await p.mouse.click(at.x,at.y);
  await p.waitForFunction(id => window.c.getActiveObject()?.boardObjectId === id, id);
  assert.equal(await p.locator('.toolbar-shell').count(),0, 'document selection cannot expose editing tools');
}
async function saved(p, record) {
  return p.evaluate(async ({id,key}) => {
    const api=await import('/alex/src/lib/studentOfflineCache.js'); return api.readStudentOfflineSnapshot(id,key);
  },record);
}
try {
  for (let i=0;i<100;i++) { try { if ((await fetch(base)).ok) break; } catch {} await new Promise(r=>setTimeout(r,100)); }
  for (const touch of [false,true]) {
    const context = await browser.newContext({ viewport:{width:1200,height:900}, hasTouch:touch });
    await context.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
    page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
    await page.goto(`${base}/scripts/board-media-fixture.html`);
    const record = await page.evaluate(async () => {
      const {Rect,Textbox,FabricImage} = await import('/alex/node_modules/.vite/deps/fabric.js');
      const {BoardNotebook} = await import('/alex/src/lib/boardNotebook.js');
      const {MEDIA_PLACEHOLDER_SRC} = await import('/alex/src/lib/boardMediaRuntime.js');
      const {boardMediaAssets} = await import('/alex/src/lib/mediaAssetStore.js');
      const {studentOfflineStorage,studentOfflineScope} = await import('/alex/src/lib/studentOfflineCache.js');
      const id='offline-reading-'+crypto.randomUUID(), key='reading-secret';
      const asset=await boardMediaAssets.importFile(id,new File([await (await fetch('/alex/scripts/fixtures/media/pages.pdf')).blob()],'lesson.pdf',{type:'application/pdf'}));
      const pdf=await FabricImage.fromURL(MEDIA_PLACEHOLDER_SRC);
      pdf.set({boardObjectId:'pdf',mediaKind:'pdf',mediaAssetId:asset.assetId,mediaName:'lesson.pdf',pageNumber:1,pageCount:2,
        width:300,height:400,left:100,top:120,updatedAt:100,updatedBy:'teacher'});
      const ink=(id,fill)=>new Rect({boardObjectId:id,width:120,height:80,left:20,top:60,fill}).toObject(['boardObjectId']);
      const book=new BoardNotebook({boardObjectId:'book',left:550,top:120,width:420,height:440,
        notebookPages:[[ink('red','red')],[ink('blue','blue')],[ink('green','green')]],updatedAt:100,updatedBy:'teacher'});
      const text=new Textbox('Read only lesson',{boardObjectId:'text',left:100,top:700,updatedAt:100,updatedBy:'teacher'});
      const props=['boardObjectId','mediaKind','mediaAssetId','mediaName','pageNumber','pageCount','updatedAt','updatedBy'];
      const snapshot={version:2,background:'blank',canvas:{objects:[pdf.toObject(props),book.toObject(props),text.toObject(props)]}};
      await studentOfflineStorage.replace(await studentOfflineScope(id,key),{boardId:id,snapshot,revision:7,savedAt:1000});
      pdf.dispose(); book.dispose(); text.dispose(); return {id,key};
    });
    await page.goto(`${base}/board/${record.id}?key=${record.key}`); await enter(page);
    const initial=await saved(page,record);
    assert.equal(await page.locator('.toolbar-shell').count(),0);
    await clickDocument(page,'pdf',touch);
    await page.locator('.pdf-page-controls').waitFor();
    await page.locator('.pdf-page-controls button').last().click();
    await page.waitForFunction(()=>window.object('pdf').pageNumber===2);
    await page.waitForFunction(()=>window.object('pdf').getElement().width>1);
    assert.equal(await page.locator('.pdf-page-controls button').last().isDisabled(),true);
    const slider=page.locator('.pdf-page-slider'); await slider.focus(); await page.keyboard.press('Home');
    await page.waitForFunction(()=>window.object('pdf').pageNumber===1);
    await page.keyboard.press('End'); await page.waitForFunction(()=>window.object('pdf').pageNumber===2);
    const pdfPixels=await page.evaluate(()=>{const o=window.object('pdf'),e=o.getElement();return {width:e.width,height:e.height,source:o.getSrc()};});
    assert.ok(pdfPixels.width>1&&pdfPixels.height>1,'PDF page two really decoded, not only a new number');
    await clickDocument(page,'book',touch);
    const next=page.locator('.notebook-nav-next button'),prev=page.locator('.notebook-nav-previous button');
    await next.click(); await page.waitForFunction(()=>window.object('book').notebookPageNumber===2);
    assert.equal(await page.evaluate(()=>window.object('book').getPageObjects()[0].fill),'blue');
    await next.click(); await page.waitForFunction(()=>window.object('book').notebookPageNumber===3);
    assert.equal(await next.isDisabled(),true,'readers cannot create new notebook pages');
    await prev.click(); await page.waitForFunction(()=>window.object('book').notebookPageNumber===2);
    // Repeated reconnect notifications must not strand the read-only input fence.
    await page.evaluate(id=>{for(const state of ['waiting','teacher-offline','disconnected'])window.dispatchEvent(new CustomEvent('alex-board-runtime-state',{detail:{boardId:id,permission:'edit',state}}));},record.id);
    await clickDocument(page,'pdf',touch); await clickDocument(page,'book',touch);
    const geometry=await page.evaluate(()=>window.c.getObjects().map(o=>({id:o.boardObjectId,left:o.left,top:o.top,width:o.width,height:o.height,scaleX:o.scaleX,scaleY:o.scaleY,angle:o.angle})));
    const p=await page.evaluate(()=>window.point('book'));
    await page.mouse.move(p.x,p.y); await page.mouse.down(); await page.mouse.move(p.x+70,p.y+45,{steps:10}); await page.mouse.up();
    await page.keyboard.press('Escape'); await clickDocument(page,'book',touch);
    await page.keyboard.press('Delete'); await page.keyboard.press('ArrowRight'); await page.keyboard.press('Control+z');
    assert.deepEqual(await page.evaluate(()=>window.c.getObjects().map(o=>({id:o.boardObjectId,left:o.left,top:o.top,width:o.width,height:o.height,scaleX:o.scaleX,scaleY:o.scaleY,angle:o.angle}))),geometry,'read gestures and shortcuts never edit document geometry');
    assert.deepEqual(await saved(page,record),initial,'local reading leaves the entire archive and revision untouched');
    assert.equal(await page.evaluate(()=>window.c.isDrawingMode),false);
    await page.screenshot({path:`${out}/${engine}-${touch?'touch':'mouse'}.png`});
    await page.reload(); await enter(page); await clickDocument(page,'book',touch);
    assert.equal(await page.evaluate(()=>window.object('book').notebookPageNumber),1);
    assert.equal(await page.evaluate(()=>window.object('pdf').pageNumber),1);
    assert.deepEqual(await saved(page,record),initial);
    results.push({engine,input:touch?'native touch selection':'mouse selection',pdfDecoded:true,pdfButtonsAndSlider:true,notebookPages:true,
      noBlankPageCreation:true,toolbarHidden:true,geometryProtected:true,archiveUnchanged:true,reload:true,transport:'intentionally offline'});
    await context.close(); page=null;
  }
  assert.deepEqual(errors,[]); console.log(JSON.stringify({results,errors},null,2));
} catch(error) {
  if(page) { await page.screenshot({path:`${out}/${engine}-failure.png`}).catch(()=>{});
    await writeFile(`${out}/${engine}-failure.json`,JSON.stringify({error:String(error),errors,details:await page.evaluate(()=>({text:document.body.innerText,data:{...document.documentElement.dataset},objects:window.c?.getObjects().map(o=>({id:o.boardObjectId,type:o.type,page:o.pageNumber,nbpage:o.notebookPageNumber,evented:o.evented,selectable:o.selectable}))})).catch(()=>null)},null,2)); }
  throw error;
} finally {
  await writeFile(`${out}/${engine}.json`,JSON.stringify({results,errors},null,2)); await browser.close(); server.kill();
}
