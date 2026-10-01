import {chromium,webkit} from 'playwright-core';
import {spawn} from 'node:child_process';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const server=spawn(process.execPath,['node_modules/vite/bin/vite.js','--host','127.0.0.1'],{stdio:'ignore'});
const engine=process.env.VERIFICATION_BROWSER==='webkit'?webkit:chromium;
const profile=await mkdtemp(join(tmpdir(),'alex-pdf-continuity-'));
const browser=await engine.launchPersistentContext(profile,{headless:true,viewport:{width:1100,height:850},...(engine===chromium&&process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{}),...(engine===chromium?{args:['--no-sandbox']}:{})});
try{
 const page=await browser.newPage();page.on('pageerror',e=>console.error('APP',e.message));page.on('console',m=>{if(m.type()==='error')console.error('BROWSER',m.text());});
 for(let i=0;i<100;i++){try{if((await fetch('http://127.0.0.1:5173/alex/')).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
 await page.goto('http://127.0.0.1:5173/alex/scripts/board-media-fixture.html');
 const board=await page.evaluate(async()=>{const {createBoard}=await import('/alex/src/lib/boardRepository.js');return createBoard('PDF continuity');});
 await page.goto(`http://127.0.0.1:5173/alex/board/${board.boardId}?key=${board.ownerKey}`);
 await page.waitForTimeout(1500);
 if(await page.getByRole('textbox',{name:'Ваше имя'}).count()){await page.getByRole('textbox',{name:'Ваше имя'}).fill('PDF tester');await page.getByRole('button',{name:'Войти на доску',exact:true}).click();}
 await page.waitForFunction(()=>document.documentElement.dataset.alexDurableEditState==='ready'&&document.documentElement.dataset.alexDurableEditBlocked!=='true');
 await page.evaluate(()=>{
  const put=IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put=function(...args){
   try{const request=put.apply(this,args);request.addEventListener('error',()=>console.error('IDB PUT',this.name,request.error?.name,request.error?.message));return request;}
   catch(error){console.error('IDB PUT',this.name,error.name,error.message);throw error;}
  };
 });
 await page.locator('input[type=file][accept*="application/pdf"]').setInputFiles(process.env.MEDIA_TEST_PDF_PATH||'scripts/fixtures/media/pages.pdf');
 try{await page.locator('.pdf-page-controls').waitFor();}catch(error){
  console.error('PDF INSERT DIAGNOSTICS',await page.evaluate(()=>({status:document.querySelector('.toolbar-status')?.textContent,body:document.body.innerText,durable:{...document.documentElement.dataset}})));
  await mkdir('connection-direct-results',{recursive:true});await page.screenshot({path:`connection-direct-results/pdf-insert-${process.env.VERIFICATION_BROWSER||'chromium'}.png`});throw error;
 }
 await page.evaluate(()=>{
  let f=document.querySelector('.toolbar-shell');f=f[Object.keys(f).find(k=>k.startsWith('__reactFiber'))];
  while(f&&f.type?.name!=='BoardWorkspace')f=f.return;
  for(let h=f.memoizedState;h;h=h.next){const v=h.memoizedState?.current;if(v?.getObjects&&v?.getZoom){window.testCanvas=v;break;}}
  if(!window.testCanvas)throw Error('Missing canvas');
 });
 await page.waitForFunction(()=>window.testCanvas.getObjects().some(o=>o.mediaKind==='pdf'&&o.getElement()?.width>1));
 await page.waitForTimeout(1500);
 await page.evaluate(()=>{
  const c=window.testCanvas;window.pdfId=c.getObjects().find(o=>o.mediaKind==='pdf').boardObjectId;window.pdfEvents=[];window.blankFrames=[];
  for(const event of ['object:removed','object:added','media:ready'])c.on(event,({target:o})=>{if(o?.boardObjectId===window.pdfId)window.pdfEvents.push({event,pending:o.pendingImage,kind:o.mediaKind,w:o.getElement?.()?.width,stack:event==='object:removed'?new Error().stack:undefined});});
  c.on('after:render',()=>{const o=c.getObjects().find(o=>o.boardObjectId===window.pdfId);if(!o||!o.getElement||o.getElement()?.width<=1)window.blankFrames.push({missing:!o,pending:o?.pendingImage,kind:o?.mediaKind,w:o?.getElement?.()?.width});});
 });
 // The entire PDF panel must keep its proportions relative to the document during zoom.
 const controlSize=()=>page.locator('.pdf-page-controls').boundingBox();
 await mkdir('connection-direct-results',{recursive:true});
 const screenshot=percent=>page.screenshot({path:`connection-direct-results/pdf-controls-${process.env.VERIFICATION_BROWSER||'chromium'}-${percent}.png`});
 const originalControls=await controlSize();
 await screenshot(100);
 await page.evaluate(()=>{window.testCanvas.setZoom(0.6);window.testCanvas.requestRenderAll();});
 await page.waitForTimeout(150);
 const zoomedControls=await controlSize();
 await screenshot(60);
 assert.ok(zoomedControls.width<originalControls.width,'Zooming out must fit the panel to the visible PDF width');
 const visiblePdfWidth=await page.evaluate(()=>window.testCanvas.getActiveObject().getBoundingRect().width*window.testCanvas.getZoom());
 assert.ok(Math.abs(zoomedControls.width-Math.min(400*0.6,visiblePdfWidth))<1,'Panel must follow the on-screen PDF width');
 assert.ok(Math.abs(zoomedControls.height-originalControls.height*0.6)<1,'Entire panel must shrink with board zoom');
 await page.evaluate(()=>{const c=window.testCanvas,o=c.getActiveObject();c.discardActiveObject();c.setZoom(0.1);c.setActiveObject(o);c.requestRenderAll();});
 await page.waitForTimeout(150);
 const tiny=await page.evaluate(()=>{const c=window.testCanvas,p=document.querySelector('.pdf-page-controls');return {panel:p.getBoundingClientRect().width,pdf:c.getActiveObject().getBoundingRect().width*c.getZoom(),button:p.querySelector('button').getBoundingClientRect().width};});
 await screenshot(10);
 assert.ok(Math.abs(tiny.panel-tiny.pdf)<1,'Selecting after zoom-out must not leave a wide panel');
 assert.ok(Math.abs(tiny.button-3.2)<0.1,'Buttons must shrink at 10% zoom instead of growing relative to the PDF');
 await page.evaluate(()=>{window.testCanvas.setZoom(2);window.testCanvas.requestRenderAll();});
 await page.waitForTimeout(150);
 const below=await page.evaluate(()=>{const c=window.testCanvas,b=c.getActiveObject().getBoundingRect(),v=c.viewportTransform;return {actual:parseFloat(document.querySelector('.pdf-page-controls').style.top),expected:v[1]*(b.left+b.width/2)+v[3]*(b.top+b.height)+v[5]+16};});
 assert.ok(Math.abs(below.actual-below.expected)<0.01,'Panel must stay below PDF even beyond the viewport edge');
 await page.evaluate(()=>{const c=window.testCanvas,o=c.getActiveObject();window.pdfOriginalScale={scaleX:o.scaleX,scaleY:o.scaleY};o.set({scaleX:o.scaleX/2,scaleY:o.scaleY/2});o.setCoords();c.requestRenderAll();});
 await page.waitForTimeout(150);
 const resizedControls=await controlSize();
 const resizedPdfWidth=await page.evaluate(()=>window.testCanvas.getActiveObject().getBoundingRect().width*window.testCanvas.getZoom());
 assert.ok(Math.abs(resizedControls.width-Math.min(800,resizedPdfWidth))<1,'Resizing the document must resize its slider');
 assert.ok(Math.abs(resizedControls.height-originalControls.height*2)<1,'Panel height follows 200% viewport zoom');
 await page.evaluate(()=>{const c=window.testCanvas,o=c.getActiveObject();o.set(window.pdfOriginalScale);o.setCoords();c.setZoom(1);c.requestRenderAll();});
 await page.waitForTimeout(150);
 // Draw and undo a neighbouring line through the real toolbar handlers.
 await page.evaluate(()=>{
  let f=document.querySelector('.toolbar-shell');f=f[Object.keys(f).find(k=>k.startsWith('__reactFiber'))];while(f&&f.type?.name!=='Toolbar')f=f.return;window.toolbarProps=()=>{let n=document.querySelector('.toolbar-shell');let q=n[Object.keys(n).find(k=>k.startsWith('__reactFiber'))];while(q&&q.type?.name!=='Toolbar')q=q.return;return q.memoizedProps;};f.memoizedProps.setTool('pencil');
 });
 await page.mouse.move(850,330);await page.mouse.down();await page.mouse.move(900,380,{steps:15});await page.mouse.up();await page.waitForTimeout(1200);
 await page.evaluate(()=>window.toolbarProps().onUndo());await page.waitForTimeout(1200);
 // Delete/undo/redo a neighbouring PDF without disturbing the tracked document.
 await page.locator('input[type=file][accept*="application/pdf"]').setInputFiles('scripts/fixtures/media/pages.pdf');
 await page.waitForFunction(()=>window.testCanvas.getObjects().filter(o=>o.mediaKind==='pdf'&&o.getElement()?.width>1).length===2);
 await page.waitForFunction(()=>{const o=window.testCanvas.getActiveObject();return o?.mediaKind==='pdf'&&o.boardObjectId!==window.pdfId;});
 await page.evaluate(()=>window.toolbarProps().onDelete());await page.waitForTimeout(500);
 await page.evaluate(()=>window.toolbarProps().onUndo());await page.waitForTimeout(500);
 await page.evaluate(()=>window.toolbarProps().onRedo());await page.waitForTimeout(500);
 // Resize using a real Fabric control, committing via Board's object:modified path.
 await page.evaluate(()=>{window.toolbarProps().setTool('select');const c=window.testCanvas;c.setActiveObject(c.getObjects().find(o=>o.boardObjectId===window.pdfId));c.requestRenderAll();});
 const corner=await page.evaluate(()=>{const o=window.testCanvas.getActiveObject();o.setCoords();return {x:o.oCoords.br.x,y:o.oCoords.br.y};});
 await page.mouse.move(corner.x,corner.y);await page.mouse.down();await page.mouse.move(corner.x-100,corner.y-120,{steps:10});await page.mouse.up();await page.waitForTimeout(2200);
 // Pan and zoom both directions, keeping part of the PDF visible.
 await page.evaluate(()=>{const c=window.testCanvas;c.relativePan({x:60,y:30});c.requestRenderAll();});
 await page.mouse.move(500,400);await page.mouse.wheel(0,150);await page.waitForTimeout(1200);await page.mouse.wheel(0,-150);await page.waitForTimeout(1200);
 await page.evaluate(()=>window.testCanvas.discardActiveObject());await page.waitForTimeout(300);
 // Exercise the confirmed remote patch path used by history and reconciliation.
 await page.evaluate(async boardId=>{
  let n=document.querySelector('.toolbar-shell');let f=n[Object.keys(n).find(k=>k.startsWith('__reactFiber'))];while(f&&f.type?.name!=='BoardWorkspace')f=f.return;
  let apply;for(let h=f.memoizedState;h;h=h.next){const v=h.memoizedState?.current;if(typeof v==='function'&&String(v).includes('const incomingRevision')&&String(v).includes('authoritativeApplyQueueRef')){apply=v;break;}}
  if(!apply)throw Error('Missing authoritative apply handler');
  const {getBoardRuntime}=await import('/alex/src/lib/browserBoardRuntimeRegistry.js');
  const revision=getBoardRuntime(boardId).getRevision();
  const o=window.testCanvas.getObjects().find(o=>o.boardObjectId===window.pdfId);
  const applied=await apply([{type:'patch',id:o.boardObjectId,patch:{scaleX:o.scaleX*.8,scaleY:o.scaleY*.8},updatedAt:Date.now(),updatedBy:'remote'}],revision+1,false,null,'remote-pdf-transform','remote');
  if(!applied)throw Error('Remote patch did not apply');
 },board.boardId);
 await page.waitForTimeout(1500);
 const result=await page.evaluate(()=>({events:window.pdfEvents,blankFrames:window.blankFrames,loadCards:document.querySelectorAll('.media-load-status').length}));console.log(JSON.stringify(result,null,2));
 assert.equal(result.blankFrames.length,0,'Ready PDF must never become a placeholder during edits, undo, resize or navigation');
 // Real mouse clicks must pass through empty bounds to painted objects below.
 await page.evaluate(async()=>{
  const {Line,Rect,FabricImage}=await import('/alex/node_modules/fabric/dist/index.min.mjs');
  const c=window.testCanvas;c.discardActiveObject();c.setViewportTransform([1,0,0,1,0,0]);window.toolbarProps().setTool('select');
  const rear=new Rect({originX:'left',originY:'top',left:800,top:200,width:100,height:100,fill:'#2563eb',boardObjectId:'mouse-hit-rear'});
  const line=new Line([800,100,1000,400],{stroke:'#111',strokeWidth:4,fill:null,boardObjectId:'mouse-hit-line'});
  const outline=new Rect({originX:'left',originY:'top',left:780,top:120,width:230,height:300,fill:null,stroke:'#111',strokeWidth:3,boardObjectId:'mouse-hit-outline'});
  const bitmap=document.createElement('canvas');bitmap.width=100;bitmap.height=100;const ctx=bitmap.getContext('2d');ctx.fillStyle='#16a34a';ctx.fillRect(0,0,12,12);
  const image=new FabricImage(bitmap,{originX:'left',originY:'top',left:800,top:200,boardObjectId:'mouse-hit-image'});
  c.add(rear,image,line,outline);c.requestRenderAll();
  c.on('mouse:down',e=>{window.mouseHit=e.target?.boardObjectId||null;});
 });
 await page.waitForTimeout(150);
 await page.mouse.click(850,250);
 assert.equal(await page.evaluate(()=>window.mouseHit),'mouse-hit-rear','Mouse must select painted rear object through empty upper bounds');
 await page.mouse.click(980,200);
 assert.equal(await page.evaluate(()=>window.mouseHit),null,'Empty space inside object bounds is not a hit');
 await page.mouse.click(950,325);
 assert.equal(await page.evaluate(()=>window.mouseHit),'mouse-hit-line','Mouse must hit the line through the unfilled front rectangle');
 await page.waitForTimeout(500);
 await page.mouse.click(782,220);
 assert.equal(await page.evaluate(()=>window.mouseHit),'mouse-hit-outline','Painted outline remains selectable');
 await page.mouse.click(805,205);
 assert.equal(await page.evaluate(()=>window.mouseHit),'mouse-hit-image','Opaque image pixels remain selectable while transparent pixels pass through');
 assert.equal(await page.evaluate(()=>window.testCanvas.perPixelTargetFind),false,'Pixel probing must be restored after each click');
}finally{await browser.close();server.kill();await rm(profile,{recursive:true,force:true});}
