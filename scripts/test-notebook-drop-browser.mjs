import { chromium, webkit } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const engineName=process.env.VERIFICATION_BROWSER==='webkit'?'webkit':'chromium';
const engine=engineName==='webkit'?webkit:chromium;
const port=5205,base=`http://127.0.0.1:${port}/alex/`;
const server=spawn(process.execPath,['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port',String(port),'--strictPort'],{stdio:'ignore'});
let browser,page;const checks=[],errors=[];
async function accessors(){await page.evaluate(()=>{
 let f=document.querySelector('.toolbar-shell');f=f[Object.keys(f).find(k=>k.startsWith('__reactFiber'))];
 while(f&&f.type?.name!=='BoardWorkspace')f=f.return;
 for(let h=f?.memoizedState;h;h=h.next){const v=h.memoizedState?.current;if(v?.getObjects&&v?.getZoom){window.testCanvas=v;break;}}
 window.notebook=()=>window.testCanvas.getObjects().find(o=>o.type==='boardnotebook');
 window.toolbar=()=>{let f=document.querySelector('.toolbar-shell');f=f[Object.keys(f).find(k=>k.startsWith('__reactFiber'))];while(f&&!f.memoizedProps?.onAddNotebook)f=f.return;return f.memoizedProps;};
 window.sceneToClient=point=>{const c=window.testCanvas,v=c.viewportTransform,r=c.upperCanvasEl.getBoundingClientRect();return {x:r.left+point.x*v[0]+point.y*v[2]+v[4],y:r.top+point.x*v[1]+point.y*v[3]+v[5]};};
});}
async function point(x,y){return page.evaluate(p=>window.sceneToClient(p),{x,y});}
async function selectNotebook(){await page.getByRole('button',{name:'Выделение',exact:true}).click();await page.evaluate(()=>{window.testCanvas.setActiveObject(window.notebook());window.testCanvas.requestRenderAll();});await page.locator('.notebook-page-controls').waitFor();}
async function flip(next){await page.locator(`.notebook-page-controls button[aria-label="${next?'Следующая':'Предыдущая'} страница"]`).click();}
async function draw(x,y){await page.getByRole('button',{name:'Карандаш',exact:true}).click();const a=await point(x,y),b=await point(x+70,y+15);await page.mouse.move(a.x,a.y);await page.mouse.down();await page.mouse.move(b.x,b.y,{steps:8});await page.mouse.up();await page.waitForFunction(()=>window.notebook().getPageObjects().length===1);}
async function drag(from,to){await page.mouse.move(from.x,from.y);await page.mouse.down();await page.waitForFunction(()=>window.testCanvas._currentTransform?.action==='drag'&&!window.testCanvas._currentTransform.target.lockMovementX);await page.mouse.move(to.x,to.y,{steps:12});await page.mouse.up();}
async function notebookMatrix(){return page.evaluate(()=>window.notebook().calcTransformMatrix().map(v=>Math.round(v*1e5)/1e5));}
try{
 for(let i=0;i<100;i++){try{if((await fetch(base)).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
 browser=await engine.launch({headless:true,...(engineName==='chromium'?{args:['--no-sandbox'],...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{})}:{})});
 page=await browser.newPage({viewport:{width:1280,height:900}});page.setDefaultTimeout(20000);
 page.on('pageerror',e=>errors.push(String(e)));page.on('console',m=>{if(m.type()==='error')console.error('BROWSER',m.text());});
 await page.goto(base+'scripts/board-media-fixture.html');
 // Source fixtures only. Drawing, moving, page controls, group selection and
 // drop all use the production UI and native browser pointer input below.
 const board=await page.evaluate(async()=>{
  const {createAuthorityBoard}=await import('/alex/src/lib/browserAuthorityStore.js');
  const {randomToken,deriveShareKey}=await import('/alex/src/lib/ids.js');
  const {BoardNotebook}=await import('/alex/src/lib/boardNotebook.js');
  const {Rect,Textbox,FabricImage}=await import('/alex/node_modules/.vite/deps/fabric.js');
  const book=new BoardNotebook({boardObjectId:'book',left:400,top:160,width:360,height:360});
  const rect=new Rect({boardObjectId:'shape',left:140,top:220,width:80,height:50,fill:'red',originX:'left',originY:'top'});
  const text=new Textbox('Drop this text',{boardObjectId:'text',left:120,top:310,width:140,fontSize:22,originX:'left',originY:'top'});
  const bitmap=document.createElement('canvas');bitmap.width=100;bitmap.height=60;bitmap.getContext('2d').fillRect(0,0,100,60);
  const image=new FabricImage(bitmap,{boardObjectId:'picture',left:140,top:410,originX:'left',originY:'top'});
  const boardId=randomToken(12),ownerKey=randomToken(28),shareKey=await deriveShareKey(ownerKey);
  const result=await createAuthorityBoard({boardId,ownerKey,shareKey,realtimeKey:shareKey,title:'Notebook drop regressions',verificationVersion:1,notebookVersion:1,
   snapshot:{version:2,background:'blank',canvas:{objects:[book,rect,text,image].map(o=>o.toObject(['boardObjectId']))}}});
  [book,rect,text,image].forEach(o=>o.dispose());return {boardId,ownerKey};
 });
 await page.goto(`${base}board/${board.boardId}?key=${board.ownerKey}`);
 await page.waitForTimeout(700);
 if(await page.getByRole('textbox',{name:'Ваше имя'}).count()){await page.getByRole('textbox',{name:'Ваше имя'}).fill('Notebook drop tester');await page.getByRole('button',{name:'Войти на доску',exact:true}).click();}
 await page.waitForFunction(()=>document.documentElement.dataset.alexDurableEditState==='ready'&&document.documentElement.dataset.alexDurableEditBlocked!=='true');await accessors();
 await draw(445,245);await selectNotebook();await flip(true);await page.waitForFunction(()=>window.notebook().notebookPageNumber===2);await draw(445,270);await selectNotebook();
 const original=await notebookMatrix(),from=await point(695,450),to=await point(755,485);await drag(from,to);const moved=await notebookMatrix();assert.ok(Math.abs(moved[4]-original[4])>40);
 await flip(true);await page.waitForFunction(()=>window.notebook().notebookPageNumber===3);assert.deepEqual(await notebookMatrix(),moved);
 await flip(false);await page.waitForFunction(()=>window.notebook().notebookPageNumber===2);assert.deepEqual(await notebookMatrix(),moved);
 await flip(false);await page.waitForFunction(()=>window.notebook().notebookPageNumber===1);assert.deepEqual(await notebookMatrix(),moved);
 checks.push('native draw page 1 + page 2, notebook drag, forward/back pages preserve frame');
 // Select only the three standalone objects with the real marquee tool.
 const a=await point(80,190),b=await point(295,500);await page.mouse.move(a.x,a.y);await page.mouse.down();await page.mouse.move(b.x,b.y,{steps:10});await page.mouse.up();
 await page.waitForFunction(()=>String(window.testCanvas.getActiveObject()?.type).toLowerCase()==='activeselection'&&window.testCanvas.getActiveObject().getObjects().length===3);
 const before=await page.evaluate(()=>window.testCanvas.getActiveObject().getObjects().map(o=>({id:o.boardObjectId,matrix:o.calcTransformMatrix().map(v=>Math.round(v*1e5)/1e5)})));
 const source=await point(180,240),destination=await point(480,240);await drag(source,destination);
 await page.waitForFunction(()=>window.notebook().getPageObjects().length===4);
 assert.equal(await page.evaluate(()=>window.testCanvas.getObjects().find(o=>o.boardObjectId==='text')?.type),'image');
 assert.equal(await page.evaluate(()=>window.testCanvas.getObjects().length),4);
 assert.deepEqual(await notebookMatrix(),moved);
 checks.push('native mixed marquee + drag clips shape/text/image into page and retains outside fragments');
 await page.getByRole('button',{name:/Отменить —/}).click();await page.waitForFunction(()=>window.notebook().getPageObjects().length===1);
 assert.equal(await page.evaluate(()=>window.testCanvas.getObjects().find(o=>o.boardObjectId==='text')?.type),'textbox');
 const restored=await page.evaluate(ids=>ids.map(id=>{const o=window.testCanvas.getObjects().find(o=>o.boardObjectId===id);return {id,matrix:o.calcTransformMatrix().map(v=>Math.round(v*1e5)/1e5)};}),before.map(o=>o.id));assert.deepEqual(restored,before);
 await page.getByRole('button',{name:/Вернуть —/}).click();await page.waitForFunction(()=>window.notebook().getPageObjects().length===4);
 checks.push('one native undo restores full editable sources and original coordinates; one redo restores drop');
 await page.reload();await page.waitForFunction(()=>document.documentElement.dataset.alexDurableEditState==='ready');await accessors();await page.waitForFunction(()=>window.notebook()?.getPageObjects().length===4);assert.deepEqual(await notebookMatrix(),moved);
 checks.push('reload preserves moved frame and captured content');assert.deepEqual(errors,[]);
 console.log(JSON.stringify({engine:engineName,passed:true,checks},null,2));
}catch(error){errors.push(String(error.stack??error));if(page)await page.screenshot({path:`/tmp/notebook-drop-${engineName}.png`}).catch(()=>{});throw error;}
finally{
 await mkdir('connection-direct-results',{recursive:true});
 await writeFile(`connection-direct-results/notebook-drop-${engineName}.json`,JSON.stringify({engine:engineName,checks,errors},null,2));
 await browser?.close();server.kill();
}
