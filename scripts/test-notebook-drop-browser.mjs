import { chromium, webkit } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const engine=process.env.VERIFICATION_BROWSER==='webkit'?'webkit':'chromium';
const server=spawn(process.execPath,['node_modules/vite/bin/vite.js','--host','127.0.0.1'],{stdio:'ignore'});
const browser=await (engine==='webkit'?webkit:chromium).launch({headless:true,
  ...(engine==='chromium'?{args:['--no-sandbox'],...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{})}:{})});
const page=await browser.newPage({viewport:{width:1200,height:900}}),errors=[],results=[];
page.on('pageerror',error=>errors.push(error.message));
const diagnostics=[];page.on('console',message=>{if(['error','warning'].includes(message.type()))diagnostics.push(message.text());});
const next=()=>page.locator('.notebook-page-controls button[aria-label="Следующая страница"]').click();
const previous=()=>page.locator('.notebook-page-controls button[aria-label="Предыдущая страница"]').click();
async function selectBook() {
  await page.evaluate(()=>{const c=window.c;c.discardActiveObject();c.setActiveObject(window.book());c.requestRenderAll();});
  await page.locator('.notebook-page-controls').waitFor();
}
async function drawOnPage(label) {
  await page.evaluate(async label=>{
    const {Path}=await import('/alex/node_modules/.vite/deps/fabric.js');const n=window.book(),p=n.getBoundingRect();
    const path=new Path(`M ${p.left+40} ${p.top+80} L ${p.left+140} ${p.top+100}`,{stroke:'black',strokeWidth:5,fill:null});
    path.boardObjectId=label;window.c.add(path);window.c.fire('path:created',{path});
  },label);
  await page.waitForFunction(()=>window.book().getPageObjects().length===1);
}
async function drag(point,dx,dy) {
  await page.mouse.move(point.x,point.y);await page.mouse.down();
  await page.waitForFunction(()=>window.c._currentTransform?.target?.lockMovementX===false);
  console.log('NATIVE DRAG START',JSON.stringify(await page.evaluate(()=>({active:window.c.getActiveObject()?.type, target:window.c._currentTransform?.target?.type, action:window.c._currentTransform?.action, handler:String(window.c._currentTransform?.actionHandler), selected:window.c.getActiveObjects().map(o=>({id:o.boardObjectId,rect:o.getBoundingRect()}))}))));
  await page.mouse.move(point.x+dx,point.y+dy,{steps:12});await page.mouse.up();
  console.log('NATIVE DRAG END',JSON.stringify(await page.evaluate(()=>({active:window.c.getActiveObject()?.type, objects:window.c.getObjects().map(o=>({id:o.boardObjectId,rect:o.getBoundingRect()}))}))));
}
try {
  for(let attempt=0;attempt<100;attempt++){
    try {if((await fetch('http://127.0.0.1:5173/alex/')).ok)break;}catch{}
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  await page.goto('http://127.0.0.1:5173/alex/scripts/board-media-fixture.html');
  const record=await page.evaluate(async()=>{const {createBoard}=await import('/alex/src/lib/boardRepository.js');return createBoard('Notebook drop regression');});
  await page.goto(`http://127.0.0.1:5173/alex/board/${record.boardId}?key=${record.ownerKey}`);
  const name=page.getByRole('textbox',{name:'Ваше имя'});
  await name.waitFor();await name.fill('Notebook test');await page.getByRole('button',{name:'Войти на доску',exact:true}).click();
  await page.waitForFunction(()=>document.documentElement.dataset.alexDurableEditState==='ready'&&document.documentElement.dataset.alexDurableEditBlocked!=='true');
  await page.getByRole('button',{name:'Блокнот',exact:true}).click();
  await page.locator('.notebook-page-controls').waitFor();
  await page.evaluate(()=>{
    let f=document.querySelector('.toolbar-shell');f=f[Object.keys(f).find(k=>k.startsWith('__reactFiber'))];
    while(f&&f.type?.name!=='BoardWorkspace')f=f.return;
    for(let h=f.memoizedState;h;h=h.next){const value=h.memoizedState?.current;if(value?.getObjects&&value?.getZoom){window.c=value;break;}}
    window.book=()=>window.c.getObjects().find(o=>o.type==='boardnotebook');
    window.screenPoint=point=>{const v=window.c.viewportTransform,r=window.c.upperCanvasEl.getBoundingClientRect();return {x:r.left+point.x*v[0]+point.y*v[2]+v[4],y:r.top+point.x*v[1]+point.y*v[3]+v[5]};};
  });
  await drawOnPage('page-one');await selectBook();await next();await page.waitForFunction(()=>window.book().notebookPageNumber===2);
  await drawOnPage('page-two');await selectBook();
  const frame=await page.evaluate(()=>{const n=window.book(),p=n.getBoundingRect();return {left:n.left,top:n.top,point:window.screenPoint({x:p.left+350,y:p.top+220})};});
  await drag(frame.point,60,35);
  await next();await page.waitForFunction(()=>window.book().notebookPageNumber===3);
  const moved=await page.evaluate(()=>({left:window.book().left,top:window.book().top,pages:window.book().notebookPages.map(p=>p.length)}));
  assert.ok(Math.abs(moved.left-frame.left-60)<0.05,'page navigation reverted notebook x');
  assert.ok(Math.abs(moved.top-frame.top-35)<0.05,'page navigation reverted notebook y');
  assert.deepEqual(moved.pages.slice(0,3),[1,1,0]);
  await previous();await page.waitForFunction(()=>window.book().notebookPageNumber===2);
  assert.equal(await page.evaluate(()=>window.book().getPageObjects().length),1);
  results.push({name:'native move between filled pages keeps coordinates',passed:true});

  // Create two durable shapes outside, then drag an actual Fabric multi-selection.
  await page.getByRole('button',{name:'Выделение',exact:true}).click();
  await page.evaluate(async()=>{
    const {Rect}=await import('/alex/node_modules/.vite/deps/fabric.js');const p=window.book().getBoundingRect();
    for(let i=0;i<2;i++){
      const object=new Rect({left:p.left-100,top:p.top+120+i*70,width:35,height:30,originX:'left',originY:'top',fill:'black'});
      object.boardObjectId=`drop-source-${i}`;window.c.add(object);window.c.fire('path:created',{path:object});
    }
  });
  await page.waitForFunction(async boardId=>{const {getBoardRuntime}=await import('/alex/src/lib/browserBoardRuntimeRegistry.js');return getBoardRuntime(boardId).getSnapshot().canvas.objects.filter(o=>String(o.boardObjectId).startsWith('drop-source')).length===2;},record.boardId);
  const point=await page.evaluate(async()=>{
    const {ActiveSelection}=await import('/alex/node_modules/.vite/deps/fabric.js');const objects=window.c.getObjects().filter(o=>String(o.boardObjectId).startsWith('drop-source'));
    window.c.discardActiveObject();window.c.setActiveObject(new ActiveSelection(objects,{canvas:window.c}));window.c.requestRenderAll();return window.screenPoint(objects[0].getCenterPoint());
  });
  await drag(point,160,0);
  await page.waitForFunction(()=>window.book().getPageObjects().length===3);
  assert.equal(await page.evaluate(()=>window.c.getObjects().filter(o=>String(o.boardObjectId).startsWith('drop-source')).length),0);
  await page.getByRole('button',{name:/Отменить —/}).click();
  await page.waitForFunction(()=>window.book().getPageObjects().length===1&&window.c.getObjects().filter(o=>String(o.boardObjectId).startsWith('drop-source')).length===2);
  await page.getByRole('button',{name:/Вернуть —/}).click();
  await page.waitForFunction(()=>window.book().getPageObjects().length===3);
  results.push({name:'native multi-selection drop, one undo and redo',passed:true});
  assert.deepEqual(errors,[]);
} catch(error) {
  await mkdir('notebook-drop-results',{recursive:true});
  await page.screenshot({path:`notebook-drop-results/${engine}-failure.png`}).catch(()=>{});
  await writeFile(`notebook-drop-results/${engine}-failure.json`,JSON.stringify({message:error.message,stack:error.stack,errors,results,diagnostics,
    state:await page.evaluate(()=>({text:document.body.innerText,book:window.book?.()?.toObject(['boardObjectId']),transform:Boolean(window.c?._currentTransform),objects:window.c?.getObjects().map(o=>({id:o.boardObjectId,type:o.type,left:o.left,top:o.top,group:o.group?.type,rect:o.getBoundingRect()}))})).catch(()=>null)},null,2));
  throw error;
} finally {
  await mkdir('notebook-drop-results',{recursive:true});
  await writeFile(`notebook-drop-results/${engine}.json`,JSON.stringify({engine,results,errors},null,2));
  await browser.close();server.kill();
}
console.log(JSON.stringify({engine,results,errors},null,2));
