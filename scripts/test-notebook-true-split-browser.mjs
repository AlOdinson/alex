import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, webkit } from 'playwright-core';

const engine = process.env.VERIFICATION_BROWSER === 'webkit' ? 'webkit' : 'chromium';
const out = process.env.SPLIT_RESULTS_DIR || 'notebook-true-split-results';
const base = 'http://127.0.0.1:5173/alex';
await mkdir(out, { recursive: true });
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js','--host','127.0.0.1'], { stdio:'ignore' });
const profile = await mkdtemp(join(tmpdir(), 'alex-true-split-'));
let context, page, stage = 'launch';
const errors = [], results = [];
async function bind() {
  await page.waitForFunction(() => document.documentElement.dataset.alexDurableEditState === 'ready'
    && document.documentElement.dataset.alexDurableEditBlocked !== 'true');
  await page.evaluate(() => {
    let element = document.querySelector('.toolbar-shell');
    let fiber = element[Object.keys(element).find(key=>key.startsWith('__reactFiber'))];
    while (fiber && fiber.type?.name !== 'BoardWorkspace') fiber=fiber.return;
    for (let h=fiber.memoizedState;h;h=h.next) { const v=h.memoizedState?.current;
      if(v?.getObjects && v?.getZoom) { window.c=v;break; } }
    window.book = () => window.c.getObjects().find(o=>o.type==='boardnotebook');
    window.object = id => window.c.getObjects().find(o=>o.boardObjectId===id);
    window.toScreen = (x,y) => { const v=window.c.viewportTransform,r=window.c.upperCanvasEl.getBoundingClientRect();
      return { x:r.left+v[0]*x+v[2]*y+v[4], y:r.top+v[1]*x+v[3]*y+v[5] }; };
    window.unmasked = o => !o.clipPath && (o.getObjects?.()??[]).every(window.unmasked);
  });
}
async function committed(record, children) {
  await page.waitForFunction(async ({id,children}) => {
    const {getBoardRuntime} = await import('/alex/src/lib/browserBoardRuntimeRegistry.js');
    const n=getBoardRuntime(id)?.getSnapshot()?.canvas.objects.find(o=>String(o.type).toLowerCase()==='boardnotebook');
    return n?.notebookPages[0]?.length===children;
  }, {id:record.boardId,children});
}
try {
  context=await (engine==='webkit'?webkit:chromium).launchPersistentContext(profile, {
    headless:true, viewport:{width:1200,height:900},
    ...(engine==='chromium'?{args:['--no-sandbox'],...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{})}:{}),
  });
  page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  for(let i=0;i<100;i++){try{if((await fetch(base)).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
  await page.goto(`${base}/scripts/board-media-fixture.html`);
  const record=await page.evaluate(async()=>{const {createBoard}=await import('/alex/src/lib/boardRepository.js');return createBoard('True split regression');});
  await page.goto(`${base}/board/${record.boardId}?key=${record.ownerKey}`);
  const name=page.getByRole('textbox',{name:'Ваше имя'});await name.waitFor();await name.fill('Fragment test');
  await page.getByRole('button',{name:'Войти на доску',exact:true}).click();await bind();
  await page.keyboard.press('Alt+Shift+N');await page.locator('.notebook-page-controls').waitFor();
  await committed(record,0);
  stage='native crossing pencil';
  const stroke=await page.evaluate(()=>{const b=window.book().getBoundingRect();return {a:window.toScreen(b.left-60,b.top+90),b:window.toScreen(b.left+120,b.top+90)};});
  await page.getByRole('button',{name:'Карандаш',exact:true}).click();
  await page.mouse.move(stroke.a.x,stroke.a.y);await page.mouse.down();await page.mouse.move(stroke.b.x,stroke.b.y,{steps:18});await page.mouse.up();
  await page.waitForFunction(()=>window.book().getPageObjects().length===1);await committed(record,1);
  assert.equal(await page.evaluate(()=>window.c.getObjects().filter(o=>o!==window.book()&&!o.transientPreview).every(window.unmasked)&&window.book().getPageObjects().every(window.unmasked)),true);
  const linePixels=await page.evaluate(async()=>{
    const {StaticCanvas}=await import('/alex/node_modules/.vite/deps/fabric.js');
    const b=window.book().getBoundingRect(),outside=window.c.getObjects().find(o=>o!==window.book()&&!o.transientPreview),clone=await outside.clone();
    const c=new StaticCanvas(document.createElement('canvas'),{width:1200,height:900,enableRetinaScaling:false,renderOnAddRemove:false});c.add(clone);c.renderAll();
    const alpha=(x,y)=>c.getContext().getImageData(Math.round(x),Math.round(y),1,1).data[3];
    const value={removed:alpha(b.left+60,b.top+90),remaining:alpha(b.left-30,b.top+90),insideType:window.book().getPageObjects()[0].type};
    await c.dispose();return value;
  });
  assert.equal(linePixels.removed,0);assert.ok(linePixels.remaining>100);assert.notEqual(linePixels.insideType,'image');
  await page.getByRole('button',{name:/Отменить —/}).click();await page.waitForFunction(()=>window.book().getPageObjects().length===0);
  await page.getByRole('button',{name:/Вернуть —/}).click();await page.waitForFunction(()=>window.book().getPageObjects().length===1);await committed(record,1);
  results.push({name:stage,vector:true,noMasks:true,removedPixelsAbsent:true,undoRedo:true});

  stage='initial image insertion stays whole';
  await page.getByRole('button',{name:'Выделение',exact:true}).click();
  await page.evaluate(()=>window.beforeImage=new Set(window.c.getObjects().map(o=>o.boardObjectId)));
  const image=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=240;c.height=100;const x=c.getContext('2d');x.fillStyle='#00bb00';x.fillRect(0,0,240,100);return c.toDataURL().split(',')[1];});
  await page.locator('input[type=file][accept*="application/pdf"]').setInputFiles({name:'cut-source.png',mimeType:'image/png',buffer:Buffer.from(image,'base64')});
  await page.waitForFunction(()=>{const o=window.c.getObjects().find(o=>!window.beforeImage.has(o.boardObjectId)&&o.objectKind==='image'&&!o.pendingImage);if(!o||window.c.getActiveObject()!==o)return false;window.imageId=o.boardObjectId;return true;});
  assert.equal(await page.evaluate(()=>window.book().getPageObjects().length),1);
  const original=await page.evaluate(()=>{const o=window.object(window.imageId);return {src:o.getSrc(),width:o.width,height:o.height};});
  stage='native image drop creates only retained pixels';
  const move=await page.evaluate(()=>{const b=window.book().getBoundingRect(),o=window.object(window.imageId),r=o.getBoundingRect(),p=o.getCenterPoint();
    return {a:window.toScreen(p.x,p.y),b:window.toScreen(p.x+(b.left-r.width+40-r.left),p.y+(b.top+210-r.top))};});
  await page.mouse.move(move.a.x,move.a.y);await page.mouse.down();await page.waitForFunction(()=>window.c._currentTransform?.target?.lockMovementX===false);
  await page.mouse.move(move.b.x,move.b.y,{steps:16});await page.mouse.up();
  await page.waitForFunction(()=>window.book().getPageObjects().length===2);await committed(record,2);
  const fragments=await page.evaluate(()=>{const a=window.book().getPageObjects().find(o=>o.type==='image'),b=window.object(window.imageId);
    return {inside:{width:a.width,src:a.getSrc(),storage:a.storagePath},outside:{width:b.width,src:b.getSrc(),storage:b.storagePath},unmasked:window.unmasked(a)&&window.unmasked(b)};});
  assert.ok(fragments.unmasked);assert.ok(fragments.inside.width<original.width/2);assert.ok(fragments.outside.width<original.width);
  for(const part of [fragments.inside,fragments.outside]){assert.notEqual(part.src,original.src);assert.equal(part.storage,undefined);}
  await page.getByRole('button',{name:/Отменить —/}).click();await page.waitForFunction(()=>window.book().getPageObjects().length===1);
  assert.equal(await page.evaluate(()=>window.object(window.imageId).getSrc()),original.src);
  await page.getByRole('button',{name:/Вернуть —/}).click();await page.waitForFunction(()=>window.book().getPageObjects().length===2);await committed(record,2);
  results.push({name:stage,initialInsertionIndependent:true,croppedPixels:true,undoRestoresSource:true,insideWidth:fragments.inside.width,outsideWidth:fragments.outside.width});

  stage='partial text option A and undo';
  await page.evaluate(async()=>{const {Textbox}=await import('/alex/node_modules/.vite/deps/fabric.js');const b=window.book().getBoundingRect();
    const t=new Textbox('MMMMMMMM',{left:b.left-55,top:b.top+340,width:330,fontSize:36,originX:'left',originY:'top'});
    window.c.add(t);window.c.fire('path:created',{path:t});window.c.fire('text:editing:entered',{target:t});window.textId=t.boardObjectId;window.c.fire('text:editing:exited',{target:t});});
  await page.waitForFunction(()=>window.book().getPageObjects().length===3&&window.object(window.textId)?.type==='image');await committed(record,3);
  assert.equal(await page.evaluate(()=>window.unmasked(window.object(window.textId))&&window.book().getPageObjects().every(window.unmasked)),true);
  await page.getByRole('button',{name:/Отменить —/}).click();await page.waitForFunction(()=>window.object(window.textId)?.type==='textbox');
  assert.equal(await page.evaluate(()=>window.object(window.textId).text),'MMMMMMMM');
  await page.getByRole('button',{name:/Вернуть —/}).click();await page.waitForFunction(()=>window.object(window.textId)?.type==='image');await committed(record,3);
  results.push({name:stage,croppedBitmaps:true,editableOriginalOnUndo:true});
  stage='persisted reload';
  await page.reload();await bind();await page.waitForFunction(()=>window.book()?.getPageObjects().length===3);
  assert.equal(await page.evaluate(()=>window.book().getPageObjects().every(window.unmasked)&&window.c.getObjects().filter(o=>o!==window.book()&&!o.transientPreview).every(window.unmasked)),true);
  await page.screenshot({path:`${out}/${engine}-fragments.png`});
  results.push({name:stage,realStoredFragments:true});assert.deepEqual(errors,[]);
} catch(error) {
  await page?.screenshot({path:`${out}/${engine}-failure.png`}).catch(()=>{});
  await writeFile(`${out}/${engine}-failure.json`,JSON.stringify({stage,error:error.stack,errors,results,
    state:await page?.evaluate(()=>({text:document.body.innerText,objects:window.c?.getObjects().map(o=>({id:o.boardObjectId,type:o.type,width:o.width,height:o.height,left:o.left,top:o.top,mask:!!o.clipPath})),book:window.book?.()?.getPageObjects().map(o=>({type:o.type,width:o.width,height:o.height,mask:!!o.clipPath}))})).catch(()=>null)},null,2));
  throw error;
} finally {
  await writeFile(`${out}/${engine}.json`,JSON.stringify({engine,stage,results,errors},null,2));await context?.close();server.kill();await rm(profile,{recursive:true,force:true});
}
console.log(JSON.stringify({engine,results,errors},null,2));
