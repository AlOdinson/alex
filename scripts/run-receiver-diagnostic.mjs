import {chromium,webkit} from 'playwright-core';
import {spawn} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const engine=process.env.VERIFICATION_BROWSER==='webkit'?'webkit':'chromium';
const port=5197,base=`http://127.0.0.1:${port}/alex/`;
const server=spawn(process.execPath,['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port',String(port),'--strictPort'],{stdio:'ignore'});
const pages={},reports=[],errors=[];let browser;
await mkdir('receiver-diagnostic-results',{recursive:true});
const output=`receiver-diagnostic-results/${engine}.json`;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const videoStats=(sample,type)=>sample.stats.flatMap(s=>s.rtp).find(s=>s.type===type&&(s.kind==='video'||s.mediaType==='video'))??{};
try{
  browser=await (engine==='webkit'?webkit:chromium).launch({headless:true,...(engine==='chromium'?{args:['--no-sandbox','--autoplay-policy=no-user-gesture-required','--disable-features=WebRtcHideLocalIpsWithMdns','--allow-loopback-in-peer-connection']}: {})});
  for(let i=0;i<100;i++){try{if((await fetch(base)).ok)break;}catch{}await sleep(100);}
  for(const role of ['host','viewer']){
    const context=await browser.newContext({viewport:{width:1100,height:900}}),page=await context.newPage();pages[role]=page;
    if(engine==='webkit'&&process.env.WEBKIT_LOCAL_ICE==='1'){const implementation=page._connection.toImpl(page);await implementation.delegate._session.send('Page.overrideSetting',{setting:'ICECandidateFilteringEnabled',value:false});}
    page.on('pageerror',error=>errors.push({role,error:error.message}));
    await page.exposeFunction('routeSignal',async message=>{const target=message.clientId==='diagnostic-host'?'viewer':'host';if(pages[target])await pages[target].evaluate(m=>window.diag?.receive(m),message);return 'ok';});
    await page.goto(base+'scripts/board-media-fixture.html');
    await page.evaluate(async role=>{const m=await import('./receiver-diagnostic.jsx');m.install(role);},role);
    await page.waitForFunction(()=>Boolean(window.diag?.share));
  }
  await pages.host.evaluate(()=>window.diag.share.start());
  await pages.viewer.waitForFunction(()=>window.diag.peers.some(p=>p.connectionState==='connected')&&window.diag.media?.video.readyState>=2,null,{timeout:25000});
  async function sample(label,ms){
    const before=Object.fromEntries(await Promise.all(Object.entries(pages).map(async([r,p])=>[r,await p.evaluate(()=>window.diag.sample())])));
    await sleep(ms);
    const after=Object.fromEntries(await Promise.all(Object.entries(pages).map(async([r,p])=>[r,await p.evaluate(()=>window.diag.sample())])));
    const rates={};
    for(const role of ['host','viewer']){
      const a=after[role],b=before[role],seconds=(a.time-b.time)/1000;
      const type=role==='host'?'outbound-rtp':'inbound-rtp',sa=videoStats(a,type),sb=videoStats(b,type);
      rates[role]={profile:a.profile,ultra:a.ultra,rvfcFps:(a.frames-b.frames)/seconds,boardFps:(a.boardRenders-b.boardRenders)/seconds,copyFps:(a.frameCopies-b.frameCopies)/seconds,transmittedFps:role==='host'?(sa.framesSent-sb.framesSent)/seconds:undefined,decodedFps:role==='viewer'?(sa.framesDecoded-sb.framesDecoded)/seconds:undefined,rtpFps:sa.framesPerSecond,qualityLimitationReason:sa.qualityLimitationReason,frameWidth:sa.frameWidth,frameHeight:sa.frameHeight,encodings:a.stats[0]?.senders?.[0]?.encodings};
    }
    reports.push({label,rates,before,after});console.log('MEASURED',engine,label,JSON.stringify(rates));
    await writeFile(output,JSON.stringify({engine,reports,errors},null,2));
  }
  await sleep(2000);await sample('standard-idle',3000);
  await pages.host.evaluate(()=>{window.diag.motion=setInterval(()=>window.dispatchEvent(new PointerEvent('pointermove')),100);});
  await sleep(500);await sample('standard-motion',3000);
  await pages.host.evaluate(()=>{clearInterval(window.diag.motion);return window.diag.share.setUltraEnabled(true);});
  await sleep(500);await sample('ultra1080',4000);
  await pages.host.evaluate(()=>window.diag.share.setResolution720Enabled(true));
  await sleep(500);await sample('ultra720',4000);
  await pages.host.evaluate(()=>window.diag.share.setUltraEnabled(false));
  await sleep(500);await sample('standard-idle-again',3000);
  assert.deepEqual(errors,[]);
}catch(error){errors.push({error:error.stack});console.error(error);process.exitCode=1;}
finally{
  for(const [role,page]of Object.entries(pages)){try{await writeFile(`receiver-diagnostic-results/${engine}-${role}-final.json`,JSON.stringify(await page.evaluate(()=>window.diag.sample()),null,2));}catch{} }
  await writeFile(output,JSON.stringify({engine,reports,errors},null,2));
  await browser?.close();server.kill();
}
