import { chromium, webkit } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const name = process.env.VERIFICATION_BROWSER === 'webkit' ? 'webkit' : 'chromium';
const engine = name === 'webkit' ? webkit : chromium;
const port = 5226, base = `http://127.0.0.1:${port}/alex/`, output = 'notebook-page-model-results';
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port',String(port),'--strictPort'], {stdio:'ignore'});
let browser;
try {
  await mkdir(output,{recursive:true}); let ready = false;
  for(let i=0;i<150;i++) {try{if((await fetch(base)).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}
  assert.ok(ready,'Vite did not start');
  browser = await engine.launch({headless:true,...(name==='chromium'?{args:['--no-sandbox'],...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{})}:{})});
  const page = await browser.newPage(), errors=[]; page.on('pageerror', e=>errors.push(e.message));
  await page.goto(base+'scripts/board-media-fixture.html');
  const result=await page.evaluate(async()=>{
    const {Path,StaticCanvas}=await import('/alex/node_modules/.vite/deps/fabric.js');
    const {BoardNotebook}=await import('/alex/src/lib/boardNotebook.js');
    const {applyNotebookOperation,evaluateNotebookOperation,invertNotebookOperation,updateNotebookTombstones}=await import('/alex/src/lib/notebookOperations.js');
    const {prepareNotebookProjection}=await import('/alex/src/lib/notebookProjection.js');
    const {freezeNotebookRecord}=await import('/alex/src/lib/notebookRecords.js');
    const check=(value,label)=>{if(!value)throw new Error(label);};
    const fields=['boardObjectId','updatedAt','updatedBy'];
    const record=id=>new Path('M -40 -20 L 20 10',{boardObjectId:id,fill:null,stroke:'black',strokeWidth:2}).toObject(fields);
    const operation=changes=>({type:'notebook',version:1,id:'book',pageNumber:1,updatedAt:12,updatedBy:'writer',changes});
    const book=await BoardNotebook.fromObject({boardObjectId:'book',notebookPages:[Array.from({length:1000},(_,i)=>record(`old-${i}`))]});
    const canvas=new StaticCanvas(document.createElement('canvas'),{width:700,height:600,renderOnAddRemove:false});canvas.add(book);canvas.renderAll();
    try {
      const initial={...book.toObject(fields)}, target={...initial};
      const append=operation([{type:'insert',object:record('new')}]);applyNotebookOperation(target,append);freezeNotebookRecord(target);
      let pageReads=0;
      const pages=new Proxy(target.notebookPages,{get(t,k,r){if(k==='0')pageReads++;return Reflect.get(t,k,r);}});
      const work=await prepareNotebookProjection(book,{...target,notebookPages:pages});check(work.apply(),'append not installed');
      check(pageReads===0,'append exported retained records');check(book._objects.length===1001,'append lost child');
      // A sibling confirmed fork changes only the stamp and must not export the
      // complete preview or confirmed page to rediscover their equivalence.
      const confirmed={...initial};applyNotebookOperation(confirmed,{...append,updatedAt:13});
      let confirmedReads=0;const confirmedPages=new Proxy(confirmed.notebookPages,{get(t,k,r){if(k==='0')confirmedReads++;return Reflect.get(t,k,r);}});
      const ack=await prepareNotebookProjection(book,{...confirmed,notebookPages:confirmedPages});check(ack.apply(),'confirmation not installed');
      check(confirmedReads===0,'confirmation exported retained page');check(book._objects.at(-1).updatedAt===13,'stamp missing');
      const snapshot=structuredClone(confirmed);check(Array.isArray(snapshot.notebookPages[0]),'snapshot format changed');
      check(JSON.stringify(snapshot)===JSON.stringify(confirmed),'JSON/structuredClone mismatch');
      const database=await new Promise((resolve,reject)=>{const r=indexedDB.open('notebook-page-model-test',1);r.onupgradeneeded=()=>r.result.createObjectStore('records');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
      try {
        await new Promise((resolve,reject)=>{const tx=database.transaction('records','readwrite');tx.objectStore('records').put(confirmed,'book');tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});
        const saved=await new Promise((resolve,reject)=>{const r=database.transaction('records').objectStore('records').get('book');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
        check(JSON.stringify(saved)===JSON.stringify(snapshot),'IndexedDB clone changed lesson');
      } finally {database.close();}
      const patched={...confirmed};applyNotebookOperation(patched,operation([{type:'patch',id:'new',patch:{opacity:.35}}]));
      const update=await prepareNotebookProjection(book,patched);check(update.apply(),'patch not installed');
      check(book._objects.at(-1).opacity===.35,'visual patch incorrectly treated as metadata');
      const deletion=operation([{type:'delete',id:'new'}]), context={clientId:'writer',actionId:'delete-new',mutationId:'delete-new'};
      const inverse=invertNotebookOperation(patched,deletion,context), removed={...patched};applyNotebookOperation(removed,deletion);
      const tombstones=updateNotebookTombstones({},[deletion],context);
      check(!evaluateNotebookOperation(removed,inverse[0],{}).changed,'unguarded restore accepted');
      const undo=evaluateNotebookOperation(removed,inverse[0],tombstones,context);check(undo.changed,'valid undo rejected');
      applyNotebookOperation(removed,{...inverse[0],changes:undo.appliedChanges});
      check(removed.notebookPages[0].at(-1).boardObjectId==='new','undo order wrong');
      check(initial.notebookPages[0].length===1000,'old checkpoint mutated');
      snapshot.notebookPages[0].at(-1).path[0][1]=999;
      check(confirmed.notebookPages[0].at(-1).path[0][1]!==999,'export aliases internal geometry');
      return {pageReads,confirmedReads,initialChildren:1000,finalChildren:removed.notebookPages[0].length,storageRoundTrip:true,guardedUndo:true,visualPatch:true};
    } finally {await canvas.dispose();}
  });
  await writeFile(`${output}/${name}.json`,JSON.stringify({engine:name,commit:process.env.GITHUB_SHA,result,errors},null,2));
  assert.deepEqual(errors,[]);console.log(JSON.stringify({engine:name,...result}));
} finally {await browser?.close();server.kill();}
