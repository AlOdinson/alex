import { chromium, webkit } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
const server=spawn(process.execPath,['node_modules/vite/bin/vite.js','--host','127.0.0.1'],{stdio:'ignore'});
const engine=process.env.VERIFICATION_BROWSER==='webkit'?webkit:chromium;
const profile=await mkdtemp(join(tmpdir(),'alex-student-storage-'));
const browser=await engine.launchPersistentContext(profile,{headless:true,...(engine===chromium?{args:['--no-sandbox'],...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{})}:{})});
try {
 const page=await browser.newPage();
 for(let i=0;i<100;i++){try{if((await fetch('http://127.0.0.1:5173/alex/')).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
 await page.goto('http://127.0.0.1:5173/alex/scripts/board-media-fixture.html');
 const seeded=await page.evaluate(async()=>{
  const {studentOfflineStorage:storage}=await import('/alex/src/lib/studentOfflineCache.js');
  const {boardMediaAssets:media}=await import('/alex/src/lib/mediaAssetStore.js');
  const pdf=await(await fetch('/alex/scripts/fixtures/media/pages.pdf')).blob();
  const gif=await(await fetch('/alex/scripts/fixtures/media/animated.gif')).blob();
  const paint=document.createElement('canvas');paint.width=20;paint.height=20;paint.getContext('2d').fillRect(0,0,20,20);const src=paint.toDataURL();
  const first=await media.importFile('storage-lesson-0',pdf),second=await media.importFile('storage-lesson-0',gif);
  for(let i=0;i<10;i++){
   const boardId=`storage-lesson-${i}`;
   if(i){await media.reuse(boardId,first.assetId);await media.reuse(boardId,second.assetId);}
   await storage.replace(`storage-scope-${i}`,{boardId,title:`Урок ${i+1}`,savedAt:Date.now(),revision:0,snapshot:{canvas:{objects:[{type:'Image',src,boardObjectId:`image-${i}`}]}}});
   await storage.append(`storage-scope-${i}`,{boardId,revision:1,ops:[{type:'patch',id:`image-${i}`,patch:{src}}]});
  }
  return {pdf:first.assetId,gif:second.assetId,src};
 });
 const counts=()=>page.evaluate(async()=>{
  const count=async(name,store)=>{const db=await new Promise((ok,no)=>{const r=indexedDB.open(name);r.onsuccess=()=>ok(r.result);r.onerror=()=>no(r.error);});try{return await new Promise((ok,no)=>{const r=db.transaction(store).objectStore(store).count();r.onsuccess=()=>ok(r.result);r.onerror=()=>no(r.error);});}finally{db.close();}};
  return {images:await count('alex-board-student-view','images'),media:await count('alex-board-media','assets')};
 });
 assert.deepEqual(await counts(),{images:1,media:2},'Ten lessons share one image, one PDF and one GIF');
 await page.reload();
 assert.equal(await page.evaluate(async()=>{const {studentOfflineStorage:s}=await import('/alex/src/lib/studentOfflineCache.js');return (await s.read('storage-scope-9')).snapshot.canvas.objects[0].src;}),seeded.src);
 await page.evaluate(async()=>{const {studentLessonLibrary:l}=await import('/alex/src/lib/studentLessonLibrary.js');for(const lesson of (await l.list()).filter(x=>x.boardId!=='storage-lesson-9'))await l.remove(lesson);});
 assert.deepEqual(await counts(),{images:1,media:2},'Removing nine lessons preserves all shared originals');
 await page.goto('http://127.0.0.1:5173/alex/');
 const section=page.getByRole('region',{name:'Сохранённые уроки',exact:true});
 await section.getByRole('heading',{name:'Урок 10',exact:true}).waitFor();
 page.once('dialog',dialog=>dialog.accept());
 await section.getByRole('button',{name:'Удалить локальную копию',exact:true}).click();
 await section.waitFor({state:'detached'});
 assert.deepEqual(await counts(),{images:0,media:0},'Deleting the final lesson through the UI releases all originals');
 console.log('Student storage browser: 10 lessons / 3 originals, reload, shared retention, final UI deletion passed');
} finally { await browser.close();server.kill();await rm(profile,{recursive:true,force:true}); }
