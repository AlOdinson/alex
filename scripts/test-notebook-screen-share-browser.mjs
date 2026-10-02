import {chromium,webkit} from 'playwright-core';
import {spawn} from 'node:child_process';
import {writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const port=5198,base=`http://127.0.0.1:${port}/alex/`;
const server=spawn(process.execPath,['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port',String(port),'--strictPort'],{stdio:'ignore'});
let browser;
try {
 const engine=process.env.VERIFICATION_BROWSER==='webkit'?webkit:chromium;
 browser=await engine.launch({headless:true,...(engine===chromium?{args:['--no-sandbox','--autoplay-policy=no-user-gesture-required','--disable-features=WebRtcHideLocalIpsWithMdns','--allow-loopback-in-peer-connection'],...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{})}:{})});
 for(let i=0;i<100;i++){try{if((await fetch(base)).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
 const page=await browser.newPage();
 if(engine===webkit&&process.env.WEBKIT_LOCAL_ICE==='1'){const implementation=page._connection.toImpl(page);await implementation.delegate._session.send('Page.overrideSetting',{setting:'ICECandidateFilteringEnabled',value:false});}
 await page.goto(base+'scripts/board-media-fixture.html');
 const results=[];
 for(const size of [{width:1280,height:720,fps:60},{width:1920,height:1080,fps:60}]) {
  const report=await page.evaluate(async size=>{const m=await import('./notebook-performance-fixture.js');return m.benchmarkReceivedNotebookVideo(size);},size);
  results.push(report);console.log(JSON.stringify(report,null,2));
  assert.equal(report.fullSceneRenders,0);assert.equal(report.visibleObjects,401);assert.deepEqual(report.errors,[]);
  assert.ok(report.received.framesDecoded>=60);assert.equal(report.received.frameWidth,size.width);assert.equal(report.received.frameHeight,size.height);
 }
 await writeFile('/tmp/notebook-received-video.json',JSON.stringify(results,null,2)+'\n');
} finally {await browser?.close();server.kill();}
