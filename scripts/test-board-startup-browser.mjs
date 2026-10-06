import { chromium, webkit } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { notebookAuditEntryState } from './notebook-audit-metrics.js';
const name=process.env.VERIFICATION_BROWSER==='webkit'?'webkit':'chromium';
const port=5284,base=`http://127.0.0.1:${port}/alex/`,output='board-startup-results';
const server=spawn(process.execPath,['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port',String(port),'--strictPort'],
 {stdio:'ignore',env:{...process.env,VITE_NOTEBOOK_OPERATIONS_V1:'true'}});
let browser,page;const report={name,commit:process.env.GITHUB_SHA,results:[],errors:[],limitations:[
 'Cold model clone/indexing and final native installation remain indivisible. Not a physical Pencil latency benchmark.',
 'The test wraps the loader for observation only; construction, persistence and input remain production code.',
]};
try{
 await mkdir(output,{recursive:true});let ready=false;
 for(let i=0;i<150;i++){try{if((await fetch(base)).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}
 assert.ok(ready,'Vite did not start');
 browser=await(name==='webkit'?webkit:chromium).launch({headless:true,...(name==='chromium'?{args:['--no-sandbox'],...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{})}:{})});
 page=await browser.newPage({viewport:{width:1100,height:850},deviceScaleFactor:2});page.on('pageerror',e=>report.errors.push(e.message));
 await page.goto(base+'scripts/board-media-fixture.html');
 report.results=await page.evaluate(async()=>(await import('/alex/scripts/board-startup-fixture.js')).runBoardStartupCases());
 assert.equal(report.results.length,7);for(const item of report.results)assert.equal(item.error,undefined,JSON.stringify(item));
 // Read Vite's resolved module so its Fabric import is not replaced by a test
 // implementation. The wrapper records task ordering without holding a gate.
 await page.route(/\/src\/lib\/boardLoadPreparation\.js(?:\?.*)?$/,async route=>{
  const response=await route.fetch();let body=await response.text();
  assert.ok(body.includes('export async function loadBoardCanvasJson('),'loader observation anchor missing');
  body=body.replace('export async function loadBoardCanvasJson(','export async function startupOriginalLoad(')+`
export async function loadBoardCanvasJson(canvas, source, options) {
 const probe={sourceObjects:source?.objects?.length??0,complete:false,taskBeforeComplete:false};
 (globalThis.__startupProbes??=[]).push(probe);globalThis.__startupCanvas=canvas;
 setTimeout(()=>{probe.taskBeforeComplete=!probe.complete;probe.objectsAtTask=canvas._objects.length;probe.drawingEnabledBeforeReady=Boolean(canvas.isDrawingMode);},0);
 const result=await startupOriginalLoad(canvas,source,options);probe.complete=true;probe.installed=canvas._objects.length;return result;
}
`;
  await route.fulfill({response,body,contentType:'text/javascript'});
 });
 await page.addInitScript(()=>{
  const original=window.setInterval;window.__startupMaintenance=[];
  window.setInterval=function(work,ms,...args){if(ms===1500&&typeof work==='function'&&work.toString().includes('staleDrawPreviewIds'))window.__startupMaintenance.push(work);return original.call(this,work,ms,...args);};
 });
 const board=await page.evaluate(async()=>{
  const {createBoard}=await import('/alex/src/lib/boardRepository.js');
  const {saveAuthoritySnapshot}=await import('/alex/src/lib/browserAuthorityStore.js');
  const {makeAuditSnapshot}=await import('/alex/scripts/notebook-audit-metrics.js');
  const board=await createBoard('Cold startup regression');
  await saveAuthoritySnapshot(board.boardId,makeAuditSnapshot({boardObjects:1200,pages:6,pageStrokes:100,points:6}),0);return board;
 });
 const url=`${base}board/${board.boardId}?key=${board.ownerKey}`;
 await page.goto(url);await page.waitForFunction(notebookAuditEntryState,undefined,{timeout:90000});
 const gate=page.getByRole('textbox',{name:'Ваше имя'});
 if(await gate.count()){await gate.fill('Startup tester');await page.getByRole('button',{name:'Войти на доску',exact:true}).click();}
 await page.waitForFunction(()=>globalThis.__startupProbes?.some(p=>p.complete&&p.sourceObjects===1201)
  &&document.documentElement.dataset.alexDurableEditState==='ready'&&document.documentElement.dataset.alexDurableEditBlocked!=='true',undefined,{timeout:90000});
 report.startup=await page.evaluate(()=>{
  const p=globalThis.__startupProbes.find(p=>p.complete&&p.sourceObjects===1201);
  const c=globalThis.__startupCanvas,b=c._objects.find(o=>o.boardObjectId==='audit-notebook');
  return{...p,livePageChildren:b._objects.length,pageNumber:b.notebookPageNumber,pages:b.notebookPages.length};
 });
 assert.equal(report.startup.taskBeforeComplete,true);assert.equal(report.startup.installed,1201);
 assert.equal(report.startup.drawingEnabledBeforeReady,false,'editing enabled before cold scene installation');
 assert.equal(report.startup.livePageChildren,100);assert.equal(report.startup.pages,6);assert.equal(report.startup.pageNumber,6);
 report.maintenance=await page.evaluate(()=>{
  const c=globalThis.__startupCanvas,old=c.getObjects;let reads=0;c.getObjects=function(...args){reads++;return old.apply(this,args);};
  try{if(globalThis.__startupMaintenance.length!==1)throw Error('actual maintenance callback not found');globalThis.__startupMaintenance[0]();return{fullSceneReads:reads};}
  finally{c.getObjects=old;}
 });
 assert.equal(report.maintenance.fullSceneReads,0);
 // Do not warm the notebook controller: this first real stroke exercises its
 // existing cold initialization path after the complete scene becomes ready.
 await page.getByRole('button',{name:'Карандаш',exact:true}).click();
 const point=await page.evaluate(()=>{const c=globalThis.__startupCanvas,b=c._objects.find(o=>o.boardObjectId==='audit-notebook').getBoundingRect(),r=c.upperCanvasEl.getBoundingClientRect(),v=c.viewportTransform;
  return{x:r.left+(b.left+100)*v[0]+v[4],y:r.top+(b.top+b.height*.65)*v[3]+v[5],zoom:c.getZoom()};});
 assert.ok(await page.evaluate(({x,y})=>document.elementFromPoint(x,y)===globalThis.__startupCanvas.upperCanvasEl,point),'first stroke covered by controls');
 await page.mouse.move(point.x,point.y);await page.mouse.down();await page.mouse.move(point.x+45*point.zoom,point.y+4*point.zoom,{steps:8});await page.mouse.up();
 await page.waitForFunction(()=>globalThis.__startupCanvas._objects.find(o=>o.boardObjectId==='audit-notebook')?._objects.length===101,undefined,{timeout:30000});
 await page.waitForFunction(()=>{
  let f=document.querySelector('.toolbar-shell');f=f?.[Object.keys(f).find(k=>k.startsWith('__reactFiber'))];while(f&&f.type?.name!=='BoardWorkspace')f=f.return;
  for(let h=f?.memoizedState;h;h=h.next){const v=h.memoizedState?.current;if(v?.capture&&v?.ensure)globalThis.__startupHandlers=v;}
  return !!globalThis.__startupHandlers;
 },undefined,{timeout:30000});
 await page.evaluate(async()=>{const c=await globalThis.__startupHandlers.ensure();if(!c)throw Error('no controller after first stroke');await c.flush();});
 await page.reload();await page.waitForFunction(()=>globalThis.__startupCanvas?._objects.find(o=>o.boardObjectId==='audit-notebook')?._objects.length===101,undefined,{timeout:90000});
 report.firstStroke={childrenAfterReload:101,retained:true};
 assert.deepEqual(report.errors,[]);await page.screenshot({path:`${output}/${name}-loaded.png`});
 console.log(`${name}: 7 startup cases, real 1201-object lesson load, maintenance, first stroke and reload passed`);
}catch(error){report.failure=error.stack??error.message;try{report.uiText=await page?.locator('body').innerText();await page?.screenshot({path:`${output}/${name}-failure.png`});}catch{}throw error;}
finally{await writeFile(`${output}/${name}.json`,JSON.stringify(report,null,2));await browser?.close();server.kill();}
