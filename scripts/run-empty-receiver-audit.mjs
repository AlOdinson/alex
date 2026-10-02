// Diagnostic only. Reuse the real Board/transport bootstrap; create no notebook.
import {readFile,writeFile,unlink} from 'node:fs/promises';
let source=await readFile(new URL('./run-receiver-fullboard-diagnostic.mjs',import.meta.url),'utf8');
const replaceOnce=(needle,replacement)=>{if(source.split(needle).length!==2)throw Error('Diagnostic source changed: '+needle.slice(0,80));source=source.replace(needle,replacement);};
replaceOnce("const paint=()=>{ctx.fillStyle=n++%2?'#1466dd':'#dd4422';ctx.fillRect(0,0,1920,1080);ctx.fillStyle='white';ctx.fillRect(n*13%1800,0,80,1080);};", "const paint=()=>{ctx.fillStyle='#1466dd';ctx.fillRect(0,0,1920,1080);ctx.fillStyle='white';ctx.fillRect(n++*13%1800,0,80,1080);ctx.fillStyle='black';ctx.font='60px sans-serif';ctx.fillText(String(n),40,100);};");
replaceOnce("const callback=HTMLVideoElement.prototype.requestVideoFrameCallback;",`state.videoStats=new WeakMap();
   const metrics=v=>{let m=state.videoStats.get(v);if(!m){m={callbacks:0,registrations:0,copies:0,copyMs:0,copyMaxMs:0,presented:0,callbackGaps:[]};state.videoStats.set(v,m);}return m;};
   state.getVideoMetrics=metrics;
   const draw=CanvasRenderingContext2D.prototype.drawImage;
   CanvasRenderingContext2D.prototype.drawImage=function(v,...a){if(!(v instanceof HTMLVideoElement))return draw.call(this,v,...a);const m=metrics(v),start=performance.now();try{return draw.call(this,v,...a);}finally{const cost=performance.now()-start;m.copies++;m.copyMs+=cost;m.copyMaxMs=Math.max(m.copyMaxMs,cost);}};
   const callback=HTMLVideoElement.prototype.requestVideoFrameCallback;`);
replaceOnce("if(callback)HTMLVideoElement.prototype.requestVideoFrameCallback=function(fn){return callback.call(this,(...args)=>{state.callbacks++;return fn(...args);});};",`if(callback)HTMLVideoElement.prototype.requestVideoFrameCallback=function(fn){const m=metrics(this);m.registrations++;return callback.call(this,(now,metadata)=>{state.callbacks++;m.callbacks++;m.presented=metadata.presentedFrames;if(m.lastAt)m.callbackGaps.push(now-m.lastAt);m.lastAt=now;if(m.callbackGaps.length>500)m.callbackGaps.shift();return fn(now,metadata);});};`);
replaceOnce("d.screen=target;const render=target.render.bind(target);target.render=(...a)=>{d.renders++;return render(...a);};",`d.screen=target;d.renderMs=0;d.renderMaxMs=0;const render=target.render.bind(target);target.render=(...a)=>{d.renders++;const start=performance.now();try{return render(...a);}finally{const cost=performance.now()-start;d.renderMs+=cost;d.renderMaxMs=Math.max(d.renderMaxMs,cost);}};`);
replaceOnce("await pages.host.evaluate(()=>window.diag.shareRef.current.start());",`for(const p of Object.values(pages))await p.evaluate(()=>{
 const d=window.diag,previous=d.sample;
 d.media=()=>{let f=document.querySelector('.toolbar-shell');f=f[Object.keys(f).find(k=>k.startsWith('__reactFiber'))];while(f&&f.type?.name!=='BoardWorkspace')f=f.return;for(let h=f.memoizedState;h;h=h.next){const v=h.memoizedState?.current;if(v?.object?.transientScreenShare&&v.video&&v.setStream)return v;}return null;};
 d.sample=async()=>{const result=await previous();return {...result,renderMs:d.renderMs,renderMaxMs:d.renderMaxMs,transport:d.shareRef.current.transport,canvasPixels:d.canvas.lowerCanvasEl.width*d.canvas.lowerCanvasEl.height,video:d.videos.filter(v=>v.srcObject).map(v=>{const m=d.getVideoMetrics(v),g=[...m.callbackGaps].sort((a,b)=>a-b);return {id:d.videos.indexOf(v),reference:Boolean(v.dataset.auditReference),connected:v.isConnected,paused:v.paused,ready:v.readyState,time:v.currentTime,width:v.videoWidth,height:v.videoHeight,quality:v.getVideoPlaybackQuality?.(),track:v.srcObject.getVideoTracks().map(t=>({id:t.id,enabled:t.enabled,muted:t.muted,ready:t.readyState,settings:t.getSettings()})),...m,callbackGaps:undefined,p95Gap:g[Math.floor(g.length*.95)]};})};};
 });
 await pages.host.evaluate(()=>window.diag.shareRef.current.start());`);
replaceOnce("reports.push({label,rates,before,after});",`for(const role of ['host','viewer']){const a=after[role],b=before[role],sec=(a.time-b.time)/1000;rates[role].transport=a.transport;rates[role].canvasPixels=a.canvasPixels;rates[role].renderMeanMs=(a.renderMs-b.renderMs)/Math.max(1,a.renders-b.renders);rates[role].renderMaxMs=a.renderMaxMs;rates[role].video=a.video.map(v=>{const prev=b.video.find(x=>x.id===v.id);return {id:v.id,reference:v.reference,connected:v.connected,paused:v.paused,ready:v.ready,callbacks:prev?(v.callbacks-prev.callbacks)/sec:null,presented:prev?(v.presented-prev.presented)/sec:null,qualityFrames:prev?(v.quality.totalVideoFrames-prev.quality.totalVideoFrames)/sec:null,copies:prev?(v.copies-prev.copies)/sec:null,copyMeanMs:prev?(v.copyMs-prev.copyMs)/Math.max(1,v.copies-prev.copies):null,p95Gap:v.p95Gap};});}
  reports.push({label,rates,before,after});`);
const start=source.indexOf(" await sample('standard-full-board');"),end=source.indexOf('}catch(e){errors.push',start);
if(start<0||end<0)throw Error('Missing scenario boundary');
source=source.slice(0,start)+` // Every case below has exactly one Fabric object: the received video.
 await sample('empty-standard',4000);
 await pages.host.locator('.screen-share-ultra-checkbox').check();await sleep(1500);await sample('empty-ultra-detached',4000);
 await pages.host.locator('.screen-share-720-checkbox').check();await sleep(1500);await sample('empty-ultra720-detached',4000);
 await pages.viewer.evaluate(async()=>{const d=window.diag,m=d.media();if(!m)throw Error('Missing real media controller');const v=document.createElement('video');v.dataset.auditReference='true';v.muted=true;v.autoplay=true;v.playsInline=true;v.style.cssText='position:fixed;right:10px;top:110px;width:320px;height:180px;z-index:99999;pointer-events:none';v.srcObject=m.video.srcObject;document.body.append(v);await v.play();const tick=()=>v.requestVideoFrameCallback(tick);tick();d.nativeReference=v;});
 await sample('same-stream-native-reference-and-canvas',4000);
 await pages.viewer.evaluate(()=>{const m=window.diag.media();m.video.style.cssText='position:fixed;right:10px;top:310px;width:320px;height:180px;z-index:99999;pointer-events:none';document.body.append(m.video);});
 await sample('original-receiver-video-attached-visible',4000);
 await pages.viewer.evaluate(()=>window.diag.media().video.remove());
 await sample('original-receiver-video-detached-again',4000);
 await pages.viewer.evaluate(()=>{const d=window.diag,m=d.media(),stream=m.video.srcObject;d.savedVideoCallback=m.video.requestVideoFrameCallback;d.savedCancelCallback=m.video.cancelVideoFrameCallback;m.setStream(null);m.video.requestVideoFrameCallback=undefined;m.setStream(stream);});
 await sample('receiver-fallback-timer-ultra720',4000);
 await pages.host.locator('.screen-share-720-checkbox').uncheck();await sleep(1000);await sample('receiver-fallback-timer-ultra1080',4000);
 await pages.viewer.evaluate(()=>{const d=window.diag,m=d.media(),stream=m.video.srcObject;m.setStream(null);m.video.requestVideoFrameCallback=d.savedVideoCallback;m.setStream(stream);d.canvas.setActiveObject(m.object);d.canvas.requestRenderAll();});
 await sample('empty-receiver-video-selected',4000);
 await pages.viewer.evaluate(()=>{window.diag.canvas.discardActiveObject();window.diag.canvas.requestRenderAll();});
 await pages.viewer.setViewportSize({width:1920,height:1080});await sleep(500);await sample('empty-retina-large-viewport',4000);
 await pages.viewer.setViewportSize({width:2560,height:1440});await sleep(500);await sample('empty-retina-above-cache-limit',4000);
 // Fault injection, labelled explicitly: decoded video continues, callback delivery stalls.
 await pages.viewer.setViewportSize({width:1200,height:900});
 await pages.viewer.evaluate(()=>{const d=window.diag,m=d.media(),stream=m.video.srcObject;m.setStream(null);m.video.requestVideoFrameCallback=function(fn){return setTimeout(()=>fn(performance.now(),{}),500);};m.video.cancelVideoFrameCallback=clearTimeout;m.setStream(stream);});
 await sample('INJECTED-receiver-callback-2fps-sender-ultra',4000);
 await pages.host.locator('.screen-share-720-checkbox').check();await sleep(500);await sample('INJECTED-receiver-callback-2fps-sender-720',4000);
 // Diagnostic repair probe only: use receiver rAF rather than stalled callback.
 await pages.viewer.evaluate(()=>{const m=window.diag.media(),stream=m.video.srcObject;m.setStream(null);m.video.requestVideoFrameCallback=fn=>requestAnimationFrame(t=>fn(t,{}));m.video.cancelVideoFrameCallback=cancelAnimationFrame;m.setStream(stream);});
 await sample('PROBE-receiver-animation-frame-same-connection',4000);
 if(reports.some(r=>r.after.viewer.objects!==1))throw Error('Empty-board audit was contaminated by additional Fabric objects');
`+source.slice(end);
source=source.replaceAll('fullboard','emptyboard');
const path=new URL('./.empty-receiver-audit-generated.mjs',import.meta.url);await writeFile(path,source);
try{await import(path.href);}finally{await unlink(path).catch(()=>{});}
