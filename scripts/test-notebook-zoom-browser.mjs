import { chromium, webkit } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { notebookAuditEntryState } from './notebook-audit-metrics.js';
const name=process.env.VERIFICATION_BROWSER==='webkit'?'webkit':'chromium';
const port=5272,base=`http://127.0.0.1:${port}/alex/`,output='notebook-zoom-results';
const server=spawn(process.execPath,['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port',String(port),'--strictPort'],
  {stdio:'ignore',env:{...process.env,VITE_NOTEBOOK_OPERATIONS_V1:'true'}});
let browser,page;const report={name,commit:process.env.GITHUB_SHA,results:[],errors:[],limitations:['No physical iPad or Pencil timing. Intermediate zoom pixels are interpolated; settled/export pixels must be exact.']};
try{
 await mkdir(output,{recursive:true});let ready=false;
 for(let i=0;i<150;i++){try{if((await fetch(base)).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}
 assert.ok(ready,'Vite did not start');
 browser=await(name==='webkit'?webkit:chromium).launch({headless:true,...(name==='chromium'?{args:['--no-sandbox'],...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{})}:{})});
 page=await browser.newPage({viewport:{width:1100,height:850},deviceScaleFactor:2});page.on('pageerror',e=>report.errors.push(e.message));
 await page.goto(base+'scripts/board-media-fixture.html');
 report.results=await page.evaluate(async()=> (await import('/alex/scripts/notebook-zoom-fixture.js')).runNotebookZoomCases());
 assert.equal(report.results.length,10);for(const item of report.results)assert.equal(item.error,undefined,JSON.stringify(item));
 const board=await page.evaluate(async()=>{
  const {createBoard}=await import('/alex/src/lib/boardRepository.js');
  const {saveAuthoritySnapshot}=await import('/alex/src/lib/browserAuthorityStore.js');
  const {makeAuditSnapshot}=await import('/alex/scripts/notebook-audit-metrics.js');
  const b=await createBoard('Viewport quality regression');await saveAuthoritySnapshot(b.boardId,makeAuditSnapshot({pageStrokes:100}),0);return b;
 });
 await page.goto(`${base}board/${board.boardId}?key=${board.ownerKey}`);
 await page.waitForFunction(notebookAuditEntryState,undefined,{timeout:90000});
 const gate=page.getByRole('textbox',{name:'Ваше имя'});
 if(await gate.count()){await gate.fill('Zoom tester');await page.getByRole('button',{name:'Войти на доску',exact:true}).click();}
 await page.waitForFunction(()=>{
  let fiber=document.querySelector('.toolbar-shell');fiber=fiber?.[Object.keys(fiber).find(k=>k.startsWith('__reactFiber'))];
  while(fiber&&fiber.type?.name!=='BoardWorkspace')fiber=fiber.return;
  for(let hook=fiber?.memoizedState;hook;hook=hook.next){const value=hook.memoizedState?.current;
   if(value?.getObjects&&value?.getZoom)window.zoomTestCanvas=value;
   if(value?.capture&&value?.ensure)window.zoomTestHandlers=value;
  }
  if(window.zoomEnsureError)throw Error(window.zoomEnsureError);
  if(window.zoomTestHandlers&&!window.zoomEnsurePending&&!window.zoomTestController){
   window.zoomEnsurePending=true;
   window.zoomTestHandlers.ensure().then(value=>{window.zoomTestController=value;},error=>{window.zoomEnsureError=error.message;})
     .finally(()=>{window.zoomEnsurePending=false;});
  }
  return !!window.zoomTestController&&!!window.zoomTestCanvas?._objects?.some(b=>b.boardObjectId==='audit-notebook')
    &&document.documentElement.dataset.alexDurableEditState==='ready';
 },undefined,{timeout:90000});
 report.ui=await page.evaluate(async()=>{
  const c=window.zoomTestCanvas,b=c._objects.find(o=>o.boardObjectId==='audit-notebook');c.renderAll();
  const source=JSON.stringify(b.notebookPages),initialZoom=c.getZoom();let renders=0;
  for(const child of b._objects){const render=child.render;child.render=function(...args){renders++;return render.apply(this,args);};}
  const r=c.upperCanvasEl.getBoundingClientRect();
  for(let i=0;i<24;i++){
   c.upperCanvasEl.dispatchEvent(new WheelEvent('wheel',{deltaY:-1,clientX:r.left+350,clientY:r.top+330,bubbles:true,cancelable:true}));
   c.cancelRequestedRender();c.renderAll();
  }
  const during=renders;if(!(c.getZoom()>initialZoom))throw Error('Native Board wheel did not change viewport');
  if(during!==0)throw Error(`Native Board wheel redrew ${during} old children`);
  await new Promise(resolve=>setTimeout(resolve,300));c.renderAll();
  if(renders!==100)throw Error(`Native Board did not refine exactly once: ${renders}`);
  if(JSON.stringify(b.notebookPages)!==source)throw Error('Viewport mutated source records');
  const ctx=c.getContext(),w=c.lowerCanvasEl.width,h=c.lowerCanvasEl.height;
  const actual=new Uint8ClampedArray(ctx.getImageData(0,0,w,h).data);b.dirty=true;c.renderAll();const expected=ctx.getImageData(0,0,w,h).data;
  let differences=0;for(let i=0;i<actual.length;i++)if(actual[i]!==expected[i])differences++;
  if(differences)throw Error(`Native UI settled pixels differ: ${differences}`);
  const {notebookRenderCacheFor}=await import('/alex/src/lib/notebookRenderCache.js');
  return {steps:24,oldRendersDuringZoom:during,quietOldRenders:100,pixelMismatch:differences,sourceUnchanged:true,
    retainedBytes:notebookRenderCacheFor(c).bytesUsed(),pageBytes:b._cacheCanvas.width*b._cacheCanvas.height*4};
 });
 assert.deepEqual(report.errors,[]);await page.screenshot({path:`${output}/${name}-settled.png`});
 console.log(`${name}: 10 viewport quality/lifecycle cases plus actual Board wheel, exact settled pixels and unchanged records passed`);
}catch(error){report.failure=error.stack??error.message;throw error;}
finally{await writeFile(`${output}/${name}.json`,JSON.stringify(report,null,2));await browser?.close();server.kill();}
