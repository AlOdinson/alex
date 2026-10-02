import {chromium,webkit} from 'playwright-core';
import {spawn} from 'node:child_process';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const server=spawn(process.execPath,['node_modules/vite/bin/vite.js','--host','127.0.0.1'],{stdio:'ignore'});
const engine=process.env.VERIFICATION_BROWSER==='webkit'?webkit:chromium;
const profile=await mkdtemp(join(tmpdir(),'alex-notebook-'));
const browser=await engine.launchPersistentContext(profile,{headless:true,viewport:{width:1100,height:850},...(engine===chromium&&process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{}),...(engine===chromium?{args:['--no-sandbox']}:{})});
try{
 const page=await browser.newPage();page.on('pageerror',e=>console.error('APP',e.message));page.on('console',m=>{if(m.type()==='error')console.error('BROWSER',m.text());});
 for(let i=0;i<100;i++){try{if((await fetch('http://127.0.0.1:5173/alex/')).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
 await page.goto('http://127.0.0.1:5173/alex/scripts/board-media-fixture.html');
 const board=await page.evaluate(async()=>{const {createBoard}=await import('/alex/src/lib/boardRepository.js');return createBoard('Notebook regression');});
 await page.goto(`http://127.0.0.1:5173/alex/board/${board.boardId}?key=${board.ownerKey}`);
 await page.waitForTimeout(1500);
 if(await page.getByRole('textbox',{name:'Ваше имя'}).count()){await page.getByRole('textbox',{name:'Ваше имя'}).fill('PDF tester');await page.getByRole('button',{name:'Войти на доску',exact:true}).click();}
 await page.waitForFunction(()=>document.documentElement.dataset.alexDurableEditState==='ready'&&document.documentElement.dataset.alexDurableEditBlocked!=='true');
 await page.getByRole('button',{name:'Блокнот',exact:true}).click();
 await page.locator('.notebook-page-controls').waitFor();
 await page.evaluate(()=>{
  let f=document.querySelector('.toolbar-shell');f=f[Object.keys(f).find(k=>k.startsWith('__reactFiber'))];
  while(f&&f.type?.name!=='BoardWorkspace')f=f.return;
  window.boardFiber=f;
  for(let h=f.memoizedState;h;h=h.next){const v=h.memoizedState?.current;if(v?.getObjects&&v?.getZoom){window.testCanvas=v;break;}}
  window.toolbar=()=>{let f=document.querySelector('.toolbar-shell');f=f[Object.keys(f).find(k=>k.startsWith('__reactFiber'))];while(f&&!f.memoizedProps?.onAddNotebook)f=f.return;return f.memoizedProps;};
  window.notebook=()=>window.testCanvas.getObjects().find(o=>o.type==='boardnotebook');
 });
 assert.equal(await page.locator('.notebook-page-controls button').count(),1);
 await page.evaluate(async()=>{
  const {Path}=await import('/alex/node_modules/.vite/deps/fabric.js');
  const n=window.notebook(),p=n.getBoundingRect();
  const path=new Path(`M ${p.left+30} ${p.top+60} L ${p.left+140} ${p.top+90}`,{stroke:'red',strokeWidth:6,fill:null});
  window.testCanvas.add(path);window.testCanvas.fire('path:created',{path});
 });
 await page.waitForFunction(()=>window.notebook()?.getPageObjects().length===1);
 await page.waitForTimeout(800);
 await page.evaluate(()=>{const c=window.testCanvas;c.setActiveObject(window.notebook());c.requestRenderAll();});
 await page.locator('.notebook-page-controls button[aria-label="Следующая страница"]').click();
 await page.waitForFunction(()=>window.notebook()?.notebookPageNumber===2);
 assert.equal(await page.evaluate(()=>window.notebook().getPageObjects().length),0);
 await page.locator('.notebook-page-controls button[aria-label="Предыдущая страница"]').click();
 await page.waitForFunction(()=>window.notebook()?.notebookPageNumber===1);
 assert.equal(await page.evaluate(()=>window.notebook().getPageObjects().length),1);
 await page.evaluate(()=>window.toolbar().onUndo());
 try {await page.waitForFunction(()=>window.notebook()?.getPageObjects().length===0);}
 catch(error){console.error('NOTEBOOK UNDO DIAGNOSTICS',await page.evaluate(async boardId=>{
   const {getBoardRuntime}=await import('/alex/src/lib/browserBoardRuntimeRegistry.js');
   const runtime=getBoardRuntime(boardId);return {status:document.querySelector('.toolbar-status')?.textContent,
     body:document.body.innerText,local:window.notebook()?.toObject(),authority:runtime.getSnapshot()};
 },board.boardId));throw error;}
 await page.evaluate(()=>window.toolbar().onRedo());
 await page.waitForFunction(()=>window.notebook()?.getPageObjects().length===1);
 // Whole text stays editable through the notebook editor.
 await page.evaluate(async()=>{
  const {Textbox}=await import('/alex/node_modules/.vite/deps/fabric.js');
  const c=window.testCanvas,n=window.notebook(),box=n.getBoundingRect();
  const text=new Textbox('Whole text',{left:box.left+30,top:box.top+120,width:150,fontSize:20,originX:'left',originY:'top'});
  c.add(text);c.fire('path:created',{path:text});c.fire('text:editing:entered',{target:text});
  c.fire('text:editing:exited',{target:text});
 });
 await page.waitForFunction(()=>window.notebook()?.getPageObjects().some(o=>o.text==='Whole text'));
 await page.waitForTimeout(400);
 await page.evaluate(()=>{window.testCanvas.setActiveObject(window.notebook());window.testCanvas.requestRenderAll();});
 await page.locator('.notebook-edit-text').click();
 await page.getByRole('dialog').getByRole('textbox').fill('Edited whole text');
 await page.getByRole('dialog').getByRole('button',{name:'Сохранить',exact:true}).click();
 await page.waitForFunction(()=>window.notebook()?.getPageObjects().some(o=>o.text==='Edited whole text'));
 await page.waitForTimeout(500);
 // Boundary text becomes images; undo restores the editable source with no fragment.
 await page.evaluate(async()=>{
  const {Textbox}=await import('/alex/node_modules/.vite/deps/fabric.js');
  const c=window.testCanvas,n=window.notebook(),box=n.getBoundingRect();
  const text=new Textbox('Boundary text',{left:box.left-70,top:box.top+220,width:200,fontSize:24,originX:'left',originY:'top'});
  c.add(text);c.fire('path:created',{path:text});c.fire('text:editing:entered',{target:text});
  window.boundaryId=text.boardObjectId;c.fire('text:editing:exited',{target:text});
 });
 await page.waitForFunction(()=>window.notebook()?.getPageObjects().some(o=>o.type==='image'));
 assert.equal(await page.evaluate(()=>window.testCanvas.getObjects().find(o=>o.boardObjectId===window.boundaryId)?.type),'image');
 await page.waitForTimeout(500);
 await page.evaluate(()=>window.toolbar().onUndo());
 await page.waitForFunction(()=>window.testCanvas.getObjects().find(o=>o.boardObjectId===window.boundaryId)?.type==='textbox');
 assert.equal(await page.evaluate(()=>window.notebook().getPageObjects().filter(o=>o.type==='image').length),0);
 await page.evaluate(()=>window.toolbar().onRedo());
 await page.waitForFunction(()=>window.testCanvas.getObjects().find(o=>o.boardObjectId===window.boundaryId)?.type==='image');
 await page.waitForTimeout(500);
 // Object eraser removes page ink, never the notebook frame.
 const inkPoint=await page.evaluate(()=>{
  const c=window.testCanvas,n=window.notebook(),p=n.getBoundingRect();
  window.toolbar().setTool('eraser');
  const v=c.viewportTransform,r=c.upperCanvasEl.getBoundingClientRect();
  return {x:r.left+(p.left+85)*v[0]+v[4],y:r.top+(p.top+75)*v[3]+v[5]};
 });
 await page.mouse.click(inkPoint.x,inkPoint.y);
 await page.waitForTimeout(500);
 await page.waitForFunction(()=>window.notebook()?.getPageObjects().length===2);
 await page.evaluate(()=>window.toolbar().onUndo());
 await page.waitForFunction(()=>window.notebook()?.getPageObjects().length===3);
 await page.evaluate(()=>window.toolbar().setTool('select'));
 // Initial image placement remains whole, even when overlapping the notebook.
 const png=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=100;c.height=80;c.getContext('2d').fillRect(0,0,100,80);return c.toDataURL().split(',')[1];});
 await page.locator('input[type=file][accept*="application/pdf"]').setInputFiles({name:'square.png',mimeType:'image/png',buffer:Buffer.from(png,'base64')});
 await page.waitForFunction(()=>window.testCanvas.getObjects().some(o=>o.type==='image'&&o.storagePath));
 assert.equal(await page.evaluate(()=>window.notebook().getPageObjects().length),3);
 const inserted=await page.evaluate(()=>{
  const c=window.testCanvas,o=c.getObjects().find(o=>o.type==='image'&&o.storagePath);window.insertedImageId=o.boardObjectId;
  if(o.clipPath)throw Error('Initial image was clipped');c.setActiveObject(o);c.requestRenderAll();
  const point=o.getCenterPoint(),v=c.viewportTransform,r=c.upperCanvasEl.getBoundingClientRect();
  return {x:r.left+point.x*v[0]+point.y*v[2]+v[4],y:r.top+point.x*v[1]+point.y*v[3]+v[5]};
 });
 // Capture happens through a subsequent native drag/release, not file insertion.
 await page.mouse.move(inserted.x,inserted.y);await page.mouse.down();
 await page.waitForFunction(()=>window.testCanvas._currentTransform&&!window.testCanvas._currentTransform.target.lockMovementX);
 await page.mouse.move(inserted.x+20,inserted.y+15,{steps:8});await page.mouse.up();
 await page.waitForFunction(()=>window.notebook()?.getPageObjects().length===4);
 assert.equal(await page.evaluate(()=>window.testCanvas.getObjects().some(o=>o.boardObjectId===window.insertedImageId)),false);
 await page.locator('input[type=file][accept*="application/pdf"]').setInputFiles('scripts/fixtures/media/animated.gif');
 await page.waitForFunction(()=>window.testCanvas.getObjects().some(o=>o.mediaKind==='gif'));
 assert.equal(await page.evaluate(()=>window.notebook().getPageObjects().length),4);
 await page.waitForTimeout(500);
 // Only diagonal handles are offered and a real drag preserves aspect ratio.
 const resize=await page.evaluate(()=>{
  const c=window.testCanvas,n=window.notebook();c.setActiveObject(n);n.setCoords();c.requestRenderAll();
  const r=c.upperCanvasEl.getBoundingClientRect();
  return {x:r.left+n.oCoords.br.x,y:r.top+n.oCoords.br.y,ratio:n.scaleX/n.scaleY,
    sides:['ml','mr','mt','mb','mtr'].map(key=>n.isControlVisible(key))};
 });
 assert.deepEqual(resize.sides,[false,false,false,false,false]);
 await page.waitForTimeout(300);
 await page.mouse.move(resize.x,resize.y);await page.mouse.down();
 await page.mouse.move(resize.x-65,resize.y-45,{steps:8});await page.mouse.up();
 await page.waitForTimeout(600);
 assert.ok(await page.evaluate(r=>Math.abs(window.notebook().scaleX/window.notebook().scaleY-r)<0.0001,resize.ratio));
 await page.reload();
 await page.waitForFunction(()=>document.documentElement.dataset.alexDurableEditState==='ready');
 await page.waitForTimeout(800);
 await page.evaluate(()=>{
  let f=document.querySelector('.toolbar-shell');f=f[Object.keys(f).find(k=>k.startsWith('__reactFiber'))];
  while(f&&f.type?.name!=='BoardWorkspace')f=f.return;
  for(let h=f.memoizedState;h;h=h.next){const v=h.memoizedState?.current;if(v?.getObjects&&v?.getZoom){window.testCanvas=v;break;}}
 });
 assert.equal(await page.evaluate(()=>window.testCanvas.getObjects().find(o=>o.type==='boardnotebook')?.getPageObjects().length),4);
 // Install a confirmed remote page change through the production reconciliation
 // path, including a hidden static image. This must hydrate the selected page.
 await page.evaluate(async boardId=>{
  let f=document.querySelector('.toolbar-shell');f=f[Object.keys(f).find(k=>k.startsWith('__reactFiber'))];
  while(f&&f.type?.name!=='BoardWorkspace')f=f.return;
  let apply;for(let h=f.memoizedState;h;h=h.next){const v=h.memoizedState?.current;if(typeof v==='function'&&String(v).includes('const incomingRevision')&&String(v).includes('authoritativeApplyQueueRef')){apply=v;break;}}
  if(!apply)throw Error('Missing authoritative apply handler');
  const {getBoardRuntime}=await import('/alex/src/lib/browserBoardRuntimeRegistry.js');
  const runtime=getBoardRuntime(boardId),n=window.testCanvas.getObjects().find(o=>o.type==='boardnotebook');
  const pages=n.serializeNotebookForSnapshot().notebookPages;
  pages[1]=[structuredClone(pages[0].find(o=>o.type==='Image'))];
  const ops=[{type:'patch',id:n.boardObjectId,patch:{notebookPages:pages,notebookPageNumber:2},updatedAt:Date.now(),updatedBy:'remote'}];
  const outcome=await runtime.commitTeacherAction({actionId:'notebook-remote-page',baseRevision:runtime.getRevision(),ops});
  await apply(outcome.appliedOps,outcome.revision,false,null,outcome.actionId,'remote');
 },board.boardId);
 await page.waitForFunction(()=>window.testCanvas.getObjects().find(o=>o.type==='boardnotebook')?.notebookPageNumber===2);
 assert.equal(await page.evaluate(()=>window.testCanvas.getObjects().find(o=>o.type==='boardnotebook')?.getPageObjects()[0]?.type),'image');
 console.log('Notebook creation, capture, pages, undo/redo and reload passed');
}finally{await browser.close();server.kill();await rm(profile,{recursive:true,force:true});}
