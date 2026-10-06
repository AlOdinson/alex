import { chromium, webkit } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdir, writeFile, readdir, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve, sep } from 'node:path';
import assert from 'node:assert/strict';
const name=process.env.VERIFICATION_BROWSER==='webkit'?'webkit':'chromium';
const port=5256,base=`http://127.0.0.1:${port}/alex/`,output='notebook-split-worker-results';
const server=spawn(process.execPath,['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port',String(port),'--strictPort'],{stdio:'ignore'});
let browser,staticServer;const report={name,commit:process.env.GITHUB_SHA,result:null,errors:[],workers:[]};
try{
  await mkdir(output,{recursive:true});let ready=false;
  for(let i=0;i<150;i++){try{if((await fetch(base)).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}
  assert.ok(ready,'Vite did not start');
  browser=await(name==='webkit'?webkit:chromium).launch({headless:true,...(name==='chromium'?{args:['--no-sandbox'],...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{})}:{})});
  const page=await browser.newPage();page.on('pageerror',error=>report.errors.push(error.message));page.on('worker',worker=>report.workers.push(worker.url()));
  await page.goto(base+'scripts/board-media-fixture.html');
  report.result=await page.evaluate(async()=>{
    const {runNotebookVectorSplit,runNotebookRasterBounds}=await import('/alex/src/lib/notebookSplitWorkerClient.js');
    const {scanNotebookAlphaBounds}=await import('/alex/src/lib/notebookRasterBounds.js');
    const {createBoardNotebook,captureNotebookObject}=await import('/alex/src/lib/boardNotebook.js');
    const {Path}=await import('/alex/node_modules/.vite/deps/fabric.js');
    const circle=(cx,cy,r,count=180)=>Array.from({length:count},(_,i)=>{const a=i*Math.PI*2/count;return{x:cx+r*Math.cos(a),y:cy+r*Math.sin(a)};});
    const paints=Array.from({length:180},(_,i)=>({kind:'fill',color:'#000',fillRule:'nonzero',paths:[{points:circle((i%18)*20,Math.floor(i/18)*20,14),closed:true}]}));
    const payload={paints,page:[[{x:0,y:0},{x:360,y:0},{x:360,y:220},{x:0,y:220}]],matrix:[1,0,0,1,0,0],tolerance:.01};
    const events=[];const started=performance.now();
    const split=runNotebookVectorSplit(payload).then(result=>{events.push('split');return result;});
    setTimeout(()=>events.push('timer'),0);
    const rows=await split;
    const controller=new AbortController();const cancelled=runNotebookVectorSplit(payload,{signal:controller.signal}).then(()=>null,e=>e.name);controller.abort();
    const abortName=await cancelled;
    const canvas=document.createElement('canvas');canvas.width=512;canvas.height=384;const ctx=canvas.getContext('2d');ctx.fillStyle='red';ctx.fillRect(37,53,211,97);
    const raster=await runNotebookRasterBounds(canvas);
    const realRead=ctx.getImageData.bind(ctx);let largestRead=0,reads=0;
    ctx.getImageData=(x,y,w,h)=>{largestRead=Math.max(largestRead,w*h);reads++;return realRead(x,y,w,h);};
    const fallback=await scanNotebookAlphaBounds(ctx,canvas.width,canvas.height);
    const book=createBoardNotebook({left:100,top:100,width:200,height:200});
    const stroke=new Path('M 20 150 C 90 10 260 360 380 150',{fill:null,stroke:'red',strokeWidth:9});
    const original=JSON.stringify(stroke.toObject());const fragments=await captureNotebookObject(book,stroke);
    const actualCapture={split:fragments?.split,unchanged:JSON.stringify(stroke.toObject())===original,insideType:fragments?.inside?.type};
    fragments?.inside?.dispose();fragments?.outside?.dispose();stroke.dispose();await book.dispose();
    return {events,rows:rows.length,elapsedMs:performance.now()-started,abortName,raster,fallback,largestRead,reads,actualCapture};
  });
  assert.equal(report.result.rows,180);assert.equal(report.result.abortName,'AbortError');
  assert.deepEqual(report.result.raster,{x0:37,y0:53,x1:247,y1:149});assert.deepEqual(report.result.fallback,report.result.raster);
  assert.ok(report.result.largestRead<=65536);assert.ok(report.result.reads>1);assert.equal(report.result.events[0],'timer');
  assert.equal(report.result.actualCapture.split,true);assert.equal(report.result.actualCapture.unchanged,true);assert.ok(report.workers.length>=3,'native workers were not created');

  // Execute the actual emitted worker bytes through a plain static server, not a
  // Vite source transform. This catches invalid production URLs/imports.
  const assets=await readdir('dist/assets'),worker=assets.find(n=>/^notebookSplitWorker-.*\.js$/.test(n));assert.ok(worker,'Missing built worker');
  const root=resolve('dist');
  staticServer=createServer(async(req,res)=>{
    const pathname=new URL(req.url,'http://localhost').pathname;
    if(pathname==='/'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>Worker production gate</title>');return;}
    const file=resolve(root,pathname.replace(/^\/alex\//,''));
    if(!file.startsWith(root+sep)){res.writeHead(404);res.end();return;}
    try{res.setHeader('Content-Type','application/javascript');res.end(await readFile(file));}catch{res.writeHead(404);res.end();}
  });
  await new Promise(r=>staticServer.listen(5257,'127.0.0.1',r));
  await page.goto('http://127.0.0.1:5257/');
  report.production=await page.evaluate(async url=>{
    const worker=new Worker(url,{type:'module'});
    return await new Promise((resolve,reject)=>{
      const timeout=setTimeout(()=>{worker.terminate();reject(new Error('built worker timeout'));},15000);
      worker.onerror=e=>{clearTimeout(timeout);worker.terminate();reject(new Error(e.message));};
      worker.onmessage=({data})=>{clearTimeout(timeout);worker.terminate();data.error?reject(new Error(data.error)):resolve(data.result);};
      worker.postMessage({id:1,type:'vector-split',payload:{commands:[['beginPath'],['rect',0,0,10,10],['fill','nonzero']],page:[[{x:0,y:0},{x:5,y:0},{x:5,y:10},{x:0,y:10}]],matrix:[1,0,0,1,0,0],tolerance:.01}});
    });
  },`/alex/assets/${worker}`);
  assert.equal(report.production.length,1);assert.equal(report.production[0].inside.length,1);assert.equal(report.production[0].outside.length,1);
  const area=paths=>paths.reduce((sum,path)=>sum+Math.abs(path.reduce((a,p,i)=>{const q=path[(i+1)%path.length];return a+p.x*q.y-p.y*q.x;},0)/2),0);
  assert.equal(area(report.production[0].inside),50);assert.equal(area(report.production[0].outside),50);
  assert.deepEqual(report.errors,[]);
  console.log(`${name}: real workers, curve capture, abort, tiled fallback and built worker passed`);
}catch(error){report.failure=error.stack??error.message;throw error;}
finally{await writeFile(`${output}/${name}.json`,JSON.stringify(report,null,2));await browser?.close();await new Promise(r=>staticServer?staticServer.close(r):r());server.kill();}
