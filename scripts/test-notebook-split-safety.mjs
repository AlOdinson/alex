import test from 'node:test';
import assert from 'node:assert/strict';
import { getEnv } from 'fabric/node';
import { setEnv, Path } from 'fabric';
import { createBoardNotebook, captureNotebookObject } from '../src/lib/boardNotebook.js';
import { runNotebookVectorSplit, runNotebookRasterBounds } from '../src/lib/notebookSplitWorkerClient.js';
import { splitVectorPaintsTask } from '../src/lib/notebookSplitGeometryCore.js';
setEnv(getEnv());
const payload = {paints:[], page:[], matrix:[1,0,0,1,0,0], tolerance:.01};
const tick = () => new Promise(r => setTimeout(r,0));

test('silent vector worker times out, terminates, and never blocks the next operation', async()=>{
 let terminated=0;
 const work=runNotebookVectorSplit(payload,{timeoutMs:10,workerFactory:()=>({postMessage(){},terminate(){terminated++;}})});
 const result=await Promise.race([work.then(()=> 'resolved',e=>e.name),new Promise(r=>setTimeout(()=>r('hung'),80))]);
 assert.equal(result,'TimeoutError');assert.equal(terminated,1);
});
test('vector worker runtime failure rejects instead of repeating geometry on the input thread',async()=>{
 let terminated=0;
 const work=runNotebookVectorSplit(payload,{workerFactory:()=>({postMessage(){queueMicrotask(()=>this.onerror({message:'worker failed',preventDefault(){}}));},terminate(){terminated++;}})});
 await assert.rejects(work,/worker failed/);assert.equal(terminated,1);
});
test('abort during worker construction cannot miss the abort event',async()=>{
 const c=new AbortController();let terminated=0;
 const work=runNotebookVectorSplit(payload,{signal:c.signal,workerFactory:()=>{c.abort();return{postMessage(){},terminate(){terminated++;}};}});
 const result=await Promise.race([work.then(()=> 'resolved',e=>e.name),new Promise(r=>setTimeout(()=>r('hung'),60))]);
 assert.equal(result,'AbortError');assert.equal(terminated,1);
});
test('abort during pending bitmap creation rejects promptly and closes a late bitmap',async()=>{
 const c=new AbortController();let deliver,closed=0;
 const work=runNotebookRasterBounds({width:4,height:4},{signal:c.signal,createBitmap:()=>new Promise(r=>deliver=r),workerFactory:()=>({})});
 c.abort();
 const result=await Promise.race([work.then(()=> 'resolved',e=>e.name),new Promise(r=>setTimeout(()=>r('hung'),50))]);
 deliver({close(){closed++;}});await tick();
 assert.equal(result,'AbortError');assert.equal(closed,1);
});
test('actual crossing bezier posts native commands rather than already flattened contours',async()=>{
 const OldWorker=globalThis.Worker;let posted;
 globalThis.Worker=class {postMessage(message){posted=message;queueMicrotask(()=>this.onmessage({data:{id:message.id,result:splitVectorPaintsTask(message.payload)}}));}terminate(){}};
 const b=createBoardNotebook({left:100,top:100,width:200,height:200});
 const p=new Path('M 20 150 C 90 10 260 360 380 150',{fill:null,stroke:'red',strokeWidth:9});let r;
 try{r=await captureNotebookObject(b,p);assert.ok(r?.split);assert.ok(posted.payload.commands?.some(c=>c[0]==='bezierCurveTo'),'curve flattened on input thread');assert.equal(posted.payload.paints,undefined);}
 finally{globalThis.Worker=OldWorker;r?.inside?.dispose();r?.outside?.dispose();p.dispose();await b.dispose();}
});
test('capture cancellation reaches the running worker and preserves the original stroke',async()=>{
 const OldWorker=globalThis.Worker,c=new AbortController();let terminated=0,started;
 const begun=new Promise(r=>started=r);
 globalThis.Worker=class {postMessage(){started();}terminate(){terminated++;}};
 const b=createBoardNotebook({left:100,top:100,width:200,height:200});
 const p=new Path('M 20 150 L 380 150',{fill:null,stroke:'red',strokeWidth:8});const before=JSON.stringify(p.toObject());
 const pending=captureNotebookObject(b,p,{signal:c.signal});await begun;c.abort();
 const result=await Promise.race([pending.then(()=> 'resolved',e=>e.name),new Promise(r=>setTimeout(()=>r('hung'),60))]);
 globalThis.Worker=OldWorker;
 assert.equal(JSON.stringify(p.toObject()),before);await b.dispose();p.dispose();
 assert.equal(result,'AbortError');assert.equal(terminated,1);
});
test('fallback alpha bounds reads tiles and yields before scanning a large surface',async()=>{
 const mod=await import('../src/lib/notebookRasterBounds.js').catch(()=>null);
 assert.equal(typeof mod?.scanNotebookAlphaBounds,'function','bounded fallback scanner missing');
 let largest=0,timer=false,sawTimer=false,reads=0;setTimeout(()=>timer=true,0);
 const ctx={getImageData(x,y,w,h){reads++;largest=Math.max(largest,w*h);sawTimer ||= timer;const data=new Uint8ClampedArray(w*h*4);if(x<=300&&300<x+w&&y<=250&&250<y+h)data[((250-y)*w+300-x)*4+3]=255;return{data};}};
 const result=await mod.scanNotebookAlphaBounds(ctx,1024,768);
 assert.deepEqual(result,{x0:300,y0:250,x1:300,y1:250});assert.ok(largest<=65536);assert.ok(reads>1);assert.ok(sawTimer);
});
test('disposing a notebook cancels its real in-progress split',async()=>{
 const OldWorker=globalThis.Worker;let started,terminated=0;const begun=new Promise(r=>started=r);
 globalThis.Worker=class{postMessage(){started();}terminate(){terminated++;}};
 const b=createBoardNotebook({left:100,top:100,width:200,height:200});
 const p=new Path('M 20 150 L 380 150',{fill:null,stroke:'red',strokeWidth:8});
 const result=captureNotebookObject(b,p).then(()=> 'resolved',e=>e.name);await begun;await b.dispose();
 assert.equal(await result,'AbortError');assert.equal(terminated,1);p.dispose();globalThis.Worker=OldWorker;
});
test('huge raster avoids allocating additional full bitmap/worker surfaces',async()=>{
 let created=0;
 const result=await runNotebookRasterBounds({width:8192,height:2048},{createBitmap:async()=>{created++;throw new Error('extra surface allocated');},workerFactory:()=>({})});
 assert.equal(result,undefined);assert.equal(created,0);
});
