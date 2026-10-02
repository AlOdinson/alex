// Receiver-only A/B. Rendering probes do not change transport or product files.
import {readFile,writeFile,unlink} from 'node:fs/promises';
let code=await readFile(new URL('./run-empty-receiver-audit.mjs',import.meta.url),'utf8');
function once(a,b){if(code.split(a).length!==2)throw Error('Audit transformer mismatch: '+a.slice(0,80));code=code.replace(a,b);}
once('return fn(now,metadata);','const started=performance.now();try{return fn(now,metadata);}finally{m.workMs=(m.workMs||0)+performance.now()-started;}');
once('quality:v.getVideoPlaybackQuality?.(),track:',"quality:(()=>{const q=v.getVideoPlaybackQuality?.();return q?{totalVideoFrames:q.totalVideoFrames,droppedVideoFrames:q.droppedVideoFrames,creationTime:q.creationTime}:null;})(),track:");
once('p95Gap:v.p95Gap};','p95Gap:v.p95Gap,callbackWorkMs:prev?(v.workMs-prev.workMs)/Math.max(1,v.callbacks-prev.callbacks):null};');
const a=code.indexOf('source=source.slice(0,start)+`'),b=code.indexOf('`+source.slice(end);',a);
if(a<0||b<a)throw Error('Missing scenario slice');
const scenarios=`
 await pages.host.locator('.screen-share-ultra-checkbox').check();await sleep(1500);
 await sample('AB-empty-ultra-current-fast-path',5000);
 await pages.viewer.evaluate(()=>{const c=window.diag.canvas;c.overlayColor='rgba(0,0,0,0)';c.requestRenderAll();});
 await sample('AB-empty-ultra-ordinary-render-transparent-overlay',5000);
 await pages.viewer.evaluate(()=>{const c=window.diag.canvas;c.overlayColor='';c.requestRenderAll();});
 await sample('AB-empty-ultra-current-fast-path-restored',5000);
 await pages.viewer.setViewportSize({width:1920,height:1080});await sleep(500);
 await sample('AB-empty-large-retina-current-fast-path',5000);
 await pages.viewer.evaluate(()=>{const c=window.diag.canvas;c.overlayColor='rgba(0,0,0,0)';c.requestRenderAll();});
 await sample('AB-empty-large-retina-ordinary-render',5000);
 await pages.viewer.evaluate(()=>{const d=window.diag;d.canvas.overlayColor='';d.canvas.requestRenderAll();const tick=()=>{d.heartbeat=requestAnimationFrame(tick);};tick();});
 await sample('AB-empty-large-retina-fast-path-with-raf-heartbeat',5000);
 await pages.viewer.evaluate(()=>cancelAnimationFrame(window.diag.heartbeat));
 await pages.viewer.setViewportSize({width:1200,height:900});await sleep(500);
 await pages.viewer.evaluate(()=>{const d=window.diag,m=d.media(),stream=m.video.srcObject;m.setStream(null);m.video.requestVideoFrameCallback=fn=>setTimeout(()=>fn(performance.now(),{}),500);m.video.cancelVideoFrameCallback=id=>clearTimeout(id);m.setStream(stream);});
 await sleep(1000);await sample('FAULT-INJECTION-receiver-callback-2fps-ultra1080',4000);
 await pages.host.locator('.screen-share-720-checkbox').check();await sleep(1000);await sample('FAULT-INJECTION-receiver-callback-2fps-ultra720',4000);
 await pages.viewer.evaluate(()=>{const m=window.diag.media(),stream=m.video.srcObject;m.setStream(null);m.video.requestVideoFrameCallback=fn=>requestAnimationFrame(t=>fn(t,{}));m.video.cancelVideoFrameCallback=id=>cancelAnimationFrame(id);m.setStream(stream);});
 await sleep(1000);await sample('PROBE-receiver-raf-polling-same-stream-not-unique-frame-fps',4000);
 if(reports.some(r=>r.after.viewer.objects!==1))throw Error('The receiver board is not empty');
`;
code=code.slice(0,a)+'source=source.slice(0,start)+'+JSON.stringify(scenarios)+'+source.slice(end);'+code.slice(b+'`+source.slice(end);'.length);
const generated=new URL('./.empty-receiver-compositor-wrapper.mjs',import.meta.url);await writeFile(generated,code);
// The existing cross-browser loader only modifies the diagnostic bootstrap.
if(process.env.RECEIVER_AUDIT_CROSS==='1'){
 let cross=await readFile(new URL('./run-cross-browser-receiver-audit.mjs',import.meta.url),'utf8');
 cross=cross.replace("import('./run-empty-receiver-audit.mjs')","import('./.empty-receiver-compositor-wrapper.mjs')");
 const path=new URL('./.cross-receiver-compositor-wrapper.mjs',import.meta.url);await writeFile(path,cross);
 try{await import(path.href);}finally{await unlink(path).catch(()=>{});await unlink(generated).catch(()=>{});}
}else{try{await import(generated.href);}finally{await unlink(generated).catch(()=>{});}}
