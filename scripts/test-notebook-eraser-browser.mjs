import { chromium, webkit } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { instrumentNotebookControllerSource, notebookAuditEntryState } from './notebook-audit-metrics.js';
const name=process.env.VERIFICATION_BROWSER==='webkit'?'webkit':'chromium';
const port=5241,base=`http://127.0.0.1:${port}/alex/`,output='notebook-eraser-results';
const server=spawn(process.execPath,['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port',String(port),'--strictPort'],
  {stdio:'ignore',env:{...process.env,VITE_NOTEBOOK_OPERATIONS_V1:'true'}});
let browser;
const report={name,commit:process.env.GITHUB_SHA,results:[],errors:[]};
try{
  await mkdir(output,{recursive:true});let ready=false;
  for(let i=0;i<150;i++){try{if((await fetch(base)).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}
  assert.ok(ready,'Vite did not start');
  browser=await(name==='webkit'?webkit:chromium).launch({headless:true,...(name==='chromium'?{args:['--no-sandbox'],
    ...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{})}:{})});
  const page=await browser.newPage({viewport:{width:1100,height:850},deviceScaleFactor:2});
  page.on('pageerror',e=>report.errors.push(e.message));
  await page.goto(base+'scripts/board-media-fixture.html');
  report.results=await page.evaluate(async()=>{const{runNotebookEraserCases}=await import('/alex/scripts/notebook-eraser-fixture.js');return runNotebookEraserCases();});
  assert.equal(report.results.length,7);
  for(const item of report.results)assert.equal(item.error,undefined,JSON.stringify(item));
  // Real UI pointer -> Board eraser -> durable authority -> undo/redo, not just
  // a direct reducer or helper invocation. Factory instrumentation only observes.
  const controllerSource=instrumentNotebookControllerSource(await readFile('src/lib/notebookBoardController.js','utf8'));
  await page.route(/\/src\/lib\/notebookBoardController\.js(?:\?.*)?$/,route=>route.fulfill({status:200,contentType:'text/javascript',body:controllerSource}));
  const board=await page.evaluate(async()=>{
    const{createBoard}=await import('/alex/src/lib/boardRepository.js');
    const{saveAuthoritySnapshot}=await import('/alex/src/lib/browserAuthorityStore.js');
    const{makeAuditSnapshot}=await import('/alex/scripts/notebook-audit-metrics.js');
    const{Rect}=await import('/alex/node_modules/.vite/deps/fabric.js');
    const snapshot=makeAuditSnapshot({pageStrokes:0}),book=snapshot.canvas.objects.at(-1);
    const rectangle=(id,left,top)=>new Rect({boardObjectId:id,left,top,width:18,height:18,originX:'center',originY:'center',fill:'black',strokeWidth:0}).toObject(['boardObjectId']);
    book.notebookPages=[[rectangle('warmup',-50,-40),rectangle('left-hit',-100,40),rectangle('right-hit',90,40),
      ...Array.from({length:1000},(_,i)=>rectangle(`far-${i}`,-190,-180))]];
    const board=await createBoard('Notebook eraser regression');await saveAuthoritySnapshot(board.boardId,snapshot,0);return board;
  });
  await page.goto(`${base}board/${board.boardId}?key=${board.ownerKey}`);
  await page.waitForFunction(notebookAuditEntryState,undefined,{timeout:90000});
  const gate=page.getByRole('textbox',{name:'Ваше имя'});
  if(await gate.count()){await gate.fill('Eraser tester');await page.getByRole('button',{name:'Войти на доску',exact:true}).click();}
  await page.waitForFunction(()=>document.documentElement.dataset.alexDurableEditState==='ready'
    &&document.documentElement.dataset.alexDurableEditBlocked!=='true',undefined,{timeout:90000});
  const ensureUi=async()=>{
    let fiber=document.querySelector('.toolbar-shell');fiber=fiber?.[Object.keys(fiber).find(k=>k.startsWith('__reactFiber'))];
    while(fiber&&fiber.type?.name!=='BoardWorkspace')fiber=fiber.return;
    for(let hook=fiber?.memoizedState;hook;hook=hook.next){const value=hook.memoizedState?.current;
      if(value?.getObjects&&value?.getZoom)window.eraserCanvas=value;
      if(value?.capture&&value?.ensure)window.eraserHandlers=value;
    }
    if(!window.eraserCanvas||!window.eraserHandlers)throw Error('Production board not found');
    await window.eraserHandlers.ensure();
    window.eraserBook=()=>window.eraserCanvas._objects.find(o=>o.boardObjectId==='audit-notebook');
  };
  await page.evaluate(ensureUi);
  await page.waitForFunction(()=>!!window.eraserBook?.()&&!!window.__notebookAuditControllerRef?.current,undefined,{timeout:90000});
  await page.getByRole('button',{name:'Ластик',exact:true}).click();
  const coords=async id=>page.evaluate(id=>{
    const canvas=window.eraserCanvas,object=window.eraserBook()._objects.find(o=>o.boardObjectId===id);
    const p=object.getCenterPoint(),v=canvas.viewportTransform,r=canvas.upperCanvasEl.getBoundingClientRect();
    return{x:r.left+p.x*v[0]+p.y*v[2]+v[4],y:r.top+p.x*v[1]+p.y*v[3]+v[5]};
  },id);
  const gone=ids=>page.waitForFunction(ids=>ids.every(id=>!window.eraserBook()._objects.some(o=>o.boardObjectId===id)),ids,{timeout:30000});
  const flush=()=>page.evaluate(async()=>{await window.__notebookAuditControllerRef.current.flush();});
  const warm=await coords('warmup');await page.mouse.click(warm.x,warm.y);await gone(['warmup']);await flush();
  await page.evaluate(()=>{
    const book=window.eraserBook();window.eraserMetrics={pageReads:0,exactTests:0};
    const get=book.getPageObjects;book.getPageObjects=function(){window.eraserMetrics.pageReads++;return get.call(this);};
    for(const object of book._objects){const contains=object.containsPoint;
      object.containsPoint=function(p){window.eraserMetrics.exactTests++;return contains.call(this,p);};}
  });
  const a=await coords('left-hit'),b=await coords('right-hit');
  assert.ok(await page.evaluate(({x,y})=>document.elementFromPoint(x,y)===window.eraserCanvas.upperCanvasEl,a),'target obscured by controls');
  await page.mouse.move(a.x,a.y);await page.mouse.down();
  await page.mouse.move(a.x+4,a.y,{steps:2});await page.mouse.move(b.x,b.y,{steps:8});
  report.pointer=await page.evaluate(()=>({...window.eraserMetrics,children:window.eraserBook()._objects.length}));
  assert.equal(report.pointer.children,1002,'ink removed before gesture commit');
  assert.equal(report.pointer.pageReads,0,'pointer path enumerated entire page');
  assert.ok(report.pointer.exactTests<40,'pointer path tested distant children');
  await page.mouse.up();await gone(['left-hit','right-hit']);await flush();
  report.release=await page.evaluate(()=>({...window.eraserMetrics,children:window.eraserBook()._objects.length}));
  assert.equal(report.release.children,1000);
  await page.keyboard.press('Control+z');
  await page.waitForFunction(()=>['left-hit','right-hit'].every(id=>window.eraserBook()._objects.some(o=>o.boardObjectId===id)),undefined,{timeout:30000});await flush();
  await page.keyboard.press('Control+Shift+z');await gone(['left-hit','right-hit']);await flush();
  const beforeReloadRevision=await page.evaluate(()=>window.__notebookAuditControllerRef.current.getConfirmedState().revision);
  // The fresh controller must reconstruct the same deletion from stored state
  // and journal. Read no old canvas/controller references after reload.
  await page.reload();
  await page.waitForFunction(()=>document.documentElement.dataset.alexDurableEditState==='ready'
    &&document.documentElement.dataset.alexDurableEditBlocked!=='true',undefined,{timeout:90000});
  await page.evaluate(ensureUi);
  await page.waitForFunction(()=>!!window.__notebookAuditControllerRef?.current,undefined,{timeout:90000});
  const persisted=await page.evaluate(()=>{
    const view=window.__notebookAuditControllerRef.current.getConfirmedState();
    const book=view.snapshot.canvas.objects.find(o=>o.boardObjectId==='audit-notebook');
    return{revision:view.revision,ids:book.notebookPages[0].map(o=>o.boardObjectId)};
  });
  assert.ok(persisted.revision>=beforeReloadRevision,'reload lost confirmed revisions');
  assert.equal(persisted.ids.length,1000);
  assert.ok(['warmup','left-hit','right-hit'].every(id=>!persisted.ids.includes(id)),'reload resurrected erased ink');
  report.ui={gesture:true,undo:true,redo:true,reloaded:true,persistedChildren:persisted.ids.length};
  assert.deepEqual(report.errors,[]);
  console.log(`${name}: seven eraser-index cases and real pointer erase/undo/redo completed`);
}catch(error){report.failure=error.stack??error.message;throw error;}
finally{await writeFile(`${output}/${name}.json`,JSON.stringify(report,null,2));await browser?.close();server.kill();}
