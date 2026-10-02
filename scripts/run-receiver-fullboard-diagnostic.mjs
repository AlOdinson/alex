import {chromium,webkit} from 'playwright-core';
import {spawn} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
const engine=process.env.VERIFICATION_BROWSER==='webkit'?'webkit':'chromium';
const port=5196,base=`http://127.0.0.1:${port}/alex/`,sleep=ms=>new Promise(r=>setTimeout(r,ms));
const server=spawn(process.execPath,['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port',String(port),'--strictPort'],{stdio:'ignore'});
const pages={},reports=[],errors=[];let browser;
await mkdir('receiver-diagnostic-results',{recursive:true});
try{
 browser=await (engine==='webkit'?webkit:chromium).launch({headless:true,...(engine==='chromium'?{args:['--no-sandbox','--autoplay-policy=no-user-gesture-required','--disable-features=WebRtcHideLocalIpsWithMdns','--allow-loopback-in-peer-connection']}: {})});
 for(let i=0;i<100;i++){try{if((await fetch(base)).ok)break;}catch{}await sleep(100);}
 for(const role of ['host','viewer']){
  const context=await browser.newContext({viewport:{width:1200,height:900},deviceScaleFactor:2}),page=await context.newPage();pages[role]=page;
  if(engine==='webkit'&&process.env.WEBKIT_LOCAL_ICE==='1'){const implementation=page._connection.toImpl(page);await implementation.delegate._session.send('Page.overrideSetting',{setting:'ICECandidateFilteringEnabled',value:false});}
  page.on('pageerror',e=>errors.push({role,error:e.message}));
  await page.exposeFunction('routeScreen',async message=>{const target=role==='host'?'viewer':'host';if(pages[target])await pages[target].evaluate(m=>window.diag?.shareRef.current.handleSignal(m),message);return 'ok';});
  await page.addInitScript(()=>{
   const state=window.diag={peers:[],videos:[],callbacks:0,renders:0,fullRenders:0,errors:[],encodings:[]};
   const Peer=window.RTCPeerConnection;
   window.RTCPeerConnection=class extends Peer{constructor(){super({iceServers:[]});state.peers.push(this);}};
   const nativeSet=RTCRtpSender.prototype.setParameters;
   RTCRtpSender.prototype.setParameters=async function(p){const entry={time:performance.now(),wanted:p.encodings};state.encodings.push(entry);try{const result=await nativeSet.call(this,p);entry.actual=this.getParameters().encodings;return result;}catch(e){entry.error=e.message;throw e;}};
   const create=document.createElement.bind(document);
   document.createElement=(tag,...args)=>{const result=create(tag,...args);if(tag.toLowerCase()==='video')state.videos.push(result);return result;};
   const callback=HTMLVideoElement.prototype.requestVideoFrameCallback;
   if(callback)HTMLVideoElement.prototype.requestVideoFrameCallback=function(fn){return callback.call(this,(...args)=>{state.callbacks++;return fn(...args);});};
   navigator.mediaDevices.getDisplayMedia=async()=>{
    // Emulate a real capture chooser yielding to the UI before resolving.
    await new Promise(r=>setTimeout(r,100));
    const source=document.createElement('canvas');source.width=1920;source.height=1080;const ctx=source.getContext('2d');let n=0;
    const paint=()=>{ctx.fillStyle=n++%2?'#1466dd':'#dd4422';ctx.fillRect(0,0,1920,1080);ctx.fillStyle='white';ctx.fillRect(n*13%1800,0,80,1080);};
    paint();state.timer=setInterval(paint,1000/60);state.capture=source.captureStream(60);return state.capture;
   };
  });
  await page.goto(base+'scripts/board-media-fixture.html');
  const board=await page.evaluate(async()=>{const {createBoard}=await import('/alex/src/lib/boardRepository.js');return createBoard('Isolated receiver diagnostic');});
  await page.goto(`${base}board/${board.boardId}?key=${board.ownerKey}`);
  await page.getByRole('textbox',{name:'Ваше имя'}).fill('Receiver diagnostic '+role);
  await page.getByRole('button',{name:'Войти на доску',exact:true}).click();
  await page.waitForFunction(()=>document.documentElement.dataset.alexDurableEditState==='ready'&&document.documentElement.dataset.alexDurableEditBlocked!=='true');
  await page.evaluate(()=>{
   let f=document.querySelector('.toolbar-shell');f=f[Object.keys(f).find(k=>k.startsWith('__reactFiber'))];while(f&&f.type?.name!=='BoardWorkspace')f=f.return;
   for(let h=f.memoizedState;h;h=h.next){const v=h.memoizedState?.current;
    if(v?.getObjects&&v?.getZoom)window.diag.canvas=v;
    if(v?.setUltraEnabled&&v?.handleSignal&&v?.start)window.diag.shareRef=h.memoizedState;
    if(v?.sendScreenShareSignal)window.diag.realtime=v;
   }
   const d=window.diag;if(!d.canvas||!d.shareRef||!d.realtime)throw Error('Missing real board screen references');
   d.realtime.sendScreenShareSignal=payload=>window.routeScreen({...payload,clientId:d.shareRef.current.clientId,name:'diagnostic',permission:'owner',timestamp:Date.now()});
   d.canvas.on('before:render',()=>d.fullRenders++);
   d.canvas.on('object:added',({target})=>{if(!target.transientScreenShare)return;d.screen=target;const render=target.render.bind(target);target.render=(...a)=>{d.renders++;return render(...a);};});
   d.sample=async()=>{
    const peers=[];for(const p of d.peers){if(p.connectionState==='closed')continue;const rtp=[...(await p.getStats()).values()].filter(s=>['outbound-rtp','inbound-rtp','media-source'].includes(s.type));if(rtp.length)peers.push({connection:p.connectionState,rtp});}
    const share=d.shareRef.current;return {time:performance.now(),phase:share.phase,ultra:share.ultraEnabled,profile:share.profileId,callbacks:d.callbacks,renders:d.renders,fullRenders:d.fullRenders,hidden:document.hidden,objects:d.canvas.getObjects().length,selected:d.canvas.getActiveObject()?.type,retina:d.canvas.getRetinaScaling(),peers,encodings:d.encodings,video:d.videos.filter(v=>v.srcObject).map(v=>({ready:v.readyState,width:v.videoWidth,height:v.videoHeight,quality:v.getVideoPlaybackQuality?.()}))};
   };
  });
 }
 await pages.host.evaluate(()=>window.diag.shareRef.current.start());
 await pages.viewer.waitForFunction(()=>window.diag.videos.some(v=>v.srcObject&&v.readyState>=2),null,{timeout:25000});
 async function sample(label,ms=3000){
  const before=Object.fromEntries(await Promise.all(Object.entries(pages).map(async([r,p])=>[r,await p.evaluate(()=>window.diag.sample())])));await sleep(ms);
  const after=Object.fromEntries(await Promise.all(Object.entries(pages).map(async([r,p])=>[r,await p.evaluate(()=>window.diag.sample())]))),rates={};
  for(const role of ['host','viewer']){const a=after[role],b=before[role],s=(a.time-b.time)/1000;const stats=(x,type)=>x.peers.flatMap(p=>p.rtp).find(v=>v.type===type&&(v.kind==='video'||v.mediaType==='video'))??{};const type=role==='host'?'outbound-rtp':'inbound-rtp',sa=stats(a,type),sb=stats(b,type);rates[role]={phase:a.phase,ultra:a.ultra,profile:a.profile,callbacks:(a.callbacks-b.callbacks)/s,paintFps:(a.renders-b.renders)/s,fullRenderFps:(a.fullRenders-b.fullRenders)/s,decodedFps:(sa.framesDecoded-sb.framesDecoded)/s,sentFps:(sa.framesSent-sb.framesSent)/s,qualityLimitationReason:sa.qualityLimitationReason,frameWidth:sa.frameWidth,frameHeight:sa.frameHeight,objects:a.objects,selected:a.selected};}
  reports.push({label,rates,before,after});console.log('FULL BOARD',engine,label,JSON.stringify(rates));await writeFile(`receiver-diagnostic-results/${engine}-fullboard.json`,JSON.stringify({engine,reports,errors},null,2));
 }
 await sample('standard-full-board');
 await pages.host.locator('.screen-share-ultra-checkbox').check();await sleep(500);await sample('ultra-full-board');
 await pages.viewer.evaluate(async()=>{const {BoardNotebook}=await import('/alex/src/lib/boardNotebook.js');const {Path}=await import('fabric');const strokes=Array.from({length:300},(_,i)=>{let path=`M ${20+i%20*20} ${20+Math.floor(i/20)*25}`;for(let k=1;k<=30;k++)path+=` L ${20+i%20*20+k*.3} ${20+Math.floor(i/20)*25+Math.sin(k)*7}`;return new Path(path,{stroke:'#202030',strokeWidth:2,fill:null,boardObjectId:'stroke-'+i}).toObject(['boardObjectId']);});const n=await BoardNotebook.fromObject({boardObjectId:'diagnostic-notebook',left:600,top:280,width:520,height:480,notebookPageNumber:20,notebookPages:Array.from({length:20},()=>structuredClone(strokes))});window.diag.book=n;window.diag.canvas.add(n);window.diag.canvas.discardActiveObject();window.diag.canvas.requestRenderAll();});
 await sample('ultra-full-board-notebook');
 await pages.viewer.evaluate(()=>{window.diag.canvas.setActiveObject(window.diag.book);window.diag.canvas.requestRenderAll();});await sample('ultra-notebook-selected');
 await pages.viewer.evaluate(()=>{window.diag.canvas.setActiveObject(window.diag.screen);window.diag.canvas.requestRenderAll();});await sample('ultra-screen-selected');
 await pages.host.locator('.screen-share-720-checkbox').check();await sleep(500);await sample('ultra720-full-board');
}catch(e){errors.push({error:e.stack});console.error(e);process.exitCode=1;}
finally{
 for(const [role,p] of Object.entries(pages)){try{await writeFile(`receiver-diagnostic-results/${engine}-fullboard-${role}-final.json`,JSON.stringify(await p.evaluate(()=>window.diag.sample?.()),null,2));await p.screenshot({path:`receiver-diagnostic-results/${engine}-${role}.png`});}catch{}}
 await writeFile(`receiver-diagnostic-results/${engine}-fullboard.json`,JSON.stringify({engine,reports,errors},null,2));await browser?.close();server.kill();
}
